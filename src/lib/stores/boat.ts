import { writable, derived } from 'svelte/store';
import type { Boat, BoatMember } from '$lib/types.js';

/** All boats the current user is a member of. */
export const myBoats = writable<Boat[]>([]);

/** The currently active boat (persisted in localStorage as 'currentBoatId'). */
export const currentBoat = writable<Boat | null>(null);

/** The current user's role in the active boat. */
export const boatRole = writable<'admin' | 'viewer' | null>(null);

/** Members of the currently active boat (populated lazily by settings page). */
export const boatMembers = writable<(BoatMember & { email?: string })[]>([]);

/** Convenience: is the current user an admin of the active boat? */
export const isBoatAdmin = derived(boatRole, ($r) => $r === 'admin');
