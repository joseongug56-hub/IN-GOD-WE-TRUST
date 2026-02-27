
// hooks/useTranslation.ts
// 번역 기능을 위한 커스텀 훅

import { useCallback, useRef, useEffect } from 'react';
import { useTranslationStore } from '../stores/translationStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useGlossaryStore } from '../stores/glossaryStore';
import { useStoryBibleStore } from '../stores/storyBibleStore'; // [추가] 스토리 바이블 연동
import { TranslationService } from '../services/TranslationService';
import { ChunkService } from '../services/ChunkService';
import { EpubService } from '../services/EpubService';
import { EpubChunkService } from '../services/EpubChunkService';
import { FileHandler } from '../utils/fileHandler';
import type { TranslationJobProgress, TranslationResult, TranslationSnapshot, FileContent, TranslationContext } from '../types/dtos';
import type { AppConfig } from '../types/config';

/**
 * 번역 기능을 제공하는 커스텀 훅
 * TranslationService와 스토어를 연결합니다.
 */
export function useTranslation() {
  // 스토어 상태
  const { config, updateConfig } = useSettingsStore();
  const { entries: glossaryEntries } = useGlossaryStore();
  const { data: storyBibleData, setData: setStoryBibleData } = useStoryBibleStore(); // [추가] 스토리 바이블 연동
  
  const {
    inputFiles,
    isRunning,
    isPaused,
    progress,
    results,
    translatedText,
    startTranslation,
    stopTranslation,
    updateProgress,
    setResults,
    addResult,
    updateResult,
    setTranslatedText,
    combineResultsToText,
    addLog,
    restoreSession,
    translationMode,
  } = useTranslationStore();

  // 서비스 인스턴스 참조
  const serviceRef = useRef<TranslationService | null>(null);
  const isTranslatingRef = useRef(false);

  // 서비스 초기화 또는 업데이트
  const getOrCreateService = useCallback((): TranslationService => {
    if (!serviceRef.current) {
      serviceRef.current = new TranslationService(config);
      
      // 로그 콜백 설정
      serviceRef.current.setLogCallback((entry) => {
        addLog(entry.level, entry.message);
      });
    } else {
      // 설정 업데이트
      serviceRef.current.updateConfig(config);
    }

    return serviceRef.current;
  }, [config, addLog]);

  // 번역 컨텍스트 생성 헬퍼
  const createTranslationContext = useCallback((): TranslationContext => {
    return {
      glossaryEntries,
      storyBible: storyBibleData || undefined, // [추가] 스토리 바이블 주입
    };
  }, [glossaryEntries, storyBibleData]);

  // 번역 시작
  const executeTranslation = useCallback(async () => {
    if (inputFiles.length === 0) {
      addLog('warning', '번역할 파일을 선택해주세요.');
      return;
    }

    if (isTranslatingRef.current) {
      addLog('warning', '이미 번역이 진행 중입니다.');
      return;
    }

    // 기존 결과 보존 (이어하기용)
    const existingResults = results.length > 0 ? results : undefined;

    isTranslatingRef.current = true;
    startTranslation();

    try {
      const service = getOrCreateService();
      const context = createTranslationContext(); // 컨텍스트 생성

      // [수정] 파일 목록을 직접 전달 (TranslationService가 파일 경계를 인식하도록)
      if (!inputFiles[0].isEpub) {
        const fullTextLength = inputFiles.reduce((sum, f) => sum + f.content.length, 0);
        addLog('info', `총 ${inputFiles.length}개 파일, ${fullTextLength.toLocaleString()}자 번역 시작`);
        addLog('info', `모델: ${config.modelName}, 청크 크기: ${config.chunkSize}, 파일 단위 문맥 리셋 적용`);
      }

      // 진행률 콜백
      const onProgress = (progress: TranslationJobProgress) => {
        updateProgress(progress);
      };

      // 실시간 결과 콜백
      const onResult = (result: TranslationResult) => {
        addResult(result);
      };

      if (translationMode === 'integrity') {
        addLog('info', '🔒 무결성 보장 모드로 번역을 시작합니다. (줄 단위 노드)');
        const fullText = inputFiles.map(f => f.content).join('\n\n'); // 무결성 모드는 기존 방식 유지 (줄 단위라 문맥 오염 적음)

        const { text, results: integrityResults } = await service.translateTextWithIntegrityGuarantee(
          fullText,
          context,
          onProgress,
          onResult
        );

        setResults(integrityResults);
        setTranslatedText(text);

        const successCount = integrityResults.filter(r => r.success).length;
        const failCount = integrityResults.filter(r => !r.success).length;
        addLog('info', `번역 완료: 성공 ${successCount}개, 실패 ${failCount}개 (무결성 모드)`);
        if (failCount > 0) {
          addLog('warning', `${failCount}개 청크가 번역에 실패했습니다. 검토 탭에서 확인하세요.`);
        }
      } else {
        // 기본 모드 번역 실행 - [수정] inputFiles 배열 직접 전달
        const translationResults = await service.translateText(
          inputFiles, 
          context,
          onProgress, 
          existingResults,
          onResult
        );

        setResults(translationResults);

        const combinedText = TranslationService.combineResults(translationResults);
        setTranslatedText(combinedText);

        const successCount = translationResults.filter(r => r.success).length;
        const failCount = translationResults.filter(r => !r.success).length;
        
        addLog('info', `번역 완료: 성공 ${successCount}개, 실패 ${failCount}개`);

        if (failCount > 0) {
          addLog('warning', `${failCount}개 청크가 번역에 실패했습니다. 검토 탭에서 확인하세요.`);
        }
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      addLog('error', `번역 중 오류 발생: ${errorMessage}`);
      
      updateProgress({
        totalChunks: 0,
        processedChunks: 0,
        successfulChunks: 0,
        failedChunks: 0,
        currentStatusMessage: `오류: ${errorMessage}`,
        lastErrorMessage: errorMessage,
      });
    } finally {
      isTranslatingRef.current = false;
      stopTranslation();
    }
  }, [
    inputFiles,
    config,
    results,
    getOrCreateService,
    createTranslationContext,
    startTranslation,
    stopTranslation,
    updateProgress,
    setResults,
    addResult,
    setTranslatedText,
    addLog,
    translationMode,
  ]);

  // 번역 중지
  const cancelTranslation = useCallback(() => {
    if (serviceRef.current) {
      serviceRef.current.requestStop();
    }
    stopTranslation();
    addLog('warning', '번역이 사용자에 의해 중단되었습니다.');
  }, [stopTranslation, addLog]);

  // 실패한 청크 재번역
  const retryFailedChunks = useCallback(async () => {
    const failedResults = results.filter(r => !r.success);
    
    if (failedResults.length === 0) {
      addLog('info', '재시도할 실패한 청크가 없습니다.');
      return;
    }

    if (isTranslatingRef.current) {
      addLog('warning', '이미 번역이 진행 중입니다.');
      return;
    }

    isTranslatingRef.current = true;
    addLog('info', `${failedResults.length}개 실패한 청크 재번역 시작`);

    const service = getOrCreateService();
    const context = createTranslationContext(); // 컨텍스트 생성
    const onProgress = (progress: TranslationJobProgress) => updateProgress(progress);
    const onResult = (result: TranslationResult) => updateResult(result.chunkIndex, result);

    const isEpubMode = inputFiles[0]?.isEpub;

    try {
      let retriedResults;

      if (isEpubMode) {
        // EPUB 재번역
        const epubFile = inputFiles[0];
        if (epubFile.epubChapters) {
          const allNodes = epubFile.epubChapters.flatMap((ch: any) => ch.nodes);
          retriedResults = await service.retryFailedEpubChunks(
            results,
            allNodes,
            context,
            onProgress,
            onResult
          );
        } else {
          throw new Error("EPUB 챕터 정보를 찾을 수 없습니다.");
        }
      } else if (translationMode === 'integrity') {
        // 무결성 모드 재번역
        const fullText = inputFiles.map(f => f.content).join('\n\n');
        const { text, results: integrityResults } = await service.retryFailedIntegrityChunks(
          results,
          fullText,
          context,
          onProgress,
          onResult
        );
        retriedResults = integrityResults;
        setTranslatedText(text);
      } else {
        // 일반 텍스트 재번역
        retriedResults = await service.retryFailedChunks(
          results,
          context,
          onProgress,
          onResult
        );
        
        const combinedText = TranslationService.combineResults(retriedResults);
        setTranslatedText(combinedText);
      }

      setResults(retriedResults || results);
      
      const successCount = retriedResults?.filter(r => r.success).length || 0;
      addLog('info', `재번역 완료. 성공: ${successCount}개`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      addLog('error', `재번역 중 오류 발생: ${errorMessage}`);
    } finally {
      isTranslatingRef.current = false;
    }
  }, [
    results,
    inputFiles,
    translationMode,
    getOrCreateService,
    createTranslationContext,
    updateProgress,
    updateResult,
    setResults,
    setTranslatedText,
    addLog,
  ]);

  // 단일 청크 재번역 (검토 페이지용)
  const retrySingleChunk = useCallback(async (chunkIndex: number) => {
    const chunk = results.find(r => r.chunkIndex === chunkIndex);
    if (!chunk) {
      addLog('error', `청크 #${chunkIndex + 1}를 찾을 수 없습니다.`);
      return;
    }

    if (isTranslatingRef.current) {
      addLog('warning', '이미 번역이 진행 중입니다.');
      return;
    }

    isTranslatingRef.current = true;
    addLog('info', `청크 #${chunkIndex + 1} 단일 재번역 시작`);

    const service = getOrCreateService();
    const context = createTranslationContext(); // 컨텍스트 생성
    const isEpubMode = inputFiles[0]?.isEpub;

    try {
      let newResult: TranslationResult;

      if (isEpubMode) {
        // EPUB 단일 청크 재구성 및 번역
        const epubFile = inputFiles[0];
        if (!epubFile.epubChapters) throw new Error("EPUB 데이터 없음");
        
        // 전체 노드를 다시 가져와서 해당 청크의 노드들을 찾음
        const allNodes = epubFile.epubChapters.flatMap((ch: any) => ch.nodes);
        const epubChunkService = new EpubChunkService(config.chunkSize, config.epubMaxNodesPerChunk);
        const chunks = epubChunkService.splitEpubNodesIntoChunks(allNodes);
        
        const targetNodes = chunks[chunkIndex];
        if (!targetNodes) throw new Error("해당 청크의 노드를 찾을 수 없습니다.");

        // 임시로 진행상황 표시를 위해 store 업데이트
        updateResult(chunkIndex, { success: false, error: '재번역 중...', translatedText: '재번역 중...' });

        const translatedNodes = await service.translateEpubNodes(
            targetNodes, 
            context,
            undefined, 
            undefined, 
            undefined, 
            [] 
        );

        newResult = {
            chunkIndex,
            originalText: targetNodes.map(n => n.content || '').join('\n\n'),
            translatedText: translatedNodes.map(n => n.content || '').join('\n\n'),
            translatedSegments: translatedNodes.map(n => n.content || ''),
            success: true
        };

      } else {
        // 텍스트 모드 단일 재번역
        newResult = await service.translateChunk(
          chunk.originalText,
          chunkIndex,
          context,
          true // safety retry enabled
        );
      }

      updateResult(chunkIndex, newResult);
      combineResultsToText();
      addLog('info', `청크 #${chunkIndex + 1} 재번역 완료`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      addLog('error', `청크 #${chunkIndex + 1} 재번역 실패: ${errorMessage}`);
      updateResult(chunkIndex, { error: errorMessage, success: false });
    } finally {
      isTranslatingRef.current = false;
    }
  }, [
    results, 
    inputFiles, 
    config, 
    getOrCreateService, 
    createTranslationContext, 
    updateResult, 
    combineResultsToText, 
    addLog
  ]);

  // 스냅샷 생성
  const createSnapshot = useCallback(async (): Promise<TranslationSnapshot | null> => {
    if (inputFiles.length === 0) return null;

    // [NEW] 파일 무결성 검증을 위한 지문 생성
    const fingerprint = FileHandler.generateFingerprint(inputFiles);

    const snapshot: TranslationSnapshot = {
      meta: {
        version: '1.0.0',
        created_at: new Date().toISOString(),
        app_version: '2.0.0-react',
      },
      source_info: {
        file_name: inputFiles[0].name,
        file_size: inputFiles[0].size,
      },
      source_fingerprint: fingerprint, // [NEW] 지문 저장
      config: {
        chunk_size: config.chunkSize,
        model_name: config.modelName,
        temperature: config.temperature,
        requests_per_minute: config.requestsPerMinute,
        max_workers: config.maxWorkers,
        // Config의 나머지 필드들도 매핑...
        enable_prefill_translation: config.enablePrefillTranslation,
        prefill_system_instruction: config.prefillSystemInstruction,
        prefill_cached_history: config.prefillCachedHistory,
        enable_dynamic_glossary_injection: config.enableDynamicGlossaryInjection,
        max_glossary_entries_per_chunk_injection: config.maxGlossaryEntriesPerChunkInjection,
        max_glossary_chars_per_chunk_injection: config.maxGlossaryCharsPerChunkInjection,
        glossary_extraction_prompt: config.glossaryExtractionPrompt,
        enable_image_annotation: config.enableImageAnnotation,
        epub_max_nodes_per_chunk: config.epubMaxNodesPerChunk,
      },
      mode: inputFiles[0].isEpub ? 'epub' : 'text',
      source_text: inputFiles[0].content, 
      progress: {
        total_chunks: progress?.totalChunks || 0,
        processed_chunks: progress?.processedChunks || 0,
      },
      translated_chunks: {},
      story_bible: storyBibleData || undefined, 
    };

    // 결과 맵핑
    results.forEach(r => {
      snapshot.translated_chunks[r.chunkIndex] = {
        original_text: r.originalText,
        translated_text: r.translatedText,
        translated_segments: r.translatedSegments,
        status: r.success ? 'completed' : 'failed',
      };
    });

    if (inputFiles[0].isEpub && inputFiles[0].epubChapters) {
        snapshot.epub_structure = {
            chapters: inputFiles[0].epubChapters.map((ch: any) => ({
                id: ch.fileName,
                filename: ch.fileName,
                nodeCount: ch.nodes.length
            }))
        };
    }

    return snapshot;
  }, [inputFiles, config, progress, results, storyBibleData]);

  // 스냅샷으로 내보내기 (파일 다운로드)
  const exportSnapshot = useCallback(async () => {
    const snapshot = await createSnapshot();
    if (!snapshot) {
      addLog('warning', '저장할 데이터가 없습니다.');
      return;
    }
    
    const fileName = `btg_snapshot_${new Date().toISOString().slice(0, 10)}.json`;
    FileHandler.downloadJsonFile(snapshot, fileName);
    addLog('info', `작업 스냅샷이 저장되었습니다: ${fileName}`);
  }, [createSnapshot, addLog]);

  // 스냅샷 불러오기 (파일 또는 객체)
  const importSnapshot = useCallback(async (dataOrFile: File | TranslationSnapshot) => {
    try {
      let snapshot: TranslationSnapshot;

      if (dataOrFile instanceof File) {
        const text = await dataOrFile.text();
        snapshot = JSON.parse(text);
      } else {
        snapshot = dataOrFile;
      }

      // [NEW] 무결성 검증: 파일 지문 대조
      if (inputFiles.length > 0) {
        const currentFingerprint = FileHandler.generateFingerprint(inputFiles);
        // 저장된 지문이 있고, 현재 파일의 지문과 다른 경우
        if (snapshot.source_fingerprint && snapshot.source_fingerprint !== currentFingerprint) {
           addLog('error', '⚠️ 스냅샷 복구 실패: 현재 업로드된 파일과 스냅샷의 원본 파일이 일치하지 않습니다.');
           addLog('debug', `Expected: ${snapshot.source_fingerprint}, Actual: ${currentFingerprint}`);
           return;
        }
      }

      // 1. 설정 복원
      if (snapshot.config) {
        updateConfig({
          chunkSize: snapshot.config.chunk_size,
          modelName: snapshot.config.model_name,
          temperature: snapshot.config.temperature,
          requestsPerMinute: snapshot.config.requests_per_minute,
          maxWorkers: snapshot.config.max_workers,
          enablePrefillTranslation: snapshot.config.enable_prefill_translation,
          prefillSystemInstruction: snapshot.config.prefill_system_instruction,
          prefillCachedHistory: snapshot.config.prefill_cached_history,
          enableDynamicGlossaryInjection: snapshot.config.enable_dynamic_glossary_injection,
          maxGlossaryEntriesPerChunkInjection: snapshot.config.max_glossary_entries_per_chunk_injection,
          maxGlossaryCharsPerChunkInjection: snapshot.config.max_glossary_chars_per_chunk_injection,
          glossaryExtractionPrompt: snapshot.config.glossary_extraction_prompt,
          enableImageAnnotation: snapshot.config.enable_image_annotation,
          epubMaxNodesPerChunk: snapshot.config.epub_max_nodes_per_chunk,
        });
      }

      // 2. 스토리 바이블 복원
      if (snapshot.story_bible) {
        setStoryBibleData(snapshot.story_bible);
        addLog('info', '📖 스토리 바이블 데이터가 복원되었습니다.');
      }

      // 3. 파일 정보 복원
      // 텍스트 모드는 source_text로 복구 가능.
      // EPUB은 파일 자체가 없으면 복구 불가능하므로, 이미 파일이 로드되어 있어야 함 (위의 무결성 검사 통과 시)
      const isEpub = snapshot.mode === 'epub';
      
      let fileContent: FileContent;
      
      if (inputFiles.length > 0) {
          // 이미 파일이 로드된 경우 (무결성 검사 통과), 해당 파일 정보 사용
          fileContent = inputFiles[0];
      } else {
          // 파일이 없는 경우, 스냅샷의 텍스트 데이터로 복구 (EPUB은 불가)
          if (isEpub) {
              addLog('warning', 'EPUB 스냅샷 복구 시에는 원본 EPUB 파일을 먼저 업로드해야 합니다.');
              return;
          }
          fileContent = {
            name: snapshot.source_info.file_name,
            content: snapshot.source_text || '',
            size: snapshot.source_info.file_size,
            lastModified: Date.now(),
            isEpub: false,
          };
      }

      // 4. 번역 결과 복원
      const restoredResults: TranslationResult[] = Object.entries(snapshot.translated_chunks).map(([indexStr, chunk]) => ({
        chunkIndex: parseInt(indexStr),
        originalText: chunk.original_text,
        translatedText: chunk.translated_text,
        translatedSegments: chunk.translated_segments,
        success: chunk.status === 'completed',
        error: chunk.status === 'failed' ? '이전 작업에서 실패함' : undefined
      }));

      // 진행 상황 복원
      const restoredProgress: TranslationJobProgress = {
        totalChunks: snapshot.progress.total_chunks,
        processedChunks: snapshot.progress.processed_chunks,
        successfulChunks: restoredResults.filter(r => r.success).length,
        failedChunks: restoredResults.filter(r => !r.success).length,
        currentStatusMessage: '작업 복원됨',
      };

      // 세션 복구 실행 (단일 파일이라고 가정, 실제로는 다중 파일 지원 확장 필요할 수 있음)
      restoreSession([fileContent], restoredResults, restoredProgress);
      addLog('info', `작업이 복원되었습니다: ${snapshot.source_info.file_name} (${restoredResults.length} 청크)`);

      return {
        mode: snapshot.mode || 'text',
        epubChapters: fileContent.epubChapters
      };

    } catch (error) {
      addLog('error', `스냅샷 불러오기 실패: ${error}`);
    }
  }, [updateConfig, restoreSession, addLog, setStoryBibleData, inputFiles]);

  // 결과 다운로드 (텍스트)
  const downloadResult = useCallback(() => {
    if (!translatedText) {
      addLog('warning', '다운로드할 번역 결과가 없습니다.');
      return;
    }
    
    const fileName = inputFiles.length > 0 
      ? `translated_${inputFiles[0].name}`
      : `translation_${new Date().toISOString().slice(0, 10)}.txt`;
      
    FileHandler.downloadTextFile(translatedText, fileName);
    addLog('info', `번역 결과가 다운로드되었습니다: ${fileName}`);
  }, [translatedText, inputFiles, addLog]);

  return {
    inputFiles,
    isRunning,
    isPaused,
    progress,
    results,
    hasResults: results.length > 0,
    hasFailedChunks: results.some(r => !r.success),
    canStart: inputFiles.length > 0 && !isRunning,
    canStop: isRunning,
    executeTranslation,
    cancelTranslation,
    retryFailedChunks,
    retrySingleChunk,
    createSnapshot,
    exportSnapshot,
    importSnapshot,
    downloadResult,
  };
}
