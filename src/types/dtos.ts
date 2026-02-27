
// types/dtos.ts
// Python core/dtos.py 의 TypeScript 변환

/**
 * 사용 가능한 API 모델 정보
 */
export interface ModelInfo {
  name: string;           
  displayName: string;    
  description?: string;
  version?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
}

/**
 * 개별 청크의 번역 상태
 */
export type ChunkStatusType = 'pending' | 'processing' | 'completed' | 'failed';

export interface TranslationChunkStatus {
  chunkIndex: number;
  status: ChunkStatusType;
  errorMessage?: string;
  translatedContentPreview?: string;
}

/**
 * 전체 번역 작업의 진행 상황
 */
export interface TranslationJobProgress {
  totalChunks: number;
  processedChunks: number;
  successfulChunks: number;
  failedChunks: number;
  currentStatusMessage: string;
  currentChunkProcessing?: number;
  lastErrorMessage?: string;
  etaSeconds?: number; 
}

/**
 * 용어집 항목
 */
export interface GlossaryEntry {
  keyword: string;
  translatedKeyword: string;
  targetLanguage: string;
  occurrenceCount: number;
  id?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * 스토리 바이블 인물 설정 (세분화됨)
 */
export interface CharacterSetting {
  id: string;
  name: string;
  role: string;
  personality: string;
  speakingStyle: string;
  relationships: string; // 인물 관계
  notes: string;         // 추가 메모/말버릇 등
  isActive: boolean;     // 주입 여부 선택
}

/**
 * 스토리 바이블 세계관 설정 (세분화됨)
 */
export interface WorldSetting {
  id: string;
  category: string;      // 지리, 마법체계, 경제, 조직 등
  title: string;
  content: string;
  isActive: boolean;
}

/**
 * 스토리 바이블 전체 구조 (고도화됨)
 */
export interface StoryBibleData {
  characters: CharacterSetting[];
  worldSettings: WorldSetting[];
  plotSummary: string;
  styleGuide: string;
}

/**
 * 번역 실행 시 필요한 문맥 정보
 */
export interface TranslationContext {
  glossaryEntries: GlossaryEntry[];
  storyBible?: StoryBibleData; 
}

/**
 * 용어집 추출 작업 진행 상황
 */
export interface GlossaryExtractionProgress {
  totalSegments: number;
  processedSegments: number;
  currentStatusMessage: string;
  extractedEntriesCount: number;
  etaSeconds?: number; 
}

/**
 * 스토리 바이블 추출 작업 진행 상황
 */
export interface StoryBibleExtractionProgress {
  totalSteps: number;
  processedSteps: number;
  currentStatusMessage: string;
  etaSeconds?: number;
}

/**
 * 번역 결과
 */
export interface TranslationResult {
  chunkIndex: number;
  originalText: string;
  translatedText: string;
  translatedSegments?: string[]; 
  success: boolean;
  error?: string;
}

/**
 * 품질 이슈 타입
 */
export type QualityIssueType = 'omission' | 'hallucination';

/**
 * 품질 검사 이슈
 */
export interface QualityIssue {
  chunkIndex: number;
  issueType: QualityIssueType;
  zScore: number;
  ratio: number;
}

/**
 * 파일 내용
 */
export interface FileContent {
  name: string;
  content: string;
  size: number;
  lastModified: number;
  epubFile?: File;           
  epubChapters?: any[];      
  isEpub?: boolean;          
}

/**
 * 로그 항목
 */
export interface LogEntry {
  level: 'info' | 'warning' | 'error' | 'debug';
  message: string;
  timestamp: Date;
}

/**
 * EPUB 구조 정보
 */
export interface EpubStructureMetadata {
  chapters: {
    id: string;
    filename: string;
    nodeCount: number;
  }[];
}

/**
 * 스냅샷 데이터 구조
 */
export interface TranslationSnapshot {
  meta: {
    version: string;
    created_at: string;
    app_version: string;
  };
  source_info: {
    file_name: string;
    file_size: number;
  };
  // [NEW] 파일 무결성 검증을 위한 지문
  source_fingerprint?: string; 
  config: any;
  mode?: 'text' | 'epub';
  source_text: string;
  progress: {
    total_chunks: number;
    processed_chunks: number;
  };
  translated_chunks: Record<string, any>;
  epub_structure?: EpubStructureMetadata;
  epub_binary?: string;
  story_bible?: StoryBibleData; 
}
