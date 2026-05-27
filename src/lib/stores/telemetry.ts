import { writable } from 'svelte/store';
import type { Telemetry } from '$lib/types.js';

export const telemetry = writable<Telemetry | null>(null);
export const dataStale = writable(true);
