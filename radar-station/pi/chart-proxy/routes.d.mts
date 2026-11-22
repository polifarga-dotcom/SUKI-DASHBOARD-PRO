export interface RPt { lat: number; lon: number; name?: string }
export interface RDoc { id: string; name: string; color: string; show: boolean; pts: RPt[]; updated: number }
export type ExportKey = 'gpx' | 'kml' | 'geojson' | 'csv' | 'nmea';
export const MAX_PTS: number;
export const MAX_ROUTES: number;
export const ROUTE_COLORS: string[];
export function cleanRoute(r: unknown): RDoc | null;
export function parseCoord(s: string): number;
export function parseRoutes(text: string, filename?: string): { name: string; pts: RPt[] }[];
type Exportable = { name: string; color?: string; pts: RPt[] }[];
export function toGpx(r: Exportable): string;
export function toKml(r: Exportable): string;
export function toGeoJson(r: Exportable): string;
export function toCsv(r: Exportable): string;
export function toNmea(r: Exportable): string;
export const EXPORTS: Record<ExportKey, { ext: string; mime: string; make: (r: Exportable) => string; label: string }>;
export const MAX_WP_NAME: number;
export function wpWeather(name: string | undefined): { eta: number; off: number; vals: Record<string, number>; side: 'S' | 'P' | '' } | null;
