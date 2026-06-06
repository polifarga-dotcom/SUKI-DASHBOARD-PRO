import { writable } from 'svelte/store';
import type { VRMData } from '$lib/types.js';

export const vrmData        = writable<VRMData | null>(null);
export const vrmError       = writable('');
export const vrmPolling     = writable(false);         // true = hot-window (waiting for Cerbo upload)
export const vrmLastFetchAt = writable<number | null>(null); // epoch-s of last successful API call
