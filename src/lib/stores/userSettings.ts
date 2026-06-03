import { derived } from 'svelte/store';
import { currentBoat } from './boat.js';

/**
 * Unit system preference (metric or imperial)
 * Derived from currentBoat.unit_system; defaults to 'metric'
 */
export const unitSystem = derived(
	currentBoat,
	$boat => ($boat?.unit_system ?? 'metric') as 'metric' | 'imperial'
);

/**
 * Time format preference (12h or 24h)
 * Derived from currentBoat.time_format; defaults to '24h'
 */
export const timeFormat = derived(
	currentBoat,
	$boat => ($boat?.time_format ?? '24h') as '12h' | '24h'
);

/**
 * Update boat unit and time preferences
 * @param supabase Supabase client
 * @param boatId Boat ID to update
 * @param updates Partial update object with unit_system and/or time_format
 */
export async function updateBoatSettings(
	supabase: any,
	boatId: string,
	updates: {
		unit_system?: 'metric' | 'imperial';
		time_format?: '12h' | '24h';
	}
): Promise<void> {
	const { error } = await supabase
		.from('boats')
		.update(updates)
		.eq('id', boatId);
	if (error) throw error;
}
