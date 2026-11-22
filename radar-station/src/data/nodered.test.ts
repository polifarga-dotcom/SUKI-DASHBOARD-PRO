import { describe, it, expect } from 'vitest';
import { nrConfigFor, parseState, parseRig } from './nodered.svelte';
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
	it('reads rig alarms with load and ack state', () => {
		const r = parseRig({ alarmKeys: ['rig_port', 'wind', 'rig_sb'], ackedKeys: ['rig_sb'], sail: { rig: { port: 4.31, sb: 4.25 } } });
		expect(r).toEqual([
			{ key: 'rig_port', side: 'port', tons: 4.31, acked: false },
			{ key: 'rig_sb', side: 'sb', tons: 4.25, acked: true }
		]);
		expect(parseRig({})).toEqual([]);
	});
});

import { syncShared } from './nodered.svelte';
import { tools } from '../radar/tools.svelte';
describe('board-wide MOB', () => {
	it('adds and removes shared MOB markers, keeps own markers', () => {
		tools.markers = [{ id: 1, pos: { lat: 1, lon: 1 }, kind: 'mark', label: 'M1', t: 1 }];
		syncShared('mob', [{ id: 5, lat: 36, lon: 14, t: 5 }]);
		expect(tools.markers.map((m) => [m.id, m.kind, !!m.shared])).toEqual([[1, 'mark', false], [5, 'mob', true]]);
		syncShared('mob', [{ id: 5, lat: 36, lon: 14, t: 5 }]);
		expect(tools.markers.length).toBe(2);
		syncShared('mob', []);
		expect(tools.markers.map((m) => m.id)).toEqual([1]);
		syncShared('mark', [{ id: 7, lat: 36, lon: 14, t: 7 }]);
		syncShared('mob', []); // MOB-Abgleich lässt bordweite Wegpunkte stehen
		expect(tools.markers.map((m) => [m.id, m.kind, m.label])).toEqual([[1, 'mark', 'M1'], [7, 'mark', 'WP 1']]);
	});
});
