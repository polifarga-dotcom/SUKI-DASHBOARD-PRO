import { describe, it, expect } from 'vitest';
import { decodeRadarMessage, encodeSpoke } from './spokeDecoder';

describe('decodeRadarMessage', () => {
	it('decodes multiple spokes with all fields', () => {
		const d1 = new Uint8Array(512).map((_, i) => i % 16);
		const d2 = new Uint8Array(1024).fill(7);
		const buf = new Uint8Array([
			...encodeSpoke({ angle: 10, bearing: 1500, range: 1852, time: 1761400000000, data: d1, lat: 54.1, lon: 10.8 }),
			...encodeSpoke({ angle: 2047, range: 926, data: d2 })
		]);
		const b = decodeRadarMessage(buf);
		expect(b.n).toBe(2);
		expect(b.angle[0]).toBe(10);
		expect(b.bearing[0]).toBe(1500);
		expect(b.range[0]).toBe(1852);
		expect(b.time[0]).toBe(1761400000000);
		expect(b.lat[0]).toBeCloseTo(54.1);
		expect(b.lon[0]).toBeCloseTo(10.8);
		expect(b.len[0]).toBe(512);
		expect(b.data[5]).toBe(5);
		expect(b.angle[1]).toBe(2047);
		expect(b.bearing[1]).toBe(-1);
		expect(Number.isNaN(b.lat[1])).toBe(true);
		expect(b.data[1024 + 1000]).toBe(7);
	});

	it('decodes a real mayara emulator message header', () => {
		// erste Bytes einer echten Emulator-Nachricht (angle 544, bearing 544, range 926)
		const hex = '12a40808a0041020189e072088e8d6a1973431d3e350be186442403980a6d42407182d402a8008';
		const head = Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
		const buf = new Uint8Array(head.length + 1024);
		buf.set(head);
		const b = decodeRadarMessage(buf);
		expect(b.n).toBe(1);
		expect(b.angle[0]).toBe(544);
		expect(b.range[0]).toBe(926);
		expect(b.len[0]).toBe(1024);
		expect(b.lat[0]).toBeGreaterThan(-90);
	});
});
