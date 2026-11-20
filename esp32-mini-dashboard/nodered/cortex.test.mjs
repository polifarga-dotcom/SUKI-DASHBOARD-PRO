// node --test cortex.test.mjs — AIS-Alarmquelle Cortex/SUKI in src/evaluate.js (mit Schein-Flow, ohne Node-RED)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./src/evaluate.js', import.meta.url), 'utf8');
function run(store) {
	const flow = { get: (k) => store[k], set: (k, v) => (store[k] = v) };
	const ctx = { get: () => undefined, set: () => {} };
	new Function('msg', 'flow', 'context', 'global', 'node', 'env', SRC)({ payload: null }, flow, ctx, ctx, { warn() {}, error() {}, status() {} }, { get: () => undefined });
	return store.state;
}
const cortex = (ok, targets) => ({ t: Date.now(), data: { ok, profile: { name: 'Harbour' }, targets } });

test('Cortex mode raises alarms from Cortex flags, ack key ais_<mmsi>', () => {
	const s = run({ cfg: { aisSource: 'cortex' }, cortex: cortex(true, [{ m: '123', cpaA: true, cpa: 0.2, tcpa: 600 }, { m: '9', guardA: true, lost: true }]) });
	assert.equal(s.ais.src, 'cortex');
	assert.equal(s.ais.alarms, 1);
	assert.ok(s.alarmKeys.includes('ais_123'));
	assert.match(s.msg, /AIS 123 CPA 0\.20 NM in 10 min \(Cortex Harbour\)/);
});

test('Cortex silent → SUKI calculation plus warning', () => {
	const s = run({ cfg: { aisSource: 'cortex' }, cortex: cortex(false, [{ m: '123', cpaA: true }]) });
	assert.equal(s.ais.src, 'suki');
	assert.equal(s.ais.alarms, 0);
	assert.match(s.msg, /Cortex offline - SUKI AIS alarm active/);
});

test('SUKI mode ignores Cortex', () => {
	const s = run({ cfg: { aisSource: 'suki' }, cortex: cortex(true, [{ m: '123', cpaA: true }]) });
	assert.equal(s.ais.src, 'suki');
	assert.equal(s.ais.cortex, null);
	assert.equal(s.ais.alarms, 0);
});
