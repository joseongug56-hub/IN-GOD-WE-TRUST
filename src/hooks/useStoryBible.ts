
// hooks/useStoryBible.ts
import { useCallback, useRef } from 'react';
import { useStoryBibleStore } from '../stores/storyBibleStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useTranslationStore } from '../stores/translationStore';
import { useGlossaryStore } from '../stores/glossaryStore';
import { StoryBibleService } from '../services/StoryBibleService';
import { FileHandler } from '../utils/fileHandler';
import type { StoryBibleExtractionProgress } from '../types/dtos';

export function useStoryBible() {
  const { config } = useSettingsStore();
  const { inputFiles, addLog } = useTranslationStore();
  const { entries: glossaryEntries } = useGlossaryStore();
  const bibleStore = useStoryBibleStore();
  const serviceRef = useRef<StoryBibleService | null>(null);

  const executeExtraction = useCallback(async (sourceText?: string, incremental: boolean = false, resume: boolean = false) => {
    // 1. 세그먼트 준비
    let segmentsToProcess: string[] = [];
    let totalSegmentsForProgress = 0;

    if (!serviceRef.current) {
        serviceRef.current = new StoryBibleService(config);
        serviceRef.current.setLogCallback((entry) => addLog(entry.level, entry.message));
    }
    const service = serviceRef.current;

    // 이어하기 모드
    if (resume && bibleStore.extractionQueue.length > 0) {
        segmentsToProcess = bibleStore.extractionQueue;
        totalSegmentsForProgress = bibleStore.initialTotalSegments || segmentsToProcess.length;
        addLog('info', `🔄 이전에 중단된 분석 작업 ${segmentsToProcess.length}개를 이어합니다.`);
    } 
    // 새로 시작 모드
    else {
        let textToAnalyze = sourceText;
        if (!textToAnalyze) {
            if (inputFiles.length === 0) {
                addLog('warning', '분석할 파일을 먼저 업로드하거나 텍스트를 입력하세요.');
                return;
            }
            textToAnalyze = inputFiles.map(f => f.content).join('\n\n');
        }

        if (!textToAnalyze?.trim()) {
            addLog('warning', '분석할 텍스트가 비어있습니다.');
            return;
        }

        // 서비스의 헬퍼 메서드로 샘플링 수행
        segmentsToProcess = service.getSampleSegments(textToAnalyze);
        totalSegmentsForProgress = segmentsToProcess.length;
        
        // 큐 초기화 및 저장
        bibleStore.setExtractionQueue(segmentsToProcess, totalSegmentsForProgress);
        addLog('info', `총 ${totalSegmentsForProgress}개 세그먼트를 분석 대기열에 등록했습니다.`);
    }

    bibleStore.setExtracting(true);
    bibleStore.updateExtractionProgress(null);
    
    if (!resume) {
        addLog('info', incremental ? '🔄 기존 설정을 유지하며 추가 정보를 증분 분석합니다...' : '🔍 새로운 스토리 바이블을 추출합니다...');
    }

    let processedCountInThisRun = 0;

    try {
      const glossaryContext = glossaryEntries.length > 0 
        ? glossaryEntries.map(e => `- ${e.keyword}: ${e.translatedKeyword}`).join('\n')
        : undefined;

      const existingData = incremental && bibleStore.data ? bibleStore.data : undefined;
      
      const onProgress = (p: StoryBibleExtractionProgress) => {
        processedCountInThisRun = p.processedSteps; // 현재 실행에서의 진행 수
        
        // 전체 진행률 = (전체 - 현재큐길이) + 이번실행처리수
        // Note: p.processedSteps는 현재 segments 배열 내의 인덱스임
        const globalProcessed = (totalSegmentsForProgress - segmentsToProcess.length) + processedCountInThisRun;
        
        bibleStore.updateExtractionProgress({
            ...p,
            totalSteps: totalSegmentsForProgress,
            processedSteps: globalProcessed
        });
      };

      // 서비스 호출 (직접 세그먼트 배열 전달)
      const extractedData = await service.extractStoryBible(segmentsToProcess, glossaryContext, existingData, onProgress);
      
      // 성공적으로 완료된 경우
      if (incremental || resume) {
        bibleStore.mergeData(extractedData);
        addLog('info', '✅ 데이터 병합 완료.');
      } else {
        bibleStore.setData(extractedData);
        addLog('info', '✅ 새로운 스토리 바이블 생성 완료.');
      }
      
      // 큐 비우기
      bibleStore.clearExtractionQueue();

    } catch (error) {
      addLog('error', `추출 중단/실패: ${error}`);
    } finally {
      // [중요] 중단 시 큐 업데이트
      // 서비스 루프가 중단되면 processedCountInThisRun 만큼은 처리된 것임 (또는 에러 발생 직전까지)
      // StoryBibleService는 예외 발생 전까지 수집된 데이터를 반환하지 않고 throw하므로,
      // 서비스 내부에서 partial result를 반환하도록 수정했거나, 여기서 queue 관리를 해야 함.
      // 서비스가 throw error를 하더라도, processedCountInThisRun은 업데이트 되었음.
      
      // processedCountInThisRun 만큼 큐 앞에서 제거
      if (processedCountInThisRun < segmentsToProcess.length) {
          const remainingSegments = segmentsToProcess.slice(processedCountInThisRun);
          if (remainingSegments.length > 0) {
              bibleStore.setExtractionQueue(remainingSegments, totalSegmentsForProgress);
              addLog('info', `작업이 중단되었습니다. 남은 ${remainingSegments.length}개 세그먼트는 대기열에 보존됩니다.`);
          }
      } else {
          bibleStore.clearExtractionQueue();
      }

      bibleStore.setExtracting(false);
      bibleStore.updateExtractionProgress(null);
    }
  }, [config, inputFiles, addLog, glossaryEntries, bibleStore]);

  const cancelExtraction = useCallback(() => {
      if (serviceRef.current) {
          serviceRef.current.requestStop();
          addLog('warning', '스토리 바이블 추출 중단을 요청했습니다. 잠시 후 멈춥니다...');
      }
  }, [addLog]);

  const downloadBible = useCallback(() => {
    const json = bibleStore.exportToJson();
    if (json === 'null') {
      addLog('warning', '내보낼 데이터가 없습니다.');
      return;
    }
    const fileName = `story_bible_${new Date().toISOString().slice(0, 10)}.json`;
    FileHandler.downloadTextFile(json, fileName, 'application/json');
    addLog('info', `스토리 바이블을 내보냈습니다: ${fileName}`);
  }, [bibleStore, addLog]);

  const importBibleFile = useCallback(async (merge: boolean = false) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        const content = await file.text();
        const success = bibleStore.importFromJson(content, merge);
        if (success) {
          addLog('info', `스토리 바이블 파일을 ${merge ? '병합' : '가져오기'} 했습니다: ${file.name}`);
        } else {
          addLog('error', '유효하지 않은 스토리 바이블 파일 형식입니다.');
        }
      } catch (error) {
        addLog('error', `파일 읽기 실패: ${error}`);
      }
    };
    input.click();
  }, [bibleStore, addLog]);

  return {
    ...bibleStore,
    executeExtraction,
    cancelExtraction,
    downloadBible,
    importBibleFile
  };
}
