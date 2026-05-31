import { writable } from 'svelte/store';

export type WaveSnapshot = {
	wave_height_m:  number | null;
	wave_period_s:  number | null;
	wave_dir_deg:   number | null;
	swell_height_m: number | null;
	fetched_at:     string | null;   // ISO
};

export const latestWave = writable<WaveSnapshot>({
	wave_height_m:  null,
	wave_period_s:  null,
	wave_dir_deg:   null,
	swell_height_m: null,
	fetched_at:     null,
});
