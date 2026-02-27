
// services/StoryBibleService.ts
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { GeminiClient } from './GeminiClient';
import { ChunkService } from './ChunkService';
import type { StoryBibleData, LogEntry, CharacterSetting, WorldSetting, StoryBibleExtractionProgress } from '../types/dtos';
import type { AppConfig } from '../types/config';
import { DEFAULT_STORY_BIBLE_REFINE_PROMPT } from '../types/config';

// === Zod Schemas for Divide & Conquer ===

// 1. Characters Schema
const refineCharactersSchema = z.object({
  characters: z.array(z.object({
    name: z.string(),
    role: z.string(),
    personality: z.string(),
    speakingStyle: z.string(),
    relationships: z.string(),
    notes: z.string()
  }))
});

// 2. World Settings Schema
const refineWorldSchema = z.object({
  worldSettings: z.array(z.object({
    category: z.string(),
    title: z.string(),
    content: z.string()
  }))
});

// 3. Plot & Style Schema
const refinePlotStyleSchema = z.object({
  plotSummary: z.string(),
  styleGuide: z.string()
});

// 4. Full Story Bible Schema (for initial extraction)
const storyBibleSchema = z.object({
  characters: z.array(z.object({
    name: z.string(),
    role: z.string(),
    personality: z.string(),
    speakingStyle: z.string(),
    relationships: z.string(),
    notes: z.string()
  })),
  worldSettings: z.array(z.object({
    category: z.string(),
    title: z.string(),
    content: z.string()
  })),
  plotSummary: z.string(),
  styleGuide: z.string()
});

export class StoryBibleService {
  private geminiClient: GeminiClient;
  private chunkService: ChunkService;
  private config: AppConfig;
  private onLog?: (entry: LogEntry) => void;
  private stopRequested: boolean = false;

  constructor(config: AppConfig, apiKey?: string) {
    this.config = config;
    this.geminiClient = new GeminiClient(apiKey, config.requestsPerMinute);
    this.chunkService = new ChunkService(config.storyBibleChunkSize || 30000);
  }

  setLogCallback(callback: (entry: LogEntry) => void): void {
    this.onLog = callback;
  }

  private log(level: LogEntry['level'], message: string): void {
    this.onLog?.({ level, message, timestamp: new Date() });
  }

  requestStop(): void {
    this.stopRequested = true;
  }

  resetStop(): void {
    this.stopRequested = false;
  }

