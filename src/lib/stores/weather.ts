import { writable } from 'svelte/store';

export type WxHour = {
	time:   string;
	temp:   number;
	wind:   number;
	gusts:  number;
	dir:    number;
	precip: number;
	wmo:    number;
	waveH:  number | null;
	waveP:  number | null;
	waveD:  number | null;
	swellH: number | null;
	swellD: number | null;
};

/** Shared forecast data — written by WeatherCard, read by WeatherMapCard. */
export const weatherForecast = writable<WxHour[]>([]);

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
