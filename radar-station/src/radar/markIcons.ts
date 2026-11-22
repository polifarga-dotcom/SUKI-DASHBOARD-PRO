// Wegpunkt-Symbole der Marker (Karte, Popup, Seitentab)
import type { Marker } from './tools.svelte';
/** Wegpunkt-Symbole, Reihenfolge = Sortierung „nach Symbol“ */
export const MARK_ICONS = [
	{ id: 'wp', icon: 'mkWp', label: 'Waypoint' },
	{ id: 'dest', icon: 'flag', label: 'Destination' },
	{ id: 'anchor', icon: 'anchor', label: 'Anchorage' },
	{ id: 'buoy', icon: 'mkBuoy', label: 'Mooring buoy' },
	{ id: 'marina', icon: 'mkMarina', label: 'Marina' },
	{ id: 'fuel', icon: 'mkFuel', label: 'Fuel' },
	{ id: 'danger', icon: 'mkDanger', label: 'Danger' },
	{ id: 'rock', icon: 'mkRock', label: 'Rock / shoal' },
	{ id: 'dive', icon: 'mkDive', label: 'Dive site' },
	{ id: 'fish', icon: 'mkFish', label: 'Fishing spot' },
	{ id: 'info', icon: 'mkInfo', label: 'Info' }
] as const;
export const markIcon = (m: Marker) => (m.kind === 'mob' ? { id: 'mob', icon: 'lifebuoy', label: 'MOB' } : (MARK_ICONS.find((i) => i.id === m.icon) ?? MARK_ICONS[0]));
