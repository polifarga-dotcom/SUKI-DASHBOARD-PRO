import { test, expect, vi } from 'vitest';
import { settings } from '../lib/settings.svelte';
import { alarms, watch } from './alarms.svelte';
import { startAlarmSync, fromWire, toWire, same } from './alarmsync.svelte';

test('relative wire times survive a round trip and small latency counts as equal', () => {
	const s = { sound: false, until: 10_000 + 300_000, watchOn: true, watchMin: 15, last: 10_000 - 60_000 };
	const back = fromWire(toWire(s, 10_000), 10_400); // 400 ms später angekommen
	expect(same(back, s)).toBe(true);
	expect(same({ ...back, last: back.last + 5000 }, s)).toBe(false);
	expect(fromWire({ ...toWire(s, 10_000), untilIn: 0 }, 1).until).toBe(0); // nicht stumm bleibt 0
});

// Senden lokaler Änderungen läuft über $effect – das führt vitest (Server-Runtime) nicht aus, im Browser geprüft.
test('state from the Pi is applied and not sent back', async () => {
	const pi = { sound: false, untilIn: 0, watchOn: true, watchMin: 7, lastAgo: 120_000 };
	const puts: unknown[] = [];
	vi.stubGlobal('fetch', async (_u: string, init?: RequestInit) => {
		if (init?.method === 'PUT') puts.push(init.body);
		return { ok: true, json: async () => pi };
	});
	settings.alarmSound = true;
	settings.watchOn = false;
	const stop = startAlarmSync(60000);
	await new Promise((r) => setTimeout(r, 0));
	expect(settings.alarmSound).toBe(false);
	expect(settings.watchOn).toBe(true);
	expect(settings.watchMin).toBe(7);
	expect(Math.abs(Date.now() - 120_000 - watch.last)).toBeLessThan(1000);
	expect(alarms.mutedUntil).toBe(0);
	expect(puts).toHaveLength(0);
	stop();
	vi.unstubAllGlobals();
});
