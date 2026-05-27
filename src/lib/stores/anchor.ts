import { writable } from 'svelte/store';
import type { AnchorConfig } from '$lib/types.js';

export const anchorConfig = writable<AnchorConfig | null>(null);
