import { writable } from 'svelte/store';
import type { InReachPoint } from '$lib/types.js';

/** Latest points from the InReach MapShare feed (newest first). Null = not loaded yet. */
export const inreachPoints = writable<InReachPoint[] | null>(null);

/** True when the last fetch returned an error or timed out. */
export const inreachStale = writable(false);
