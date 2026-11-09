import { describe, it, expect } from 'vitest';
import { encounter, situation, dangerLevel } from './cpa';
import { D2R, NM, KN } from '../lib/geo';

const own = { course: 0, speed: 10 * KN };

describe('encounter', () => {
	it('head-on collision course: CPA 0, TCPA = d / closing speed', () => {
		const e = encounter(0, 2 * NM, own, { course: Math.PI, speed: 10 * KN });
		expect(e.cpa).toBeLessThan(1);
		expect(e.tcpa).toBeCloseTo((2 * NM) / (20 * KN), 3);
		expect(e.closing).toBe(true);
	});

	it('opening target has negative TCPA', () => {
		const e = encounter(0, -1 * NM, own, { course: Math.PI, speed: 10 * KN });
		expect(e.tcpa).toBeLessThan(0);
		expect(dangerLevel(e, 0.5 * NM, 1200)).toBe('safe');
	});

	it('parallel offset course passes at the offset', () => {
		const e = encounter(0.3 * NM, 2 * NM, own, { course: Math.PI, speed: 5 * KN });
		expect(e.cpa).toBeCloseTo(0.3 * NM, 0);
	});

	it('crossing from starboard ahead of the bow: positive BCR', () => {
		// Ziel 1 nm voraus, 1 nm Stb, fährt West mit 20 kn → kreuzt vor uns
		const e = encounter(1 * NM, 1 * NM, own, { course: 270 * D2R, speed: 20 * KN });
		expect(e.bcr).not.toBeNull();
		expect(e.bct).toBeCloseTo(NM / (20 * KN), 1);
		expect(e.bcr!).toBeGreaterThan(0);
	});

	it('slow target crossing behind: negative BCR', () => {
		const e = encounter(0.2 * NM, 0.5 * NM, own, { course: 270 * D2R, speed: 2 * KN });
		expect(e.bcr!).toBeLessThan(0);
	});

	it('stationary target dead ahead gets danger level dangerous', () => {
		const e = encounter(0, 1 * NM, own, { course: null, speed: 0 });
		expect(dangerLevel(e, 0.5 * NM, 20 * 60)).toBe('dangerous');
	});
});

describe('situation (COLREG)', () => {
	const sit = (x: number, y: number, tc: number, ts: number, o = own) => {
		const t = { course: tc * D2R, speed: ts * KN };
		const e = encounter(x * NM, y * NM, o, t);
		return situation(Math.atan2(x, y), o, t, e);
	};
	it('head-on', () => expect(sit(0.01, 3, 180, 12)).toBe('head-on'));
	it('crossing from starboard = give way', () => expect(sit(2, 2, 270, 14)).toBe('crossing-give-way'));
	it('crossing from port = stand on', () => expect(sit(-2, 2, 90, 14)).toBe('crossing-stand-on'));
	it('target overtaking us from astern', () => expect(sit(0.05, -1, 0, 18)).toBe('overtaken'));
	it('we overtake a slower vessel ahead', () => expect(sit(0.05, 1, 0, 4)).toBe('overtaking'));
	it('no situation when opening', () => expect(sit(0, -1, 180, 10)).toBe('none'));
});
