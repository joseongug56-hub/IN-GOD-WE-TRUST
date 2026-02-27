
// services/TranslationService.ts
// Python domain/translation_service.py 의 TypeScript 변환

import { GeminiClient, GeminiContentSafetyException, GenerationConfig } from './GeminiClient';
import { ChunkService } from './ChunkService';
import { EpubChunkService } from './EpubChunkService';
import { TextNodeService, TextNode } from './TextNodeService';
import { ImageAnnotationService } from './ImageAnnotationService';
import { StoryBibleService } from './StoryBibleService'; // [추가] 포맷팅 유틸리티 사용
import JSZip from 'jszip';
import type { 
  GlossaryEntry, 
  TranslationResult, 
  TranslationJobProgress, 
  LogEntry,
  TranslationContext,
  StoryBibleData, // [추가] 타입 임포트
  FileContent
} from '../types/dtos';
import type { AppConfig, PrefillHistoryItem } from '../types/config';
import type { EpubNode, EpubChapter } from '../types/epub';

/**
 * 번역 진행 콜백 타입
 */
export type ProgressCallback = (progress: TranslationJobProgress) => void;

/**
 * 로그 콜백 타입
 */
export type LogCallback = (entry: LogEntry) => void;

/**
 * 용어집 항목을 프롬프트 형식으로 포맷팅
 */
function formatGlossaryForPrompt(
  glossaryEntries: GlossaryEntry[],
  chunkText: string,
  maxEntries: number = 30,
  maxChars: number = 2000
): string {
  if (!glossaryEntries.length) {
    return '용어집 컨텍스트 없음';
  }

  const chunkLower = chunkText.toLowerCase();

  // 현재 청크에 등장하는 용어만 필터링 + 등장 횟수 순 정렬
  const relevantEntries = glossaryEntries
    .filter(e => chunkLower.includes(e.keyword.toLowerCase()))
    .sort((a, b) => b.occurrenceCount - a.occurrenceCount);

  const selected: string[] = [];
  let currentChars = 0;

  for (const entry of relevantEntries) {
    if (selected.length >= maxEntries) break;

    const entryStr = `- ${entry.keyword} → ${entry.translatedKeyword} (${entry.targetLanguage})`;
    
    // 최대 글자 수 초과 시 중단 (단, 최소 1개는 포함)
    if (currentChars + entryStr.length > maxChars && selected.length > 0) break;

    selected.push(entryStr);
    currentChars += entryStr.length + 1;
  }

  return selected.length ? selected.join('\n') : '용어집 컨텍스트 없음';
}

/**
 * 번역 서비스 클래스
 */
export class TranslationService {
  private geminiClient: GeminiClient;
  private chunkService: ChunkService;
  private textNodeService: TextNodeService;
  private config: AppConfig;
  private apiKey?: string;
  private stopRequested: boolean = false;
  private onLog?: LogCallback;
  
  // 병렬 요청 취소를 위한 컨트롤러 집합
  private cancelControllers: Set<() => void> = new Set();
  constructor(config: AppConfig, apiKey?: string) {
    this.config = config;
    this.apiKey = apiKey;
    this.geminiClient = new GeminiClient(apiKey, config.requestsPerMinute);
    this.chunkService = new ChunkService(config.chunkSize);
    this.textNodeService = new TextNodeService();
  }

  /**
   * 로그 콜백 설정
   */
  setLogCallback(callback: LogCallback): void {
    this.onLog = callback;
  }

  /**
   * 로그 출력
   */
  private log(level: LogEntry['level'], message: string): void {
    const entry: LogEntry = { level, message, timestamp: new Date() };
    console.log(`[${level.toUpperCase()}] ${message}`);
    this.onLog?.(entry);
  }

  /**
   * 설정 업데이트
   */
  updateConfig(config: Partial<AppConfig>): void {
    this.config = { ...this.config, ...config };
    
    if (config.requestsPerMinute !== undefined) {
      this.geminiClient.setRequestsPerMinute(config.requestsPerMinute);
    }
  }

  /**
   * 번역 중단 요청
   */
  requestStop(): void {
    this.stopRequested = true;
    this.log('warning', '번역 중단이 요청되었습니다.');
    
    // 현재 진행 중인 모든 요청 취소
    this.cancelControllers.forEach(cancel => cancel());
    this.cancelControllers.clear();
  }

  /**
   * 중단 상태 리셋
   */
  resetStop(): void {
    this.stopRequested = false;
    this.cancelControllers.clear();
  }

  /**
   * 프롬프트 및 컨텍스트 준비 (스토리 바이블 주입 로직 추가됨)
   * [Stateless] 인스턴스 변수가 아닌 명시적으로 전달된 데이터를 사용합니다.
   * [UPDATE] previousContext 파라미터 및 isTranslatedContext 플래그 추가
   */
  private preparePromptAndContext(
    chunkText: string, 
    chunkIndex: number, 
    glossaryEntries: GlossaryEntry[],
    storyBible?: StoryBibleData,
    previousContext?: string, // 이전 문맥 텍스트
    isTranslatedContext: boolean = false // [NEW] 문맥이 번역문인지 여부
  ): { prompt: string, glossaryContext: string, storyBibleContext: string } {
    let prompt = this.config.prompts;
    let glossaryContext = '용어집 컨텍스트 없음';

    // 1. 용어집 컨텍스트 생성
    if (this.config.enableDynamicGlossaryInjection) {
      glossaryContext = formatGlossaryForPrompt(
        glossaryEntries,
        chunkText,
        this.config.maxGlossaryEntriesPerChunkInjection,
        this.config.maxGlossaryCharsPerChunkInjection
      );

      // 용어집 로깅 (컨텍스트가 생성된 경우)
      if (glossaryContext !== '용어집 컨텍스트 없음') {
        const entries = glossaryContext.split('\n');
        const entryCount = entries.length;
        this.log('info', `청크 ${chunkIndex + 1}: 동적 용어집 ${entryCount}개 항목이 준비되었습니다.`);
      }
    }

    // 2. 스토리 바이블 컨텍스트 생성 [NEW] - 필터링 적용
    let storyBibleContext = '배경 정보 없음';
    if (this.config.enableStoryBibleInjection && storyBible) {
      storyBibleContext = this.formatStoryBibleWithFiltering(storyBible, chunkText, chunkIndex);
    }

    // 3. 슬라이딩 문맥 (이전 내용) 주입 [Adaptive Logic]
    let prevContextSection = '';
    if (this.config.enableSlidingWindow && previousContext && previousContext.trim().length > 0) {
      if (isTranslatedContext) {
        // 문맥이 '번역문(한국어)'인 경우
        prevContextSection = `
[이전 번역문 (스타일/어조 참조용)]
다음 텍스트는 직전 구간의 **번역 결과(한국어)**입니다. 투입되는 원문의 번역이 자연스럽게 이어지도록 문체와 어조를 참고하세요. 절대 번역 결과에 포함하지 마세요.
"""
${previousContext}
"""`.trim();
        this.log('debug', `청크 ${chunkIndex + 1}: 이전 번역문 문맥(${previousContext.length}자) 주입됨.`);
      } else {
        // 문맥이 '원문'인 경우
        prevContextSection = `
[이전 원문 (문맥 참조용)]
다음 텍스트는 직전 구간의 **원문**입니다. 문맥, 대명사 지칭 대상, 문체 연결성을 파악하는 용도로만 참고하고 절대 번역 결과에 포함하지 마세요.
"""
${previousContext}
"""`.trim();
        this.log('debug', `청크 ${chunkIndex + 1}: 이전 원문 문맥(${previousContext.length}자) 주입됨.`);
      }
    }

    // 4. 프롬프트 내 치환
    if (prompt.includes('{{glossary_context}}')) {
      prompt = prompt.replace('{{glossary_context}}', glossaryContext);
    }
    
    if (prompt.includes('{{story_bible}}')) {
      prompt = prompt.replace('{{story_bible}}', storyBibleContext);
    }

    // [NEW] 이전 문맥 섹션 치환 (또는 없으면 빈 문자열)
    if (prompt.includes('{{previous_context_section}}')) {
      prompt = prompt.replace('{{previous_context_section}}', prevContextSection);
    } else if (prevContextSection) {
      // 플레이스홀더가 없는데 기능이 켜져있으면 번역할 원문 앞에 삽입
      prompt = prompt.replace('{{slot}}', `${prevContextSection}\n\n{{slot}}`);
    }
    
    prompt = prompt.replace('{{slot}}', chunkText);

    return { prompt, glossaryContext, storyBibleContext };
  }

