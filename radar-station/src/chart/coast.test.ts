import { describe, it, expect, vi } from 'vitest';
vi.mock('leaflet', () => ({ default: {} }));
vi.hoisted(() => ((globalThis as any).Path2D ??= class {})); // Ankersymbol wird beim Laden erzeugt
import { tileBox } from './coast.svelte';

describe('coast', () => {
	it('converts a tile to its lat/lon box', () => {
		expect(tileBox(0, 0, 0).map((v) => Math.round(v * 100) / 100)).toEqual([-85.05, -180, 85.05, 180]);
		const [s, w, n, e] = tileBox(1, 1, 0); // NO-Viertel
		expect([Math.round(s), w, Math.round(n), e]).toEqual([0, 0, 85, 180]);
	});
});
