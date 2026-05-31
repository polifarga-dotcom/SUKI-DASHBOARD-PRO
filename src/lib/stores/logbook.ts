import { writable } from 'svelte/store';
import type { LogTrip, LogEntry } from '$lib/types.js';

/** The currently active trip (null = no trip running) */
export const activeTrip    = writable<LogTrip | null>(null);

/** All entries for the active trip, newest first */
export const tripEntries   = writable<LogEntry[]>([]);

/** All trips for the current boat, newest first */
export const allTrips      = writable<LogTrip[]>([]);

/** True once the initial Supabase fetch has completed */
export const logLoaded     = writable(false);
