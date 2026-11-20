import { describe, it, expect } from 'vitest';
import { nrConfigFor, parseState } from './nodered.svelte';
import { NM } from '../lib/geo';

describe('Node-RED AIS alarm', () => {
	it('maps presets to Node-RED limits', () => {
		expect(nrConfigFor('off', NM, 600)).toEqual({ aisMode: 'anchor' });
		expect(nrConfigFor('harbor', 0.1 * NM, 300)).toEqual({ aisMode: 'cruising', aisCruiseNm: 0.1, aisTcpaMin: 5 });
		expect(nrConfigFor('offshore', 2 * NM, 1800)).toEqual({ aisMode: 'offshore', aisOffshoreNm: 2, aisTcpaMin: 30 });
		expect(nrConfigFor('custom', 0.01 * NM, 10)).toEqual({ aisMode: 'cruising', aisCruiseNm: 0.05, aisTcpaMin: 1 });
	});
	it('reads AIS alarms with ack state from /state', () => {
		const a = parseState({
			alarmKeys: ['wind', 'ais_211', 'ais_999'],
			ackedKeys: ['ais_211'],
			ais: { targets: [{ m: '211', nm: 'ALPHA', cpa: 0.2, tcpa: 4 }] }
		});
		expect(a.map((x) => [x.mmsi, x.name, x.acked])).toEqual([['211', 'ALPHA', true], ['999', '999', false]]);
		expect(a[0].cpa).toBeCloseTo(0.2 * NM);
		expect(a[0].tcpa).toBe(240);
	});
});
