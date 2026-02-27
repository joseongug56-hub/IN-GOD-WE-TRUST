
// stores/storyBibleStore.ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { StoryBibleData, CharacterSetting, WorldSetting, StoryBibleExtractionProgress } from '../types/dtos';
import { IndexedDBHandler } from '../utils/indexedDBHandler';

interface StoryBibleState {
  data: StoryBibleData | null;
  isExtracting: boolean;
  extractionProgress: StoryBibleExtractionProgress | null;
  
  // [추가] 이어하기를 위한 큐 상태
  extractionQueue: string[];
  initialTotalSegments: number;

  // 액션
  setData: (data: StoryBibleData | null) => void;
  mergeData: (newData: StoryBibleData) => void;
  updateGlobal: (updates: Partial<Pick<StoryBibleData, 'plotSummary' | 'styleGuide'>>) => void;
  
  // 인물 관리
  addCharacter: (char: Omit<CharacterSetting, 'id' | 'isActive'>) => void;
  updateCharacter: (id: string, updates: Partial<CharacterSetting>) => void;
  removeCharacter: (id: string) => void;
  toggleCharacter: (id: string) => void;
  
  // 세계관 관리
  addWorldSetting: (setting: Omit<WorldSetting, 'id' | 'isActive'>) => void;
  updateWorldSetting: (id: string, updates: Partial<WorldSetting>) => void;
  removeWorldSetting: (id: string) => void;
  toggleWorldSetting: (id: string) => void;

  setExtracting: (val: boolean) => void;
  updateExtractionProgress: (progress: StoryBibleExtractionProgress | null) => void;
  clear: () => void;

  // [추가] 큐 관리 액션
  setExtractionQueue: (queue: string[], total: number) => void;
  clearExtractionQueue: () => void;

  exportToJson: () => string;
  importFromJson: (json: string, merge?: boolean) => boolean;
}

export const useStoryBibleStore = create<StoryBibleState>()(
  persist(
    (set, get) => ({
      data: null,
      isExtracting: false,
      extractionProgress: null,
      
      // [추가] 초기 상태
      extractionQueue: [],
      initialTotalSegments: 0,
      
      setData: (data) => set({ data }),

      mergeData: (newData) => set((state) => {
        const current = state.data || { characters: [], worldSettings: [], plotSummary: '', styleGuide: '' };
        
        const charMap = new Map<string, CharacterSetting>();
        current.characters.forEach(c => charMap.set(c.name, c));
        newData.characters.forEach(nc => {
          if (charMap.has(nc.name)) {
            const existing = charMap.get(nc.name)!;
            charMap.set(nc.name, {
              ...existing,
              role: nc.role || existing.role,
              personality: nc.personality.length > existing.personality.length ? nc.personality : existing.personality,
              relationships: existing.relationships.includes(nc.relationships) ? existing.relationships : `${existing.relationships}; ${nc.relationships}`,
              notes: existing.notes.includes(nc.notes) ? existing.notes : `${existing.notes}\n${nc.notes}`.trim()
            });
          } else {
            charMap.set(nc.name, { ...nc, id: crypto.randomUUID() });
          }
        });

        const worldMap = new Map<string, WorldSetting>();
        current.worldSettings.forEach(w => worldMap.set(`${w.category}:${w.title}`, w));
        newData.worldSettings.forEach(nw => {
          const key = `${nw.category}:${nw.title}`;
          if (worldMap.has(key)) {
            const existing = worldMap.get(key)!;
            worldMap.set(key, {
              ...existing,
              content: existing.content.length > nw.content.length ? existing.content : nw.content
            });
          } else {
            worldMap.set(key, { ...nw, id: crypto.randomUUID() });
          }
        });

        const plotSummary = current.plotSummary === newData.plotSummary ? current.plotSummary : `${current.plotSummary}\n\n[추가내용]\n${newData.plotSummary}`.trim();
        const styleGuide = newData.styleGuide || current.styleGuide;

        return {
          data: {
            characters: Array.from(charMap.values()),
            worldSettings: Array.from(worldMap.values()),
            plotSummary,
            styleGuide
          }
        };
      }),

      updateGlobal: (updates) => set((state) => ({
        data: state.data ? { ...state.data, ...updates } : null
      })),

      addCharacter: (char) => set((state) => {
        const newData = state.data || { characters: [], worldSettings: [], plotSummary: '', styleGuide: '' };
        const newChar: CharacterSetting = { ...char, id: crypto.randomUUID(), isActive: true };
        return { data: { ...newData, characters: [...newData.characters, newChar] } };
      }),
      updateCharacter: (id, updates) => set((state) => {
        if (!state.data) return state;
        return { data: { ...state.data, characters: state.data.characters.map(c => c.id === id ? { ...c, ...updates } : c) } };
      }),
      removeCharacter: (id) => set((state) => {
        if (!state.data) return state;
        return { data: { ...state.data, characters: state.data.characters.filter(c => c.id !== id) } };
      }),
      toggleCharacter: (id) => set((state) => {
        if (!state.data) return state;
        return { data: { ...state.data, characters: state.data.characters.map(c => c.id === id ? { ...c, isActive: !c.isActive } : c) } };
      }),

      addWorldSetting: (setting) => set((state) => {
        const newData = state.data || { characters: [], worldSettings: [], plotSummary: '', styleGuide: '' };
        const newSetting: WorldSetting = { ...setting, id: crypto.randomUUID(), isActive: true };
        return { data: { ...newData, worldSettings: [...newData.worldSettings, newSetting] } };
      }),
      updateWorldSetting: (id, updates) => set((state) => {
        if (!state.data) return state;
        return { data: { ...state.data, worldSettings: state.data.worldSettings.map(w => w.id === id ? { ...w, ...updates } : w) } };
      }),
      removeWorldSetting: (id) => set((state) => {
        if (!state.data) return state;
        return { data: { ...state.data, worldSettings: state.data.worldSettings.filter(w => w.id !== id) } };
      }),
      toggleWorldSetting: (id) => set((state) => {
        if (!state.data) return state;
        return { data: { ...state.data, worldSettings: state.data.worldSettings.map(w => w.id === id ? { ...w, isActive: !w.isActive } : w) } };
      }),

      setExtracting: (isExtracting) => set({ isExtracting }),
      updateExtractionProgress: (extractionProgress) => set({ extractionProgress }),
      
      // [추가] 큐 초기화 구현
      setExtractionQueue: (queue, total) => set({ extractionQueue: queue, initialTotalSegments: total }),
      clearExtractionQueue: () => set({ extractionQueue: [], initialTotalSegments: 0 }),
      
      clear: () => set({ data: null, extractionProgress: null, extractionQueue: [], initialTotalSegments: 0 }),

      exportToJson: () => {
        const { data } = get();
        return JSON.stringify(data, null, 2);
      },

      importFromJson: (json, merge = false) => {
        try {
          const parsed = JSON.parse(json);
          if (parsed && (Array.isArray(parsed.characters) || Array.isArray(parsed.worldSettings))) {
            if (merge) {
              get().mergeData(parsed);
            } else {
              set({ data: parsed });
            }
            return true;
          }
          return false;
        } catch (e) {
          console.error('Story Bible Import Error:', e);
          return false;
        }
      }
    }),
    { 
      name: 'btg-story-bible',
      storage: createJSONStorage(() => IndexedDBHandler.zustandStorage), // LocalStorage -> IndexedDB로 변경
      // [추가] 큐 상태도 저장
      partialize: (state) => ({ 
        data: state.data,
        extractionQueue: state.extractionQueue,
        initialTotalSegments: state.initialTotalSegments
      })
    }
  )
);
