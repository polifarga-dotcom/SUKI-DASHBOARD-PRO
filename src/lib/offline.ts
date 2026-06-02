/**
 * Offline resilience for logbook entries
 *
 * When network is unavailable, log entries are queued to IndexedDB.
 * On reconnect, they're synced to Supabase automatically.
 */

import type { LogEntry } from './types';

const DB_NAME = 'suki_dashboard_pro';
const DB_VERSION = 1;
const STORE_NAME = 'pending_log_entries';

type PendingEntry = {
  id: string;
  boat_id: string;
  entry: Omit<LogEntry, 'id' | 'created_at'>;
  queued_at: number; // epoch ms
  retry_count: number;
};

let db: IDBDatabase | null = null;

/**
 * Initialize IndexedDB
 */
async function initDB(): Promise<IDBDatabase> {
  if (db) return db;

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onerror = () => reject(new Error('Failed to open IndexedDB'));
    req.onsuccess = () => {
      db = req.result;
      resolve(db);
    };

    req.onupgradeneeded = (e) => {
      const database = (e.target as IDBOpenDBRequest).result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('boat_id_timestamp', ['boat_id', 'queued_at'], { unique: false });
      }
    };
  });
}

/**
 * Queue a log entry to IndexedDB (called when Supabase insert fails due to offline)
 */
export async function queueLogEntry(
  entry: Omit<LogEntry, 'id' | 'created_at'>,
  boatId: string
): Promise<string> {
  const database = await initDB();
  const id = crypto.randomUUID();

  const pending: PendingEntry = {
    id,
    boat_id: boatId,
    entry,
    queued_at: Date.now(),
    retry_count: 0,
  };

  return new Promise((resolve, reject) => {
    const tx = database.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.add(pending);

    req.onerror = () => reject(new Error('Failed to queue entry'));
    req.onsuccess = () => resolve(id);
  });
}

/**
 * Get count of pending entries for a boat
 */
export async function getPendingCount(boatId?: string): Promise<number> {
  const database = await initDB();

  return new Promise((resolve, reject) => {
    const tx = database.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);

    let req;
    if (boatId) {
      const index = store.index('boat_id_timestamp');
      req = index.count(IDBKeyRange.bound([boatId], [boatId + '￿']));
    } else {
      req = store.count();
    }

    req.onerror = () => reject(new Error('Failed to get pending count'));
    req.onsuccess = () => resolve(req.result);
  });
}

/**
 * Sync pending entries to Supabase
 */
export async function syncPendingEntries(
  supabase: any,
  boatId: string
): Promise<{ synced: number; failed: number; errorMsg?: string }> {
  const database = await initDB();

  // Get all pending entries for this boat
  const pending = await new Promise<PendingEntry[]>((resolve, reject) => {
    const tx = database.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('boat_id_timestamp');
    const req = index.getAll(IDBKeyRange.bound([boatId], [boatId + '￿']));

    req.onerror = () => reject(new Error('Failed to get pending entries'));
    req.onsuccess = () => resolve(req.result);
  });

  if (pending.length === 0) return { synced: 0, failed: 0 };

  let synced = 0;
  let failed = 0;

  for (const p of pending) {
    try {
      const { data } = await supabase
        .from('log_entries')
        .insert(p.entry)
        .select('id')
        .single();

      if (data) {
        // Success — remove from queue
        await deleteQueuedEntry(p.id);
        synced++;
      } else {
        failed++;
      }
    } catch (err: any) {
      console.error(`[offline] Failed to sync entry ${p.id}:`, err.message);
      failed++;

      // Increment retry count; if >= 3, delete the entry (give up)
      p.retry_count++;
      if (p.retry_count >= 3) {
        await deleteQueuedEntry(p.id);
        console.log(`[offline] Deleted entry ${p.id} after 3 failed retries`);
      } else {
        // Update retry count in DB
        await updateQueuedEntryRetry(p.id, p.retry_count);
      }
    }
  }

  return { synced, failed };
}

/**
 * Delete a queued entry (called after successful sync or giving up)
 */
async function deleteQueuedEntry(id: string): Promise<void> {
  const database = await initDB();

  return new Promise((resolve, reject) => {
    const tx = database.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(id);

    req.onerror = () => reject(new Error('Failed to delete queued entry'));
    req.onsuccess = () => resolve();
  });
}

/**
 * Update retry count on a queued entry
 */
async function updateQueuedEntryRetry(id: string, retryCount: number): Promise<void> {
  const database = await initDB();

  return new Promise((resolve, reject) => {
    const tx = database.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);

    req.onerror = () => reject(new Error('Failed to update retry count'));
    req.onsuccess = () => {
      const pending = req.result as PendingEntry;
      pending.retry_count = retryCount;
      const updateReq = store.put(pending);
      updateReq.onsuccess = () => resolve();
    };
  });
}

/**
 * Subscribe to online/offline events
 */
export function subscribeToOnline(callback: (online: boolean) => void): () => void {
  const handleOnline = () => callback(true);
  const handleOffline = () => callback(false);

  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);

  // Call immediately with current status
  callback(navigator.onLine);

  // Return unsubscribe function
  return () => {
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
  };
}