  /**
   * 스토리 바이블 필터링 및 포맷팅
   */
  private formatStoryBibleWithFiltering(
    storyBible: StoryBibleData,
    chunkText: string,
    chunkIndex: number
  ): string {
    const chunkLower = chunkText.toLowerCase();
    
    // 1. 등장인물 필터링: 청크 텍스트에 이름이 포함된 활성 인물만 선택
    const activeCharacters = storyBible.characters.filter(char => {
      if (!char.isActive) return false;
      return chunkLower.includes(char.name.toLowerCase());
    });

    if (activeCharacters.length > 0) {
      const names = activeCharacters.map(c => c.name).join(', ');
      this.log('info', `청크 ${chunkIndex + 1}: 등장인물 ${activeCharacters.length}명 감지됨 (${names})`);
    }

    // 2. 세계관 등 기타 설정: 활성 상태인 항목 모두 포함
    const activeWorld = storyBible.worldSettings.filter(w => w.isActive);

    const charStr = activeCharacters
      .map(c => `### ${c.name} (${c.role})\n- 성격: ${c.personality}\n- 말투: ${c.speakingStyle}\n- 관계: ${c.relationships}\n- 비고: ${c.notes}`)
      .join('\n\n');

    const worldStr = activeWorld
      .map(w => `### [${w.category}] ${w.title}\n${w.content}`)
      .join('\n\n');

    return `
[등장인물 설정 (현재 구간 등장인물)]
${charStr || '감지된 등장인물 없음'}

[세계관 및 고유 설정]
${worldStr || '정보 없음'}

[줄거리 요약]
${storyBible.plotSummary || '정보 없음'}

[스타일 가이드]
${storyBible.styleGuide || '정보 없음'}
`.trim();
  }

