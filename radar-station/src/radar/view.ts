// Gemeinsame Bildschirm-Transformation (lokale m Ost/Nord ↔ CSS-Pixel) für WebGL, Overlay, Chart und Eingaben.
import { norm2pi } from '../lib/geo';
import type { View } from './renderer';

export type { View };

export function toScreen(v: View, x: number, y: number): [number, number] {
	const c = Math.cos(v.up);
	const s = Math.sin(v.up);
	return [v.cx + (x * c - y * s) * v.ppm, v.cy - (y * c + x * s) * v.ppm];
}

export function fromScreen(v: View, sx: number, sy: number): [number, number] {
	const dx = (sx - v.cx) / v.ppm;
	const dy = (v.cy - sy) / v.ppm;
	const c = Math.cos(v.up);
	const s = Math.sin(v.up);
	return [dx * c + dy * s, -dx * s + dy * c];
}

/** Bildschirmwinkel (rad, 0 = oben, im Uhrzeigersinn) einer wahren Peilung */
export const screenAngle = (v: View, trueBrg: number) => norm2pi(trueBrg - v.up);
