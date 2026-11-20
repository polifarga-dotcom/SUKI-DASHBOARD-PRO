// node --test pi/cortex-bridge.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, newStore, apply, snapshot } from './cortex-bridge.mjs';

test('parses Cortex frames', () => {
	assert.deepEqual(parse('N:ChannelIdentifier{"token":"abc"}'), { type: 'ChannelIdentifier', data: { token: 'abc' } });
	assert.equal(parse('garbage'), null);
	assert.equal(parse('3:X{broken'), null);
});

test('merges full list and single updates, tcpa relative, expires stale targets', () => {
	const st = newStore();
	const now = 1_000_000_000;
	apply(st, 'TargetCalculations', [{ mmsi: 1, hasCpa: true, cpa: 0.1234, tcpa: now / 1000 + 300, cpaAlarmTriggered: true }, { mmsi: 2 }], now);
	apply(st, 'TargetCalculations', { mmsi: 2, isLost: true }, now + 1000);
	apply(st, 'CollisionProfiles', { collisionProfiles: [{ id: 2, name: 'Harbour', cpa: 2, tcpa: 600, speed: 5 }] }, now);
	apply(st, 'CollisionProfileControl', { profileId: 2 }, now + 1000);
	let s = snapshot(st, now + 1000);
	assert.equal(s.ok, true);
	assert.equal(s.profile.name, 'Harbour');
	assert.deepEqual(s.targets.map((t) => [t.m, t.cpaA, t.lost, t.cpa, t.tcpa]), [['1', true, false, 0.123, 299], ['2', false, true, null, null]]);
	s = snapshot(st, now + 600_500);
	assert.equal(s.ok, false);
	assert.deepEqual(s.targets.map((t) => t.m), ['2']);
});
