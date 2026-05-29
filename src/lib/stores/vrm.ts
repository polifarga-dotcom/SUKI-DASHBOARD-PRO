import { writable } from 'svelte/store';
import type { VRMData } from '$lib/types.js';
export const vrmData = writable<VRMData | null>(null);