  /**
   * 번역 결과 후처리 메서드 (Smart Filter Version)
   */
  private postProcess(text: string): string {
    if (!text) return text;

    if (this.config.enablePostProcessing) {
      text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
      text = text.replace(/<[a-zA-Z0-9\/\s"='-]+>/g, '');
    }

    return text.trim();
  }

  /**
   * 연속된 동일 역할의 히스토리를 하나로 병합합니다.
   */
  private mergeConsecutiveRoles(history: { role: 'user' | 'model'; content: string }[]) {
    if (history.length === 0) return [];

    const merged: { role: 'user' | 'model'; content: string }[] = [];
    let current = { ...history[0] };

    for (let i = 1; i < history.length; i++) {
      const next = history[i];
      if (current.role === next.role) {
        current.content += `\n\n${next.content}`;
      } else {
        merged.push(current);
        current = { ...next };
      }
    }
    merged.push(current);
    
    return merged;
  }

  /**
   * 단일 청크 번역
   * [UPDATE] previousContext 파라미터 및 isTranslatedContext 플래그 추가
   */
  async translateChunk(
    chunkText: string, 
    chunkIndex: number, 
    context: TranslationContext,
    enableSafetyRetry: boolean = true,
    previousContext?: string,
    isTranslatedContext: boolean = false // [NEW] Flag
  ): Promise<TranslationResult> {
    if (!chunkText.trim()) {
      return {
        chunkIndex,
        originalText: chunkText,
        translatedText: '',
        success: true,
      };
    }

    // [수정] preparePromptAndContext에 플래그 전달
    const { prompt, glossaryContext, storyBibleContext } = this.preparePromptAndContext(
      chunkText, 
      chunkIndex, 
      context.glossaryEntries, 
      context.storyBible,
      previousContext,
      isTranslatedContext
    );
    
    const textPreview = chunkText.slice(0, 100).replace(/\n/g, ' ');
    this.log('info', `청크 ${chunkIndex + 1} 번역 시작 (모델: ${this.config.modelName}): "${textPreview}..."`);

    const generationConfig: GenerationConfig = {
      temperature: this.config.temperature,
      topP: this.config.topP,
    };

    let cancelThisRequest: (() => void) | undefined;
    const cancelPromise = new Promise<string>((_, reject) => {
      cancelThisRequest = () => {
        reject(new Error('CANCELLED_BY_USER'));
      };
    });

    if (cancelThisRequest) {
      this.cancelControllers.add(cancelThisRequest);
    }

    try {
      let apiPromise: Promise<string>;

      if (this.config.enablePrefillTranslation) {
        const rawHistory = this.config.prefillCachedHistory.map(item => ({
          role: item.role,
          content: item.parts.join('\n'),
        }));
        
        const chatHistory = this.mergeConsecutiveRoles(rawHistory);

        const substitutionData = {
          '{{slot}}': chunkText,
          '{{glossary_context}}': glossaryContext,
          '{{story_bible}}': storyBibleContext,
          // [NEW]
          '{{previous_context_section}}': prompt.includes('[이전 ') ? 
            prompt.substring(prompt.indexOf('[이전 '), prompt.indexOf('"""\n\n') + 5) : '' 
        };

        apiPromise = this.geminiClient.generateWithChat(
          prompt,
          this.config.prefillSystemInstruction,
          chatHistory,
          this.config.modelName,
          {
            ...generationConfig,
            substitutionData
          }
        );
      } else {
        apiPromise = this.geminiClient.generateText(
          prompt,
          this.config.modelName,
          undefined,
          generationConfig
        );
      }

      const rawTranslatedText = await Promise.race([apiPromise, cancelPromise]);
      const translatedText = this.postProcess(rawTranslatedText);

      if (!translatedText && chunkText.trim()) {
        throw new Error('API 응답이 비어있습니다 (후처리 후 0자).');
      }
      
      this.log('info', `청크 ${chunkIndex + 1} 번역 완료 (${translatedText.length}자)`);

      return {
        chunkIndex,
        originalText: chunkText,
        translatedText,
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (GeminiClient.isRateLimitError(error as Error)) {
        this.log('error', `API 할당량 초과(429) 감지. 번역 작업을 중단합니다.`);
        this.requestStop();
        
        return {
          chunkIndex,
          originalText: chunkText,
          translatedText: '',
          success: false,
          error: 'API 할당량 초과(429)로 인한 자동 중단',
        };
      }

      if (errorMessage === 'CANCELLED_BY_USER') {
        this.log('warning', `청크 ${chunkIndex + 1} 번역 중단됨 (사용자 요청)`);
        return {
          chunkIndex,
          originalText: chunkText,
          translatedText: '',
          success: false,
          error: '사용자 중단',
        };
      }

      this.log('error', `청크 ${chunkIndex + 1} 번역 실패: ${errorMessage}`);

      const isContentSafety = GeminiClient.isContentSafetyError(error as Error);
      const isEmptyResponse = errorMessage.includes('API 응답이 비어있습니다');

      if (enableSafetyRetry && this.config.useContentSafetyRetry && (isContentSafety || isEmptyResponse)) {
        this.log('warning', isContentSafety ? `콘텐츠 안전 오류 감지. 분할 재시도 시작...` : `빈 응답 오류 감지. 분할 재시도 시작...`);
        return this.retryWithSmallerChunks(chunkText, chunkIndex, context, 1);
      }

      return {
        chunkIndex,
        originalText: chunkText,
        translatedText: '',
        success: false,
        error: errorMessage,
      };
    } finally {
      if (cancelThisRequest) {
        this.cancelControllers.delete(cancelThisRequest);
      }
    }
  }

  /**
   * 작은 청크로 분할하여 재시도 (개선된 하이브리드 로직)
   */
  private async retryWithSmallerChunks(
    chunkText: string,
    originalIndex: number,
    context: TranslationContext,
    currentAttempt: number = 1
  ): Promise<TranslationResult> {
    if (currentAttempt > this.config.maxRetryAttempts) {
      this.log('error', `최대 분할 시도 횟수(${this.config.maxRetryAttempts}) 도달. 번역 실패.`);
      return {
        chunkIndex: originalIndex,
        originalText: chunkText,
        translatedText: `[번역 오류로 인한 실패: 최대 분할 시도 초과]`,
        success: false,
        error: '콘텐츠 안전 문제로 인한 최대 분할 시도 초과',
      };
    }

    if (chunkText.trim().length <= this.config.minContentSafetyChunkSize) {
      const preview = chunkText.slice(0, 50).replace(/\n/g, ' ');
      this.log('warning', `최소 청크 크기에 도달했지만 여전히 오류 발생: ${preview}...`);
      return {
        chunkIndex: originalIndex,
        originalText: chunkText,
        translatedText: `[번역 오류로 인한 실패: ${chunkText.slice(0, 30)}...]`,
        success: false,
        error: '최소 청크 크기에서도 번역 실패',
      };
    }

    this.log('info', `📊 청크 분할 시도 #${currentAttempt} (깊이: ${currentAttempt - 1})`);

    let subChunks = this.chunkService.splitChunkRecursively(
      chunkText,
      Math.floor(chunkText.length / 2),
      this.config.minContentSafetyChunkSize,
      1,
      0
    );

    if (subChunks.length <= 1) {
      subChunks = this.chunkService.splitChunkBySentences(chunkText, 1);
    }

    if (subChunks.length <= 1) {
      const halfLength = Math.ceil(chunkText.length / 2);
      subChunks = [chunkText.slice(0, halfLength), chunkText.slice(halfLength)];
    }
    
    if (subChunks.length <= 1) {
        this.log('error', "청크 분할 실패. 번역 포기.");
        return {
            chunkIndex: originalIndex,
            originalText: chunkText,
            translatedText: `[분할 불가능한 오류 발생 콘텐츠: ${chunkText}...]`,
            success: false,
            error: '분할 불가능',
        };
    }

    this.log('info', `🔄 분할 완료: ${subChunks.length}개 서브 청크 생성`);

    const translatedParts: string[] = [];

    for (let i = 0; i < subChunks.length; i++) {
      if (this.stopRequested) {
        translatedParts.push('[중단됨]');
        break;
      }

      try {
        const result = await this.translateChunk(subChunks[i], originalIndex, context, false);
        
        if (this.stopRequested) {
            translatedParts.push('[중단됨]');
            break;
        }

        if (result.success) {
          translatedParts.push(result.translatedText);
        } else {
          this.log('info', `서브 청크 ${i+1}/${subChunks.length} 실패. 재귀 분할 진입.`);
          const retryResult = await this.retryWithSmallerChunks(
            subChunks[i],
            originalIndex,
            context,
            currentAttempt + 1
          );
          translatedParts.push(retryResult.translatedText);
        }
      } catch (error) {
        this.log('error', `서브 청크 처리 중 예외 발생. 재귀 분할 시도.`);
        const retryResult = await this.retryWithSmallerChunks(
          subChunks[i],
          originalIndex,
          context,
          currentAttempt + 1
        );
        translatedParts.push(retryResult.translatedText);
      }
    }

    return {
      chunkIndex: originalIndex,
      originalText: chunkText,
      translatedText: translatedParts.join('\n'),
      success: true,
    };
  }
  
  /**
   * 전체 텍스트 번역 (병렬 처리 적용)
   * [수정] FileContent[] 입력을 받아 파일 경계를 인식하고 문맥을 리셋합니다.
   * [수정] Max Workers == 1일 때 Adaptive Context (번역문 사용) 로직 적용
   */
  async translateText(
    input: string | FileContent[], // [변경] 입력 타입 확장
    context: TranslationContext,
    onProgress?: ProgressCallback,
    existingResults?: TranslationResult[],
    onResult?: (result: TranslationResult) => void
  ): Promise<TranslationResult[]> {
    this.resetStop();

    // 청크 분할 (단일 텍스트 또는 파일 배열 처리)
    let chunks: { text: string; fileIndex: number }[];
    
    if (Array.isArray(input)) {
        // 파일 배열인 경우: 파일별로 청크를 나누고 인덱스 태깅
        chunks = this.chunkService.createChunksFromFiles(input, this.config.chunkSize);
    } else {
        // 단일 문자열인 경우: 기존 방식대로 나누고 인덱스는 0으로 통일
        chunks = this.chunkService.splitTextIntoChunks(input, this.config.chunkSize)
            .map(text => ({ text, fileIndex: 0 }));
    }
    
    this.log('info', `총 ${chunks.length}개 청크로 분할됨 (파일 경계 인식 활성화)`);

    // 기존 결과 맵핑
    const existingMap = new Map<number, TranslationResult>();
    if (existingResults) {
      for (const res of existingResults) {
        if (res.success) {
          existingMap.set(res.chunkIndex, res);
        }
      }
      if (existingMap.size > 0) {
        this.log('info', `${existingMap.size}개의 기존 번역 결과를 발견했습니다. 스킵합니다.`);
      }
    }

    const results: TranslationResult[] = [];
    const maxWorkers = this.config.maxWorkers || 1;
    const startTime = Date.now();

    const progress: TranslationJobProgress = {
      totalChunks: chunks.length,
      processedChunks: 0,
      successfulChunks: 0,
      failedChunks: 0,
      currentStatusMessage: '번역 시작...',
      etaSeconds: 0,
    };

    onProgress?.(progress);
    
    const processingPromises = new Set<Promise<void>>();

    // Adaptive Context Logic
    // maxWorkers가 1일 때는 순차 처리이므로 직전 번역 결과를 기다려서 활용 가능
    for (let i = 0; i < chunks.length; i++) {
      if (this.stopRequested) {
        this.log('warning', '번역이 사용자에 의해 중단되었습니다.');
        break;
      }

      const chunkData = chunks[i];

      if (existingMap.has(i)) {
        const existingResult = existingMap.get(i)!;
        
        if (existingResult.originalText.length === chunkData.text.length) {
          results.push(existingResult);
          onResult?.(existingResult);

          progress.processedChunks++;
          progress.successfulChunks++;
          
          // 기존 결과가 있으면 그 결과를 기반으로 ETA 계산 업데이트
          const now = Date.now();
          const elapsedSeconds = (now - startTime) / 1000;
          if (progress.processedChunks > 0) {
            const avgTimePerChunk = elapsedSeconds / progress.processedChunks;
            const remainingChunks = progress.totalChunks - progress.processedChunks;
            progress.etaSeconds = Math.ceil(avgTimePerChunk * remainingChunks);
          }
          
          onProgress?.(progress);
          continue;
        } else {
          this.log('warning', `청크 ${i + 1}의 기존 결과가 있으나 원문 길이가 일치하지 않아 재번역합니다.`);
        }
      }

      const task = (async () => {
        if (this.stopRequested) return;

        progress.currentStatusMessage = `청크 ${i + 1}/${chunks.length} 처리 중...`;
        progress.currentChunkProcessing = i;
        onProgress?.(progress);

        try {
          // [Adaptive Context Logic]
          let prevContext: string | undefined;
          let isTranslatedContext = false; // 기본값: 원문 참조 (병렬 처리를 위해)
          
          if (i > 0 && this.config.enableSlidingWindow) {
             const prevChunkData = chunks[i - 1];
             
             // [핵심 1] 파일 경계에서는 문맥 초기화
             if (chunkData.fileIndex !== prevChunkData.fileIndex) {
                 prevContext = undefined;
                 this.log('debug', `청크 ${i + 1}: 새로운 파일 시작 (Index ${chunkData.fileIndex}). 문맥을 리셋합니다.`);
             } else {
                 // [핵심 2] 순차 번역(Worker=1)인 경우 번역문 사용 시도
                 if (maxWorkers === 1) {
                     // results 배열에서 i-1 인덱스의 결과를 찾음 (순차 처리이므로 존재해야 함)
                     const prevResult = results.find(r => r.chunkIndex === i - 1);
                     if (prevResult && prevResult.success) {
                         prevContext = prevResult.translatedText;
                         isTranslatedContext = true; // 번역문 사용 플래그 ON
                     } else {
                         // 앞 청크가 실패했거나 없으면 원문 사용
                         prevContext = prevChunkData.text;
                         isTranslatedContext = false;
                     }
                 } else {
                     // 병렬 처리인 경우: 속도를 위해 원문 사용
                     prevContext = prevChunkData.text;
                     isTranslatedContext = false;
                 }

                 // 문맥 길이 자르기
                 if (prevContext) {
                     const windowSize = this.config.slidingWindowSize || 600;
                     prevContext = prevContext.length > windowSize 
                       ? prevContext.slice(-windowSize) 
                       : prevContext;
                 }
             }
          }

          // 플래그와 함께 translateChunk 호출
          const result = await this.translateChunk(
              chunkData.text, 
              i, 
              context, 
              true, 
              prevContext, 
              isTranslatedContext
          );
          
          if (this.stopRequested) return;

          results.push(result);
          onResult?.(result);

          progress.processedChunks++;
          if (result.success) {
            progress.successfulChunks++;
          } else {
            progress.failedChunks++;
            progress.lastErrorMessage = result.error;
          }
          
          const now = Date.now();
          const elapsedSeconds = (now - startTime) / 1000;
          if (progress.processedChunks > 0) {
            const avgTimePerChunk = elapsedSeconds / progress.processedChunks;
            const remainingChunks = progress.totalChunks - progress.processedChunks;
            progress.etaSeconds = Math.ceil(avgTimePerChunk * remainingChunks);
          }

          onProgress?.(progress);
        } catch (err) {
            this.log('error', `Task ${i+1} unhandled error: ${err}`);
        }
      })();

      processingPromises.add(task);
      task.then(() => processingPromises.delete(task));

      if (processingPromises.size >= maxWorkers) {
        await Promise.race(processingPromises);
      }
    }

    await Promise.all(processingPromises);

    progress.currentStatusMessage = this.stopRequested ? '번역 중단됨' : '번역 완료';
    progress.currentChunkProcessing = undefined;
    progress.etaSeconds = 0;
    onProgress?.(progress);

    this.log('info', `번역 완료: 성공 ${progress.successfulChunks}, 실패 ${progress.failedChunks}`);

    return results.sort((a, b) => a.chunkIndex - b.chunkIndex);
  }

  static combineResults(results: TranslationResult[]): string {
    return results
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .map(r => r.translatedText)
      .join('');
  }

  // translateTextWithIntegrityGuarantee는 기존 로직 유지 (슬라이딩 윈도우 미적용)
  async translateTextWithIntegrityGuarantee(
    fullText: string,
    context: TranslationContext,
    onProgress?: ProgressCallback,
    onResult?: (result: TranslationResult) => void
  ): Promise<{ text: string; results: TranslationResult[] }> {
    // ... (기존 로직 유지)
    this.resetStop();

    const { nodes, originalLines } = this.textNodeService.parse(fullText);

    if (nodes.length === 0) {
      this.log('info', '번역할 텍스트가 없습니다. (모든 줄이 비어 있음)');
      return { text: originalLines.join('\n'), results: [] };
    }

    const epubChunkService = new EpubChunkService(
      this.config.chunkSize,
      this.config.epubMaxNodesPerChunk
    );
    const chunks = epubChunkService.splitEpubNodesIntoChunks(nodes);

    const progress: TranslationJobProgress = {
      totalChunks: chunks.length,
      processedChunks: 0,
      successfulChunks: 0,
      failedChunks: 0,
      currentStatusMessage: '무결성 번역 시작...',
      etaSeconds: 0,
    };

    onProgress?.(progress);

    const maxWorkers = this.config.maxWorkers || 1;
    const processingPromises = new Set<Promise<void>>();
    const translatedNodes: TextNode[] = [];
    const chunkResults: TranslationResult[] = [];
    const startTime = Date.now();

    const processChunk = (chunk: EpubNode[], chunkIndex: number) => async () => {
      if (this.stopRequested) return;

      progress.currentStatusMessage = `무결성 번역 ${chunkIndex + 1}/${chunks.length} 처리 중...`;
      progress.currentChunkProcessing = chunkIndex;
      onProgress?.(progress);

      let success = false;
      let translatedChunk: EpubNode[] = chunk;
      let lastError: string | undefined;

      try {
        // 무결성 모드는 Sliding Window 미적용
        translatedChunk = await this.translateEpubChunk(chunk, context, 1, chunkIndex);
        success = true;
      } catch (error) {
        lastError = (error as Error)?.message;
        this.log('error', `무결성 번역 청크 ${chunkIndex + 1} 실패: ${error}`);
      }

      translatedChunk.forEach((n) => translatedNodes.push(n as TextNode));

      progress.processedChunks++;
      if (success) {
        progress.successfulChunks++;
      } else {
        progress.failedChunks++;
        progress.lastErrorMessage = lastError;
      }

      const now = Date.now();
      const elapsedSeconds = (now - startTime) / 1000;
      if (progress.processedChunks > 0) {
        const avgTimePerChunk = elapsedSeconds / progress.processedChunks;
        const remaining = progress.totalChunks - progress.processedChunks;
        progress.etaSeconds = Math.ceil(avgTimePerChunk * remaining);
      }

      onProgress?.(progress);

      if (onResult) {
        const originalText = chunk.map((n) => n.content ?? '').join('\n');
        const translatedText = translatedChunk.map((n) => n.content ?? '').join('\n');
        onResult({
          chunkIndex,
          originalText,
          translatedText,
          translatedSegments: translatedChunk.map((n) => n.content ?? ''),
          success,
          error: lastError,
        });
      }

      chunkResults.push({
        chunkIndex,
        originalText: chunk.map((n) => n.content ?? '').join('\n'),
        translatedText: translatedChunk.map((n) => n.content ?? '').join('\n'),
        translatedSegments: translatedChunk.map((n) => n.content ?? ''),
        success,
        error: lastError,
      });
    };

    for (let i = 0; i < chunks.length; i++) {
      if (this.stopRequested) break;

      const task = processChunk(chunks[i], i)();
      processingPromises.add(task);
      task.then(() => processingPromises.delete(task));

      if (processingPromises.size >= maxWorkers) {
        await Promise.race(processingPromises);
      }
    }

    await Promise.all(processingPromises);

    progress.currentStatusMessage = this.stopRequested ? '무결성 번역 중단됨' : '무결성 번역 완료';
    progress.currentChunkProcessing = undefined;
    progress.etaSeconds = 0;
    onProgress?.(progress);

    const reconstructed = this.textNodeService.reconstruct(
      translatedNodes.sort((a, b) => a.lineIndex - b.lineIndex),
      originalLines
    );

    return { text: reconstructed, results: chunkResults.sort((a, b) => a.chunkIndex - b.chunkIndex) };
  }

  // [수정] 재시도 로직 개선 (Adaptive Context 적용)
  async retryFailedChunks(
    results: TranslationResult[],
    context: TranslationContext,
    onProgress?: ProgressCallback,
    onResult?: (result: TranslationResult) => void
  ): Promise<TranslationResult[]> {
    const failedResults = results.filter(r => !r.success);
    
    if (failedResults.length === 0) {
      this.log('info', '재시도할 실패한 청크가 없습니다.');
      return results;
    }

    this.log('info', `${failedResults.length}개 실패 청크 재번역 시작`);
    this.resetStop();

    const progress: TranslationJobProgress = {
      totalChunks: failedResults.length,
      processedChunks: 0,
      successfulChunks: 0,
      failedChunks: 0,
      currentStatusMessage: '실패 청크 재번역 시작...',
      etaSeconds: 0,
    };

    onProgress?.(progress);

    const updatedResults = [...results];
    const maxWorkers = this.config.maxWorkers || 1;
    const processingPromises = new Set<Promise<void>>();
    const startTime = Date.now(); 

    for (const failedResult of failedResults) {
      if (this.stopRequested) break;

      const task = (async () => {
        if (this.stopRequested) return;

        progress.currentStatusMessage = `청크 ${failedResult.chunkIndex + 1} 재번역 중...`;
        progress.currentChunkProcessing = failedResult.chunkIndex;
        onProgress?.(progress);

        // [Adaptive Context for Retry]
        let prevContext: string | undefined;
        let isTranslatedContext = false;

        if (this.config.enableSlidingWindow && failedResult.chunkIndex > 0) {
            // 전체 결과 배열에서 바로 앞 순서(N-1)의 결과를 찾음
            const prevResult = results.find(r => r.chunkIndex === failedResult.chunkIndex - 1);
            
            if (prevResult) {
                const windowSize = this.config.slidingWindowSize || 600;
                
                // 앞 청크가 성공했으면 '번역문'을, 실패했으면 '원문'을 문맥으로 사용
                if (prevResult.success) {
                    prevContext = prevResult.translatedText;
                    isTranslatedContext = true; // 번역문임
                } else {
                    prevContext = prevResult.originalText;
                    isTranslatedContext = false; // 원문임
                    this.log('debug', `청크 ${failedResult.chunkIndex + 1} 재번역: 앞 청크 실패로 인해 원문을 문맥으로 사용합니다.`);
                }
                
                if (prevContext && prevContext.length > windowSize) {
                    prevContext = prevContext.slice(-windowSize);
                }
            }
        }

        // 플래그 전달
        const newResult = await this.translateChunk(
          failedResult.originalText,
          failedResult.chunkIndex,
          context,
          true,
          prevContext,
          isTranslatedContext
        );

        if (this.stopRequested) return;

        const index = updatedResults.findIndex(r => r.chunkIndex === failedResult.chunkIndex);
        if (index >= 0) {
          updatedResults[index] = newResult;
        }

        onResult?.(newResult);

        progress.processedChunks++;
        if (newResult.success) {
          progress.successfulChunks++;
        } else {
          progress.failedChunks++;
          progress.lastErrorMessage = newResult.error;
        }

        const now = Date.now();
        const elapsedSeconds = (now - startTime) / 1000;
        if (progress.processedChunks > 0) {
          const avgTimePerChunk = elapsedSeconds / progress.processedChunks;
          const remainingChunks = progress.totalChunks - progress.processedChunks;
          progress.etaSeconds = Math.ceil(avgTimePerChunk * remainingChunks);
        }

        onProgress?.(progress);
      })();

      processingPromises.add(task);
      task.then(() => processingPromises.delete(task));

      if (processingPromises.size >= maxWorkers) {
        await Promise.race(processingPromises);
      }
    }

    await Promise.all(processingPromises);

    progress.currentStatusMessage = '재번역 완료';
    progress.currentChunkProcessing = undefined;
    progress.etaSeconds = 0;
    onProgress?.(progress);

    return updatedResults.sort((a, b) => a.chunkIndex - b.chunkIndex);
  }

  // retryFailedIntegrityChunks, retryFailedEpubChunks 생략 (기존 로직 사용)
  async retryFailedIntegrityChunks(
    results: TranslationResult[],
    fullText: string,
    context: TranslationContext,
    onProgress?: ProgressCallback,
    onResult?: (result: TranslationResult) => void
  ): Promise<{ text: string; results: TranslationResult[] }> {
      return this.translateTextWithIntegrityGuarantee(fullText, context, onProgress, onResult);
  }

  async retryFailedEpubChunks(
    results: TranslationResult[],
    allNodes: EpubNode[],
    context: TranslationContext,
    onProgress?: ProgressCallback,
    onResult?: (result: TranslationResult) => void
  ): Promise<TranslationResult[]> {
      return this.retryFailedChunks(results, context, onProgress, onResult);
  }

  async translateEpubNodes(
    nodes: EpubNode[],
    context: TranslationContext,
    onProgress?: ProgressCallback,
    onResult?: (result: TranslationResult) => void,
    zip?: JSZip,
    existingResults?: TranslationResult[]
  ): Promise<EpubNode[]> {
    this.resetStop();
    this.log('info', `🚀 EPUB 번역 시작: ${nodes.length}개 노드`);

    try {
      const epubChunkService = new EpubChunkService(
        this.config.chunkSize,
        this.config.epubMaxNodesPerChunk
      );

      const chunks = epubChunkService.splitEpubNodesIntoChunks(nodes);
      this.log('info', `📦 ${chunks.length}개 청크로 분할 완료`);

      const existingMap = new Map<number, TranslationResult>();
      if (existingResults) {
        existingResults.forEach(r => {
          if (r.success) existingMap.set(r.chunkIndex, r);
        });
        if (existingMap.size > 0) {
          this.log('info', `🔄 기존 번역 결과 ${existingMap.size}개를 감지했습니다. 스킵을 시도합니다.`);
        }
      }

      const maxWorkers = this.config.maxWorkers || 1;
      const processingPromises = new Set<Promise<void>>();
      const chunkResults = new Map<number, EpubNode[]>();
      const startTime = Date.now();

      let processedChunks = 0;
      let successfulChunks = 0;
      let failedChunks = 0;

      if (onProgress) {
        onProgress({
          totalChunks: chunks.length,
          processedChunks: 0,
          successfulChunks: 0,
          failedChunks: 0,
          currentStatusMessage: 'EPUB 번역 시작...',
          etaSeconds: 0,
        });
      }

      for (let i = 0; i < chunks.length; i++) {
        if (this.stopRequested) {
          this.log('warning', '번역이 사용자에 의해 중단되었습니다.');
          break;
        }

        if (existingMap.has(i)) {
          const existing = existingMap.get(i)!;
          const currentChunkNodes = chunks[i]; 
          const restoredNodes = this.restoreNodesFromResult(currentChunkNodes, existing);

          if (restoredNodes) {
            chunkResults.set(i, restoredNodes);
            processedChunks++;
            successfulChunks++;
            
            this.log('info', `⏩ 청크 ${i + 1} 스킵 (기존 결과 사용)`);

            if (onResult) {
              onResult(existing);
            }
            
            if (onProgress) {
              onProgress({
                totalChunks: chunks.length,
                processedChunks,
                successfulChunks,
                failedChunks,
                currentStatusMessage: `청크 ${i + 1} 복원 완료`,
                etaSeconds: 0,
              });
            }
            continue; 
          } else {
            this.log('warning', `⚠️ 청크 ${i + 1} 복원 실패 (데이터 불일치). 재번역을 진행합니다.`);
          }
        }

        const task = (async () => {
          if (this.stopRequested) return;

          try {
            // [Adaptive Context for EPUB]
            let prevContext: string | undefined;
            let isTranslatedContext = false;

            if (i > 0 && this.config.enableSlidingWindow) {
              // EPUB은 노드 단위라 좀 더 복잡하지만, 로직은 비슷함
              // 만약 maxWorkers=1이면 이전 결과를 쓰고 싶지만, 
              // EPUB 결과 구조(EpubNode[])에서 텍스트를 추출해야 함.
              
              if (maxWorkers === 1 && chunkResults.has(i-1)) {
                  // 순차 처리 시, 직전 번역 완료된 노드들에서 텍스트 추출
                  const prevTranslatedNodes = chunkResults.get(i-1)!;
                  prevContext = prevTranslatedNodes
                    .filter(n => n.type === 'text' && n.content)
                    .map(n => n.content)
                    .join('\n');
                  isTranslatedContext = true;
              } else {
                  // 병렬 처리 시, 원본 노드에서 텍스트 추출
                  const prevChunkNodes = chunks[i - 1];
                  prevContext = prevChunkNodes
                    .filter(n => n.type === 'text' && n.content)
                    .map(n => n.content)
                    .join('\n');
                  isTranslatedContext = false;
              }
              
              if (prevContext) {
                  const windowSize = this.config.slidingWindowSize || 600;
                  if (prevContext.length > windowSize) {
                      prevContext = prevContext.slice(-windowSize);
                  }
              }
            }

            const translated = await this.translateEpubChunk(
              chunks[i],
              context,
              1,
              i,
              prevContext,
              isTranslatedContext // 플래그 전달
            );

            chunkResults.set(i, translated);
            successfulChunks++;
            this.log('info', `✅ 청크 ${i + 1}/${chunks.length} 완료`);

            if (onResult) {
              const resultPayload: TranslationResult = {
                chunkIndex: i,
                originalText: chunks[i].map(n => n.content || '').join('\n\n'),
                translatedText: translated.map(n => n.content || '').join('\n\n'),
                translatedSegments: translated.map(n => n.content || ''),
                success: true
              };
              onResult(resultPayload);
            }
          } catch (error) {
            if (this.stopRequested) {
              failedChunks++;
              return;
            }

            this.log('warning', `⚠️ 청크 ${i + 1}번 번역 실패. 분할 정복 시작...`);

            // 오류 발생 시 재귀 분할 정복 (슬라이딩 문맥 미사용)
            const retriedNodes = await this.retryEpubNodesWithSmallerBatches(
              chunks[i],
              i,
              context,
              1
            );
            chunkResults.set(i, retriedNodes);
            failedChunks++;

            if (onResult) {
              onResult({
                chunkIndex: i,
                originalText: chunks[i].map(n => n.content || '').join('\n\n'),
                translatedText: retriedNodes.map(n => n.content || '').join('\n\n'),
                translatedSegments: retriedNodes.map(n => n.content || ''),
                success: true 
              });
            }
          } finally {
            processedChunks++;
            
            if (onProgress) {
              const now = Date.now();
              const elapsedSeconds = (now - startTime) / 1000;
              let etaSeconds = 0;
              if (processedChunks > 0) {
                const avgTimePerChunk = elapsedSeconds / processedChunks;
                const remainingChunks = chunks.length - processedChunks;
                etaSeconds = Math.ceil(avgTimePerChunk * remainingChunks);
              }

              onProgress({
                totalChunks: chunks.length,
                processedChunks,
                successfulChunks,
                failedChunks,
                currentStatusMessage: `청크 ${processedChunks}/${chunks.length} 처리 완료`,
                etaSeconds,
              });
            }
          }
        })();

        processingPromises.add(task);
        task.then(() => processingPromises.delete(task));

        if (processingPromises.size >= maxWorkers) {
          await Promise.race(processingPromises);
        }
      }

      await Promise.all(processingPromises);

      let translatedNodes: EpubNode[] = [];
      for (let i = 0; i < chunks.length; i++) {
        if (chunkResults.has(i)) {
          translatedNodes.push(...chunkResults.get(i)!);
        } else {
          translatedNodes.push(...chunks[i]);
        }
      }

      if (this.config.enableImageAnnotation && zip) {
        this.log('info', '🖼️ 이미지 주석 생성 시작...');
        const imageAnnotationService = new ImageAnnotationService(this.config, this.apiKey);
        if (this.onLog) {
            imageAnnotationService.setLogCallback(this.onLog);
        }
        
        translatedNodes = await imageAnnotationService.annotateImages(
            translatedNodes, 
            zip, 
            (progress) => {
                 this.log('info', `이미지 처리: ${progress.processedImages}/${progress.totalImages} (${progress.currentStatusMessage})`);
            }
        );
      }

      this.log('info', `📚 EPUB 번역 완료: ${translatedNodes.length}개 노드`);
      return translatedNodes;
    } catch (error) {
      this.log('error', `❌ EPUB 번역 실패: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * EPUB 노드 배치 번역 (디버깅 로그 추가 버전)
   * [UPDATE] previousContext 파라미터 및 isTranslatedContext 플래그 추가
   */
  private async translateEpubChunk(
    nodes: EpubNode[],
    context: TranslationContext,
    currentAttempt: number = 1,
    chunkIndex: number = 0,
    previousContext?: string,
    isTranslatedContext: boolean = false // [NEW] Flag
  ): Promise<EpubNode[]> {
    const textNodes = nodes.filter((n) => n.type === 'text');

    if (textNodes.length === 0) {
      return nodes;
    }
    
    const MAX_RETRIES = this.config.maxRetryAttempts;
    if (currentAttempt > MAX_RETRIES) {
      this.log('error', `❌ 최대 재시도(${MAX_RETRIES}) 도달: ${textNodes.length}개 노드 번역 실패.`);
      return nodes;
    }

    const requestData = textNodes.map((n) => ({
      id: n.id,
      text: n.content,
    }));
    
    const jsonString = JSON.stringify(requestData, null, 2);

    // [수정] 플래그 전달
    const { prompt, glossaryContext, storyBibleContext } = this.preparePromptAndContext(
      jsonString, 
      chunkIndex, 
      context.glossaryEntries, 
      context.storyBible,
      previousContext,
      isTranslatedContext
    );

    const config: GenerationConfig = {
      temperature: this.config.temperature,
      topP: this.config.topP,
      responseMimeType: 'application/json',
      responseJsonSchema: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            translated_text: { type: 'string' },
          },
          required: ['id', 'translated_text'],
        },
      },
    };

    let cancelThisRequest: (() => void) | undefined;
    const cancelPromise = new Promise<string>((_, reject) => {
      cancelThisRequest = () => { reject(new Error('CANCELLED_BY_USER')); };
    });
    if (cancelThisRequest) this.cancelControllers.add(cancelThisRequest);

    try {
      let responseText: string;
      let apiPromise: Promise<string>;

      if (this.config.enablePrefillTranslation) {
        const rawHistory = this.config.prefillCachedHistory.map(item => ({
          role: item.role,
          content: item.parts.join('\n'),
        }));
        const chatHistory = this.mergeConsecutiveRoles(rawHistory);
        
        const substitutionData = { 
          '{{slot}}': jsonString, 
          '{{glossary_context}}': glossaryContext,
          '{{story_bible}}': storyBibleContext,
          // [NEW]
          '{{previous_context_section}}': prompt.includes('[이전 ') ? 
            prompt.substring(prompt.indexOf('[이전 '), prompt.indexOf('"""\n\n') + 5) : '' 
        };

        apiPromise = this.geminiClient.generateWithChat(
          prompt, this.config.prefillSystemInstruction, chatHistory, this.config.modelName,
          { ...config, substitutionData }
        );
      } else {
        apiPromise = this.geminiClient.generateText(prompt, this.config.modelName, this.config.prefillSystemInstruction, config);
      }

      responseText = await Promise.race([apiPromise, cancelPromise]);
      const translations: Array<{ id: string; translated_text: string }> = JSON.parse(responseText);
      const translationMap = new Map(translations.map((t) => [t.id, t.translated_text]));
      
      const successfullyTranslatedNodes: EpubNode[] = [];
      const missingNodes: EpubNode[] = [];

      for (const node of textNodes) {
        if (translationMap.has(node.id)) {
          const translatedText = translationMap.get(node.id)!;
          successfullyTranslatedNodes.push({
            ...node,
            content: translatedText.replace(/\n/g, '<br/>'),
          });
        } else {
          missingNodes.push(node);
        }
      }

      let retriedNodes: EpubNode[] = [];
      
      if (missingNodes.length > 0) {
        this.log('warning', `⚠️ [Debug:Attempt-${currentAttempt}] 응답 누락 감지: 전체 ${textNodes.length} 중 ${missingNodes.length}개 누락.`);
        
        retriedNodes = await this.translateEpubChunk(
          missingNodes, 
          context,
          currentAttempt + 1 
          // 재귀 호출 시에는 Sliding Context를 전달하지 않음 (복잡도 회피)
        );
      }

      const combinedTranslatedNodes = [...successfullyTranslatedNodes, ...retriedNodes];
      const finalTranslationMap = new Map(combinedTranslatedNodes.map(n => [n.id, n.content]));

      return nodes.map(originalNode => {
        if (finalTranslationMap.has(originalNode.id)) {
          const content = finalTranslationMap.get(originalNode.id)!;
          return { ...originalNode, content };
        }
        return originalNode;
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (GeminiClient.isRateLimitError(error as Error)) {
        this.log('error', `API 할당량 초과(429) 감지. 번역 작업을 중단합니다.`);
        this.requestStop();
        throw error;
      }

      if (errorMessage === 'CANCELLED_BY_USER') {
        this.log('warning', `EPUB 청크 번역 중단됨 (사용자 요청)`);
        throw error;
      }

      this.log('warning', `⚠️ 청크 번역/파싱 실패. 분할 재시도를 위해 에러를 상위로 전달합니다.`);
      throw error;
    } finally {
      if (cancelThisRequest) this.cancelControllers.delete(cancelThisRequest);
    }
  }

  // retryEpubNodesWithSmallerBatches 및 restoreNodesFromResult는 기존 로직 유지
  private async retryEpubNodesWithSmallerBatches(
    nodes: EpubNode[],
    originalChunkIndex: number,
    context: TranslationContext,
    currentAttempt: number = 1
  ): Promise<EpubNode[]> {
      // 기존 로직 복사 (변경 없음)
      if (this.stopRequested) return nodes;
      if (nodes.length === 0) return [];
      if (nodes.length === 1) {
        this.log('error', `❌ 노드 ID ${nodes[0].id} 번역 실패 (개별 격리됨). 원문 유지.`);
        return [nodes[0]];
      }
      
      const maxRetryDepth = this.config.maxRetryAttempts;
      if (currentAttempt > maxRetryDepth) {
        return nodes;
      }

      const mid = Math.floor(nodes.length / 2);
      const leftBatch = nodes.slice(0, mid);
      const rightBatch = nodes.slice(mid);

      const resultsMap = new Map<string, EpubNode>();

      for (const batch of [leftBatch, rightBatch]) {
        if (this.stopRequested) break;
        try {
          const translatedBatch = await this.translateEpubChunk(batch, context);
          translatedBatch.forEach(node => resultsMap.set(node.id, node));
        } catch (error) {
          if (this.stopRequested) break;
          const retriedResults = await this.retryEpubNodesWithSmallerBatches(
            batch,
            originalChunkIndex,
            context,
            currentAttempt + 1
          );
          retriedResults.forEach(node => resultsMap.set(node.id, node));
        }
      }

      const sortedResults = Array.from(resultsMap.values()).sort((a, b) => {
        const getIdNum = (id: string) => parseInt(id.split('_').pop() || '0', 10);
        return getIdNum(a.id) - getIdNum(b.id);
      });
      
      return sortedResults;
  }

  private restoreNodesFromResult(nodes: EpubNode[], result: TranslationResult): EpubNode[] | null {
      // 기존 로직 복사 (변경 없음)
      const textNodes = nodes.filter(n => n.type === 'text');
      if (result.translatedSegments && result.translatedSegments.length > 0) {
        const segments = result.translatedSegments;
        if (textNodes.length === segments.length) {
          const newNodes = JSON.parse(JSON.stringify(nodes));
          const newTextNodes = newNodes.filter((n: EpubNode) => n.type === 'text');
          newTextNodes.forEach((node: EpubNode, idx: number) => {
            const content = segments[idx] || '';
            node.content = content.includes('<br/>') ? content : content.replace(/\n/g, '<br/>');
          });
          return newNodes;
        }
        if (nodes.length === segments.length) {
          const newNodes = JSON.parse(JSON.stringify(nodes));
          newNodes.forEach((node: EpubNode, idx: number) => {
            if (node.type === 'text') {
               const content = segments[idx] || '';
               node.content = content.includes('<br/>') ? content : content.replace(/\n/g, '<br/>');
            }
          });
          return newNodes;
        }
        return null; 
      }
      if (result.translatedText) {
        const segments = result.translatedText.trim().split(/\n\n/);
        if (textNodes.length !== segments.length) {
          return null; 
        }
        const newNodes = JSON.parse(JSON.stringify(nodes));
        const newTextNodes = newNodes.filter((n: EpubNode) => n.type === 'text');
        newTextNodes.forEach((node: EpubNode, idx: number) => {
          const content = segments[idx] || '';
          node.content = content.includes('<br/>') ? content : content.replace(/\n/g, '<br/>');
        });
        return newNodes;
      }
      return null;
  }
}
