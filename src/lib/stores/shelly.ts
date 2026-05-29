import { writable } from 'svelte/store';
import type { ShellyDevice } from '$lib/types.js';

export const shellyDevices = writable<ShellyDevice[]>([]);
