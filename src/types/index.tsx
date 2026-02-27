
// types/index.ts
// 타입 정의 통합 export

export type {
  ModelInfo,
  ChunkStatusType,
  TranslationChunkStatus,
  TranslationJobProgress,
  GlossaryEntry,
  GlossaryExtractionProgress,
  TranslationResult,
  QualityIssueType,
  QualityIssue,
  FileContent,
  LogEntry,
  // [추가] 스토리 바이블 타입 export
  StoryBibleData,
  CharacterSetting,
  WorldSetting,
  StoryBibleExtractionProgress,
} from './dtos';

export type {
  PrefillHistoryItem,
  AppConfig,
} from './config';

export {
  DEFAULT_PREFILL_SYSTEM_INSTRUCTION,
  DEFAULT_PREFILL_CACHED_HISTORY,
  DEFAULT_PROMPTS,
  DEFAULT_GLOSSARY_EXTRACTION_PROMPT,
  DEFAULT_STORY_BIBLE_EXTRACTION_PROMPT,
  DEFAULT_STORY_BIBLE_REFINE_PROMPT, // [추가]
  DEFAULT_GLOSSARY_PREFILL_SYSTEM_INSTRUCTION, // [추가]
  DEFAULT_GLOSSARY_PREFILL_CACHED_HISTORY, // [추가]
  defaultConfig,
  loadConfig,
  saveConfig,
  exportConfig,
  importConfig,
} from './config';
