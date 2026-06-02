import { writable } from 'svelte/store';

/**
 * Reactive stores for offline state UI
 */

export const isOnline = writable<boolean>(typeof navigator !== 'undefined' ? navigator.onLine : true);
export const pendingCount = writable<number>(0);
export const syncInProgress = writable<boolean>(false);