  /**
   * [변경] 외부에서 호출 가능한 샘플링 메서드
   * 소설 전체 범위에서 무작위로 분석할 세그먼트 선택
   */
  public getSampleSegments(textContent: string): string[] {
    const chunkSize = this.config.storyBibleChunkSize || 30000;
    const samplingRatio = (this.config.storyBibleSamplingRatio || 15) / 100;
    
    // 1. 전체 텍스트를 청크로 분할
    const allChunks = this.chunkService.createChunksFromFileContent(textContent, chunkSize);
    if (allChunks.length <= 1) return allChunks;

    // 2. 샘플링 개수 결정 (최소 1개)
    const sampleSize = Math.max(1, Math.round(allChunks.length * samplingRatio));
    
    // 3. 무작위 샘플링 (Fisher-Yates)
    const indices = Array.from({ length: allChunks.length }, (_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }

    // 4. 선택된 인덱스를 정렬하여 시간 순서대로 분석하게 함
    const selectedIndices = indices.slice(0, sampleSize).sort((a, b) => a - b);
    
    this.log('debug', `전체 ${allChunks.length}개 청크 중 ${selectedIndices.length}개를 무작위 샘플링하여 심층 분석합니다.`);
    return selectedIndices.map(i => allChunks[i]);
  }

  /**
   * [변경] 2단계: AI 기반 지능형 통합 (Divide & Conquer)
   * 통합 과정을 3개로 분할하여 수행합니다.
   */
  private async refineStoryBible(rawBibles: StoryBibleData[]): Promise<StoryBibleData> {
    if (rawBibles.length === 0) throw new Error("정제할 데이터가 없습니다.");
    if (rawBibles.length === 1) return rawBibles[0]; 

    this.log('info', `🤖 [2단계] 데이터 정제 시작 (Divide & Conquer: 인물, 세계관, 줄거리를 나누어 통합합니다)`);

    // 1. 날것의 데이터를 텍스트로 직렬화 (프롬프트 주입용)
    // rawBibles는 이미 인덱스 순서대로 정렬되어 있다고 가정합니다.
    let serializedData = rawBibles.map((bible, idx) => {
      const chunkLabel = `[Chunk #${idx + 1}]`;
      const chars = bible.characters.map(c => `- ${c.name} (${c.role}): ${c.personality}, ${c.speakingStyle}`).join('\n');
      const worlds = bible.worldSettings.map(w => `- [${w.category}] ${w.title}: ${w.content}`).join('\n');
      return `
${chunkLabel}
> 줄거리: ${bible.plotSummary}
> 스타일: ${bible.styleGuide}
> 등장인물:
${chars}
> 세계관:
${worlds}
--------------------------------------------------
`;
    }).join('\n');

    // 프롬프트 길이 제한 방어 코드
    if (serializedData.length > 800000) { 
        this.log('warning', '데이터가 너무 방대하여 일부 내용을 요약하여 전달합니다.');
        serializedData = serializedData.slice(0, 800000) + "\n... (데이터 생략됨)";
    }

    const basePrompt = DEFAULT_STORY_BIBLE_REFINE_PROMPT.replace('{{raw_data}}', serializedData);

    // 병렬 실행: 인물, 세계관, 줄거리/스타일을 각각 독립적으로 통합
    // 하나가 실패해도 나머지는 살리기 위해 Promise.allSettled 사용 고려 가능하나,
    // 여기서는 Promise.all로 진행하되 각 함수 내부에서 에러 핸들링
    
    const [charactersResult, worldResult, plotStyleResult] = await Promise.all([
      this.runRefineTask(basePrompt, 'CHARACTERS', refineCharactersSchema, rawBibles),
      this.runRefineTask(basePrompt, 'WORLD', refineWorldSchema, rawBibles),
      this.runRefineTask(basePrompt, 'PLOT_STYLE', refinePlotStyleSchema, rawBibles)
    ]);

    // 결과 합치기
    const finalData: StoryBibleData = {
      characters: charactersResult.characters || [],
      worldSettings: worldResult.worldSettings || [],
      plotSummary: plotStyleResult.plotSummary || "",
      styleGuide: plotStyleResult.styleGuide || ""
    };

    // ID 및 활성 상태 부여
    finalData.characters.forEach((c: any) => { 
        if(!c.id) c.id = `char-${Math.random().toString(36).substr(2, 9)}`; 
        c.isActive = true; 
    });
    finalData.worldSettings.forEach((w: any) => { 
        if(!w.id) w.id = `world-${Math.random().toString(36).substr(2, 9)}`; 
        w.isActive = true; 
    });

    return finalData;
  }

  /**
   * 개별 통합 작업 실행 헬퍼
   */
  private async runRefineTask(
    basePrompt: string, 
    taskType: 'CHARACTERS' | 'WORLD' | 'PLOT_STYLE', 
    zodSchema: z.ZodType<any>,
    fallbackData: StoryBibleData[]
  ): Promise<any> {
    const taskNameMap = {
      'CHARACTERS': '인물 통합',
      'WORLD': '세계관 통합',
      'PLOT_STYLE': '줄거리 및 스타일 통합'
    };
    
    this.log('debug', `... ${taskNameMap[taskType]} 작업 시작`);

    const specificInstruction = `
    
    🛑 **CRITICAL INSTRUCTION**:
    You are currently performing the **${taskType}** synthesis task.
    You MUST output JSON adhering strictly to the provided schema.
    Do NOT include any fields not requested in the schema.
    Ignore information irrelevant to ${taskType}.
    `;

    const rawSchema = zodToJsonSchema(zodSchema);
    const { $schema, ...jsonSchema } = rawSchema as any;

    try {
      const responseText = await this.geminiClient.generateText(
        basePrompt + specificInstruction,
        this.config.modelName,
        "You are an expert Story Bible Editor. Merge the provided data fragments logically.",
        {
          temperature: 0.1,
          responseMimeType: "application/json",
          responseJsonSchema: jsonSchema
        }
      );
      
      return JSON.parse(responseText);

    } catch (error) {
      this.log('error', `❌ ${taskNameMap[taskType]} 실패: ${error}. 이 부분만 기계적 병합(Fallback)을 사용합니다.`);
      
      // Fallback 로직
      const mechanicalMerge = this.mergeExtractedResults(fallbackData);
      
      if (taskType === 'CHARACTERS') return { characters: mechanicalMerge.characters };
      if (taskType === 'WORLD') return { worldSettings: mechanicalMerge.worldSettings };
      if (taskType === 'PLOT_STYLE') return { plotSummary: mechanicalMerge.plotSummary, styleGuide: mechanicalMerge.styleGuide };
      
      return {};
    }
  }

  /**
   * 추출된 여러 결과들을 하나로 기계적 병합 (Fallback 용도)
   */
  private mergeExtractedResults(results: StoryBibleData[]): StoryBibleData {
    const merged: StoryBibleData = {
      characters: [],
      worldSettings: [],
      plotSummary: "",
      styleGuide: ""
    };

    const charMap = new Map<string, CharacterSetting>();
    const worldMap = new Map<string, WorldSetting>();
    const summaries: string[] = [];
    const styleGuides: string[] = [];

    results.forEach(res => {
      // 인물 병합 (이름 기준)
      res.characters.forEach(char => {
        if (charMap.has(char.name)) {
          const existing = charMap.get(char.name)!;
          // 더 긴 설명이나 상세 정보를 우선함
          existing.role = char.role.length > existing.role.length ? char.role : existing.role;
          existing.personality = char.personality.length > existing.personality.length ? char.personality : existing.personality;
          if (!existing.relationships.includes(char.relationships)) {
            existing.relationships += `; ${char.relationships}`;
          }
          if (!existing.notes.includes(char.notes)) {
            existing.notes += `\n${char.notes}`;
          }
        } else {
          charMap.set(char.name, { ...char, id: `char-${Math.random().toString(36).substr(2, 9)}`, isActive: true });
        }
      });

      // 세계관 병합 (타이틀 기준)
      res.worldSettings.forEach(ws => {
        const key = `${ws.category}:${ws.title}`;
        if (worldMap.has(key)) {
          const existing = worldMap.get(key)!;
          if (ws.content.length > existing.content.length) {
            existing.content = ws.content;
          }
        } else {
          worldMap.set(key, { ...ws, id: `world-${Math.random().toString(36).substr(2, 9)}`, isActive: true });
        }
      });

      if (res.plotSummary) summaries.push(res.plotSummary);
      if (res.styleGuide) styleGuides.push(res.styleGuide);
    });

    merged.characters = Array.from(charMap.values());
    merged.worldSettings = Array.from(worldMap.values());
    merged.plotSummary = summaries.join("\n\n");
    // 중복 제거된 유니크한 가이드라인만 합침
    merged.styleGuide = Array.from(new Set(styleGuides)).join("\n");

    return merged;
  }

  /**
   * [변경] 2단계 프로세스 적용 (Scan -> Refine) + 제한적 병렬 처리 (Limited Parallelism)
   */
  async extractStoryBible(
    segments: string[], 
    glossaryContext?: string, 
    existingBible?: StoryBibleData,
    onProgress?: (progress: StoryBibleExtractionProgress) => void
  ): Promise<StoryBibleData> {
    this.resetStop();
    
    if (!segments || segments.length === 0) {
        throw new Error("분석할 텍스트 세그먼트가 없습니다.");
    }

    const totalSegments = segments.length;
    const maxWorkers = this.config.maxWorkers || 1;
    this.log('info', `스토리 바이블 추출 시작: 총 ${totalSegments}개 세그먼트, 동시 작업 수: ${maxWorkers} (2단계 프로세스)`);
    
    const startTime = Date.now();
    const rawSchema = zodToJsonSchema(storyBibleSchema as any);
    const { $schema, ...jsonSchema } = rawSchema as any;

    // 병렬 처리 결과를 순서대로 저장하기 위한 Map
    const resultsMap = new Map<number, StoryBibleData>();
    const processingPromises = new Set<Promise<void>>();
    let processedCount = 0;

    // [1단계] 수집 (Collection/Scan Phase) - 병렬 처리
    for (let i = 0; i < totalSegments; i++) {
      // 중단 요청 확인
      if (this.stopRequested) {
        this.log('warning', '사용자 요청으로 추가 분석 작업 생성을 중단합니다. 진행 중인 작업은 계속됩니다.');
        break;
      }

      const task = (async () => {
        if (this.stopRequested) return;

        const segment = segments[i];
        
        try {
          let prompt = this.config.storyBibleExtractionPrompt;
          const existingBibleText = existingBible ? StoryBibleService.formatForPrompt(existingBible) : "알려진 배경 정보 없음";
          
          prompt = prompt.replace('{{existing_bible}}', existingBibleText);
          prompt = prompt.replace('{{glossary_context}}', glossaryContext || '제공된 용어집 없음');
          prompt = `${prompt}\n\n[분석 대상 원문 조각]\n${segment}`;

          // 진행 상황 업데이트 (시작)
          // 병렬이므로 "분석 중" 메시지는 로그로만, 상태는 아래 finally에서 업데이트
          this.log('debug', `[Worker] ${i + 1}번 세그먼트 분석 시작...`);

          const responseText = await this.geminiClient.generateText(
            prompt,
            this.config.modelName,
            "You are a specialized literary analyst. Extract raw facts from this segment.",
            {
              temperature: this.config.storyBibleExtractionTemperature ?? 0.2,
              responseMimeType: "application/json",
              responseJsonSchema: jsonSchema
            }
          );

          if (this.stopRequested) return;

          const rawData = JSON.parse(responseText);
          resultsMap.set(i, rawData);
          
          this.log('debug', `✅ ${i + 1}번 세그먼트 분석 완료 (인물 ${rawData.characters.length}명 감지).`);

        } catch (error) {
          if (GeminiClient.isRateLimitError(error as Error)) {
            this.log('warning', `⚠️ API 할당량 초과(429) 감지. 분석을 중단합니다.`);
            this.requestStop();
          } else {
            this.log('error', `❌ ${i + 1}번 세그먼트 분석 중 오류: ${error}`);
          }
        } finally {
          processedCount++;
          
          // 진행 상황 업데이트 (UI)
          const elapsed = (Date.now() - startTime) / 1000;
          const avgTime = processedCount > 0 ? elapsed / processedCount : 15;
          const eta = Math.ceil(avgTime * (totalSegments - processedCount));

          onProgress?.({
            totalSteps: totalSegments,
            processedSteps: processedCount,
            currentStatusMessage: `[1단계: 수집] 소설 분석 중 (${processedCount}/${totalSegments})...`,
            etaSeconds: eta
          });
        }
      })();

      processingPromises.add(task);
      task.then(() => processingPromises.delete(task));

      // Worker 수 제한
      if (processingPromises.size >= maxWorkers) {
        await Promise.race(processingPromises);
      }
    }

    // 남은 작업 대기
    await Promise.all(processingPromises);

    // 수집된 결과가 없으면 에러 처리
    if (resultsMap.size === 0) {
      if (this.stopRequested) throw new Error("분석이 초기에 중단되어 데이터가 없습니다.");
      throw new Error("분석된 데이터가 없습니다. API 연결 상태를 확인하세요.");
    }

    // 결과 정렬 (인덱스 순) -> 순서 보장이 중요함
    const rawBibles = Array.from(resultsMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(entry => entry[1]);

    // [2단계] 통합 (Synthesis/Refine Phase)
    if (this.stopRequested && rawBibles.length < totalSegments) {
        this.log('info', '중단 요청에 따라 현재까지 수집된 데이터만으로 통합을 진행합니다.');
    }

    onProgress?.({
      totalSteps: totalSegments,
      processedSteps: rawBibles.length,
      currentStatusMessage: "🔥 [2단계: 통합] AI 편집장이 수집된 데이터를 최종 정제하고 있습니다...",
      etaSeconds: 15 
    });

    // 여기서 refineStoryBible 호출 (Map-Reduce의 Reduce 단계)
    const finalData = await this.refineStoryBible(rawBibles);
    
    this.log('info', `✅ 분석 완료: ${finalData.characters.length}명의 인물과 ${finalData.worldSettings.length}개의 설정으로 정리되었습니다.`);
    
    return finalData;
  }

  static formatForPrompt(data?: StoryBibleData): string {
    if (!data) return "배경 정보 없음";

    const activeChars = data.characters.filter(c => c.isActive);
    const activeWorld = data.worldSettings.filter(w => w.isActive);

    const charStr = activeChars
      .map(c => `### ${c.name} (${c.role})\n- 성격: ${c.personality}\n- 말투: ${c.speakingStyle}\n- 관계: ${c.relationships}\n- 비고: ${c.notes}`)
      .join('\n\n');

    const worldStr = activeWorld
      .map(w => `### [${w.category}] ${w.title}\n${w.content}`)
      .join('\n\n');

    return `
[등장인물 설정]
${charStr || '정보 없음'}

[세계관/기타 설정]
${worldStr || '정보 없음'}

[줄거리 흐름]
${data.plotSummary || '정보 없음'}

[스타일 가이드]
${data.styleGuide || '정보 없음'}
`.trim();
  }
}
