
/**
 * IndexedDB 핸들러 유틸리티
 * * 목적: AI Studio 샌드박스 환경(iframe) 내에서 대용량 데이터(스냅샷, 스토어 상태)를
 * 영구 저장하기 위한 IndexedDB 래퍼 클래스입니다.
 * * 주요 기능:
 * - 스냅샷 저장 (Auto-save)
 * - Zustand Store Persist Adapter (LocalStorage 대체)
 * * 특징:
 * - 외부 라이브러리 없이 네이티브 API 사용 (Zero Dependency)
 * - Promise 기반 비동기 처리
 */

import { StateStorage } from 'zustand/middleware';

export class IndexedDBHandler {
  private static readonly DB_NAME = 'BTG_Database';
  private static readonly SNAPSHOT_STORE = 'autosave_store';
  private static readonly KEYVAL_STORE = 'keyval_store'; // Zustand용 저장소
  private static readonly SNAPSHOT_KEY = 'latest_snapshot';
  private static readonly VERSION = 2; // 버전 업그레이드 (1 -> 2)

  /**
   * DB 연결을 엽니다.
   */
  private static openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error("이 브라우저는 IndexedDB를 지원하지 않습니다."));
        return;
      }

      const request = window.indexedDB.open(this.DB_NAME, this.VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        
        // 스냅샷 저장소 (v1)
        if (!db.objectStoreNames.contains(this.SNAPSHOT_STORE)) {
          db.createObjectStore(this.SNAPSHOT_STORE);
        }

        // 키-밸류 저장소 (v2) - Zustand Persistence용
        if (!db.objectStoreNames.contains(this.KEYVAL_STORE)) {
          db.createObjectStore(this.KEYVAL_STORE);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 트랜잭션 헬퍼
   */
  private static async transaction<T>(
    storeName: string,
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T> | void
  ): Promise<T> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      
      const request = operation(store);

      transaction.oncomplete = () => {
        // request가 있고 result가 있으면 반환
        resolve((request as IDBRequest<T>)?.result);
      };

      transaction.onerror = () => reject(transaction.error);
      if (request) {
        request.onerror = () => reject(request.error);
      }
    });
  }

  /**
   * 스냅샷 데이터를 저장합니다.
   */
  static async saveSnapshot(data: any): Promise<void> {
    try {
      await this.transaction(this.SNAPSHOT_STORE, 'readwrite', (store) => 
        store.put(data, this.SNAPSHOT_KEY)
      );
    } catch (error) {
      console.warn('[IndexedDB] 스냅샷 저장 실패:', error);
    }
  }

  /**
   * 저장된 스냅샷을 불러옵니다.
   */
  static async loadSnapshot(): Promise<any | null> {
    try {
      return await this.transaction(this.SNAPSHOT_STORE, 'readonly', (store) => 
        store.get(this.SNAPSHOT_KEY)
      );
    } catch (error) {
      console.warn('[IndexedDB] 스냅샷 로드 실패:', error);
      return null;
    }
  }

  /**
   * 저장된 스냅샷을 삭제합니다.
   */
  static async clearSnapshot(): Promise<void> {
    try {
      await this.transaction(this.SNAPSHOT_STORE, 'readwrite', (store) => 
        store.delete(this.SNAPSHOT_KEY)
      );
    } catch (error) {
      console.warn('[IndexedDB] 스냅샷 삭제 실패:', error);
    }
  }

  /**
   * Zustand StateStorage 구현체
   * createJSONStorage와 함께 사용하여 LocalStorage 대신 IndexedDB를 사용하도록 합니다.
   */
  static readonly zustandStorage: StateStorage = {
    getItem: async (name: string): Promise<string | null> => {
      try {
        const value = await IndexedDBHandler.transaction(
          IndexedDBHandler.KEYVAL_STORE, 
          'readonly', 
          (store) => store.get(name)
        );
        return (value as string) || null;
      } catch (e) {
        console.warn(`[IndexedDB] getItem error (${name}):`, e);
        return null;
      }
    },
    setItem: async (name: string, value: string): Promise<void> => {
      try {
        await IndexedDBHandler.transaction(
          IndexedDBHandler.KEYVAL_STORE, 
          'readwrite', 
          (store) => store.put(value, name)
        );
      } catch (e) {
        console.warn(`[IndexedDB] setItem error (${name}):`, e);
      }
    },
    removeItem: async (name: string): Promise<void> => {
      try {
        await IndexedDBHandler.transaction(
          IndexedDBHandler.KEYVAL_STORE, 
          'readwrite', 
          (store) => store.delete(name)
        );
      } catch (e) {
        console.warn(`[IndexedDB] removeItem error (${name}):`, e);
      }
    },
  };
}
