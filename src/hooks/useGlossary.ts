
// hooks/useGlossary.ts
// 용어집 기능을 위한 커스텀 훅

import { useCallback, useRef, useEffect } from 'react';
import { useGlossaryStore } from '../stores/glossaryStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useTranslationStore } from '../stores/translationStore';
import { GlossaryService } from '../services/GlossaryService';
import { ChunkService } from '../services/ChunkService'; // [추가] ChunkService 임포트
import type { GlossaryExtractionProgress, GlossaryEntry } from '../types/dtos';

/**
 * 용어집 기능을 제공하는 커스텀 훅
 * GlossaryService와 스토어를 연결합니다.
 */
export function useGlossary() {
  // 스토어 상태
  const { config } = useSettingsStore();
  const { inputFiles } = useTranslationStore();
  const {
    entries,
    isExtracting,
    extractionProgress,
    startExtraction,
    stopExtraction,
    updateExtractionProgress,
    mergeEntries,
    setEntries,
    clearEntries,
    exportToJson,
    importFromJson,
    // [추가] 큐 관련 상태 및 액션
    extractionQueue,
    initialTotalSegments,
    setExtractionQueue,
    clearExtractionQueue
  } = useGlossaryStore();

  // 로그 추가 함수
  const { addLog } = useTranslationStore();

  // 서비스 인스턴스 참조
  const serviceRef = useRef<GlossaryService | null>(null);
  const isExtractingRef = useRef(false);

  // 서비스 초기화 또는 업데이트
  const getOrCreateService = useCallback((): GlossaryService => {
    if (!serviceRef.current) {
      serviceRef.current = new GlossaryService(config);
      
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

  // 용어집 추출 시작 (resume 파라미터 추가)
  const executeExtraction = useCallback(async (sourceText?: string, resume: boolean = false) => {
    if (isExtractingRef.current) {
      addLog('warning', '이미 용어집 추출이 진행 중입니다.');
      return;
    }

    // 사용할 세그먼트 큐 준비
    let segmentsToProcess: string[] = [];
    let totalSegmentsForProgress = 0;

    // 1. 이어하기 모드
    if (resume && extractionQueue.length > 0) {
      segmentsToProcess = extractionQueue;
      totalSegmentsForProgress = initialTotalSegments > 0 ? initialTotalSegments : extractionQueue.length;
      addLog('info', `🔄 이전에 중단된 작업 ${segmentsToProcess.length}개 세그먼트를 이어합니다.`);
    } 
    // 2. 새로 시작 모드
    else {
      // 소스 텍스트 결정
      let textToAnalyze = sourceText;
      
      if (!textToAnalyze) {
        if (inputFiles.length === 0) {
          addLog('warning', '분석할 텍스트가 없습니다. 파일을 업로드하거나 텍스트를 입력하세요.');
          return;
        }

        const extractedTexts = inputFiles.map(f => {
          if (f.isEpub && f.epubChapters && f.epubChapters.length > 0) {
            return f.epubChapters
              .flatMap((ch: any) => ch.nodes)
              .filter((n: any) => n.type === 'text' && n.content)
              .map((n: any) => n.content)
              .join('\n');
          }
          return f.content;
        });

        textToAnalyze = extractedTexts.join('\n\n');

        if (!textToAnalyze.trim()) {
          addLog('warning', '분석할 텍스트 내용이 비어있습니다 (EPUB 파일이 로드되지 않았거나 텍스트가 없음).');
          return;
        }
      }

      // 새 작업이므로 텍스트 분할 및 샘플링 수행
      // [수정] GlossaryService 내부 private 메소드인 selectSampleSegments를 사용할 수 없으므로,
      // 여기서 직접 ChunkService를 이용해 분할하고 샘플링 로직을 구현하거나, 
      // 서비스를 통해 샘플링된 목록을 받아와야 함.
      // 하지만 가장 깔끔한 방법은: 
      // 1. Chunking 2. Sampling을 여기서 수행하고 3. Queue에 저장하는 것.
      
      const chunkService = new ChunkService(config.glossaryChunkSize || config.chunkSize || 8000);
      const allSegments = chunkService.createChunksFromFileContent(textToAnalyze, config.glossaryChunkSize);
      
      // 샘플링 로직 (Fisher-Yates)
      const samplingRatio = (config.glossarySamplingRatio || 10) / 100;
      const sampleSize = Math.max(1, Math.floor(allSegments.length * samplingRatio));
      
      const indices = Array.from({ length: allSegments.length }, (_, i) => i);
      for (let i = allSegments.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      const selectedIndices = indices.slice(0, sampleSize).sort((a, b) => a - b);
      segmentsToProcess = selectedIndices.map(i => allSegments[i]);
      
      totalSegmentsForProgress = segmentsToProcess.length;
      
      // [중요] 큐 초기화 및 저장
      setExtractionQueue(segmentsToProcess, totalSegmentsForProgress);
      
      addLog('info', `용어집 추출 시작 (모델: ${config.modelName})`);
      addLog('info', `분석할 텍스트: ${textToAnalyze.length.toLocaleString()}자, 표본 세그먼트: ${segmentsToProcess.length}개`);
    }

    isExtractingRef.current = true;
    startExtraction();

    // 처리된 세그먼트 수를 추적하기 위한 변수
    let processedCountInThisRun = 0;

    try {
      const service = getOrCreateService();

      // 진행률 콜백 (Global Progress 계산)
      const onProgress = (progress: GlossaryExtractionProgress) => {
        processedCountInThisRun = progress.processedSegments;
        
        // 전체 진행률 = (전체 - 현재큐길이) + 이번실행처리수
        const globalProcessed = (totalSegmentsForProgress - segmentsToProcess.length) + processedCountInThisRun;
        
        updateExtractionProgress({
          ...progress,
          totalSegments: totalSegmentsForProgress, // 전체 기준
          processedSegments: Math.min(globalProcessed, totalSegmentsForProgress)
        });
      };

      const stopCheck = () => !isExtractingRef.current;
      const seedEntries = entries.length > 0 ? entries : undefined;

      // 용어집 추출 실행 (preSelectedSegments 전달)
      const extractedEntries = await service.extractGlossary(
        "", // 텍스트는 큐가 있으면 무시됨
        onProgress,
        seedEntries,
        config.glossaryExtractionPrompt,
        stopCheck,
        segmentsToProcess // 큐 전달
      );

      if (extractedEntries.length > 0) {
        mergeEntries(extractedEntries);
        addLog('info', `용어집 추출 완료: ${extractedEntries.length}개 항목`);
      } else {
        addLog('warning', '추출된 용어집 항목이 없습니다.');
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      addLog('error', `용어집 추출 중 오류 발생: ${errorMessage}`);
      
      updateExtractionProgress({
        totalSegments: 0,
        processedSegments: 0,
        currentStatusMessage: `오류: ${errorMessage}`,
        extractedEntriesCount: entries.length,
      });
    } finally {
      // [중요] 중단 시점 저장 (Queue 업데이트)
      // processedCountInThisRun 만큼 큐 앞에서 제거
      const remainingSegments = segmentsToProcess.slice(processedCountInThisRun);
      
      if (remainingSegments.length > 0) {
        setExtractionQueue(remainingSegments, totalSegmentsForProgress);
        addLog('info', `작업이 중단되었습니다. 남은 ${remainingSegments.length}개 세그먼트는 대기열에 보존됩니다.`);
      } else {
        clearExtractionQueue(); // 완료되면 큐 비움
      }

      isExtractingRef.current = false;
      stopExtraction();
    }
  }, [
    inputFiles,
    config,
    entries,
    extractionQueue,
    initialTotalSegments,
    getOrCreateService,
    startExtraction,
    stopExtraction,
    updateExtractionProgress,
    mergeEntries,
    setExtractionQueue,
    clearExtractionQueue,
    addLog,
  ]);

  // 용어집 추출 중지
  const cancelExtraction = useCallback(() => {
    if (serviceRef.current) {
      serviceRef.current.requestStop();
    }
    // isExtractingRef.current = false; // 서비스가 멈추고 finally 블록에서 처리되도록 유도
    addLog('warning', '용어집 추출이 사용자에 의해 중단되었습니다. 잠시 후 멈춥니다...');
  }, [addLog]);

  // 용어집 JSON 다운로드
  const downloadGlossary = useCallback((filename?: string) => {
    if (entries.length === 0) {
      addLog('warning', '다운로드할 용어집이 없습니다.');
      return;
    }

    const json = exportToJson();
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || `glossary_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    addLog('info', `용어집이 다운로드되었습니다: ${a.download}`);
  }, [entries, exportToJson, addLog]);

  // 용어집 CSV 다운로드
  const downloadGlossaryCsv = useCallback((filename?: string) => {
    if (entries.length === 0) {
      addLog('warning', '다운로드할 용어집이 없습니다.');
      return;
    }

    const sortedEntries = [...entries].sort((a, b) => {
      if (b.occurrenceCount !== a.occurrenceCount) {
        return b.occurrenceCount - a.occurrenceCount;
      }
      return a.keyword.localeCompare(b.keyword);
    });

    const headers = ['keyword', 'translatedKeyword', 'targetLanguage', 'occurrenceCount'];
    const csvRows = [headers.join(',')];
    
    for (const entry of sortedEntries) {
      const row = [
        `"${entry.keyword.replace(/"/g, '""')}"`,
        `"${entry.translatedKeyword.replace(/"/g, '""')}"`,
        entry.targetLanguage,
        entry.occurrenceCount.toString(),
      ];
      csvRows.push(row.join(','));
    }

    const csv = csvRows.join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || `glossary_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    addLog('info', `용어집 CSV가 다운로드되었습니다: ${a.download}`);
  }, [entries, addLog]);

  // 용어집 파일 가져오기
  const importGlossaryFile = useCallback(async () => {
    try {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,.csv';
      
      return new Promise<boolean>((resolve) => {
        input.onchange = async (e) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (!file) {
            resolve(false);
            return;
          }

          try {
            const content = await file.text();
            
            if (file.name.endsWith('.json')) {
              const success = importFromJson(content);
              if (success) {
                addLog('info', `용어집 JSON 파일을 가져왔습니다: ${file.name}`);
              } else {
                addLog('error', '용어집 JSON 파일 파싱 실패');
              }
              resolve(success);
            } else if (file.name.endsWith('.csv')) {
              const lines = content.split('\n');
              if (lines.length < 2) {
                addLog('error', 'CSV 파일이 비어 있거나 헤더만 있습니다.');
                resolve(false);
                return;
              }

              const newEntries: GlossaryEntry[] = [];
              for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;

                const match = line.match(/^"([^"]*?)","([^"]*?)",([^,]+),(\d+)$/);
                if (match) {
                  newEntries.push({
                    keyword: match[1].replace(/""/g, '"'),
                    translatedKeyword: match[2].replace(/""/g, '"'),
                    targetLanguage: match[3],
                    occurrenceCount: parseInt(match[4]) || 0,
                  });
                }
              }

              if (newEntries.length > 0) {
                mergeEntries(newEntries);
                addLog('info', `CSV에서 ${newEntries.length}개 항목을 가져왔습니다: ${file.name}`);
                resolve(true);
              } else {
                addLog('error', 'CSV 파일에서 유효한 항목을 찾을 수 없습니다.');
                resolve(false);
              }
            } else {
              addLog('error', '지원하지 않는 파일 형식입니다.');
              resolve(false);
            }
          } catch (error) {
            addLog('error', `파일 읽기 실패: ${error}`);
            resolve(false);
          }
        };

        input.click();
      });
    } catch (error) {
      addLog('error', `파일 가져오기 실패: ${error}`);
      return false;
    }
  }, [importFromJson, mergeEntries, addLog]);

  // 용어집 초기화
  const resetGlossary = useCallback(() => {
    clearEntries();
    clearExtractionQueue(); // [추가] 큐도 초기화
    addLog('info', '용어집이 초기화되었습니다.');
  }, [clearEntries, clearExtractionQueue, addLog]);

  useEffect(() => {
    return () => {
      if (serviceRef.current) {
        serviceRef.current.requestStop();
      }
    };
  }, []);

  return {
    entries,
    isExtracting,
    extractionProgress,
    extractionQueue, // [추가]
    executeExtraction,
    cancelExtraction,
    downloadGlossary,
    downloadGlossaryCsv,
    importGlossaryFile,
    resetGlossary,
    canExtract: inputFiles.length > 0 && !isExtracting,
    canStop: isExtracting,
    hasEntries: entries.length > 0,
    entryCount: entries.length,
  };
}
