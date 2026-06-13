/**
 * sensor-alarm-check — Supabase Edge Function
 *
 * Called every minute via pg_cron + pg_net.
 * Reads all enabled sensor_alarms, fetches current telemetry, runs the
 * state machine (ok → grace → alarming), and sends Telegram notifications.
 *
 * State machine (per alarm row):
 *   ok       + breaching threshold  → grace (record grace_started_at)
 *   grace    + not breaching        → ok (false alarm)
 *   grace    + elapsed ≥ grace_s    → alarming + send Telegram
 *   alarming + cleared (hysteresis) → ok + send clear Telegram
 *   alarming + not cleared + ≥60min → repeat Telegram
 *
 * Stale guard: if telemetry.updated_at > 5 min old, skip all state changes.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ── Sensor definitions ────────────────────────────────────────────────────────

type SensorDef = {
  label: string;
  unit: string;
  emoji: string;
  extract: (t: TelRow) => number | null;
  defaultDirection: 'above' | 'below' | 'deviation';
  defaultThreshold: number;
  defaultHysteresis: number;
};

type TelRow = {
  env_aws_ms: number | null;
  env_twa_rad: number | null;
  nav_hdg_rad: number | null;
  env_pressure_pa: number | null;
  env_depth_m: number | null;
  temp_water: number | null;
  batt_main_soc: number | null;
  batt_main_v: number | null;
  tank_fw: number | null;
  tank_dsl: number | null;
  updated_at: string;
};

const SENSOR_DEFS: Record<string, SensorDef> = {
  wind_speed: {
    label: 'Wind Speed', unit: 'kn', emoji: '💨',
    extract: (t) => t.env_aws_ms != null ? +(t.env_aws_ms * 1.94384).toFixed(1) : null,
    defaultDirection: 'above', defaultThreshold: 25, defaultHysteresis: 3,
  },
  wind_dir: {
    label: 'Wind Direction', unit: '°', emoji: '🧭',
    extract: (t) => {
      if (t.nav_hdg_rad == null || t.env_twa_rad == null) return null;
      const twd = ((t.nav_hdg_rad + t.env_twa_rad) * 180 / Math.PI % 360 + 360) % 360;
      return +twd.toFixed(1);
    },
    defaultDirection: 'deviation', defaultThreshold: 0, defaultHysteresis: 20,
  },
  pressure: {
    label: 'Barometric Pressure', unit: 'hPa', emoji: '🌡',
    extract: (t) => t.env_pressure_pa != null ? +(t.env_pressure_pa / 100).toFixed(1) : null,
    defaultDirection: 'below', defaultThreshold: 980, defaultHysteresis: 2,
  },
  depth: {
    label: 'Depth', unit: 'm', emoji: '⚓',
    extract: (t) => t.env_depth_m,
    defaultDirection: 'below', defaultThreshold: 3, defaultHysteresis: 1,
  },
  water_temp: {
    label: 'Water Temperature', unit: '°C', emoji: '🌊',
    extract: (t) => t.temp_water != null ? +(t.temp_water - 273.15).toFixed(1) : null,
    defaultDirection: 'above', defaultThreshold: 30, defaultHysteresis: 1,
  },
  batt_soc: {
    label: 'Battery SOC', unit: '%', emoji: '🔋',
    extract: (t) => t.batt_main_soc != null ? +(t.batt_main_soc * 100).toFixed(1) : null,
    defaultDirection: 'below', defaultThreshold: 20, defaultHysteresis: 5,
  },
  batt_volt: {
    label: 'Battery Voltage', unit: 'V', emoji: '🔋',
    extract: (t) => t.batt_main_v,
    defaultDirection: 'below', defaultThreshold: 12.2, defaultHysteresis: 0.3,
  },
  tank_fw: {
    label: 'Fresh Water', unit: '%', emoji: '💧',
    extract: (t) => t.tank_fw != null ? +(t.tank_fw * 100).toFixed(1) : null,
    defaultDirection: 'below', defaultThreshold: 20, defaultHysteresis: 5,
  },
  tank_dsl: {
    label: 'Diesel', unit: '%', emoji: '⛽',
    extract: (t) => t.tank_dsl != null ? +(t.tank_dsl * 100).toFixed(1) : null,
    defaultDirection: 'below', defaultThreshold: 15, defaultHysteresis: 5,
  },
};

// ── Threshold evaluation ──────────────────────────────────────────────────────

function circularDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function isBreaching(
  value: number,
  threshold: number,
  direction: string,
  _hysteresis: number
): boolean {
  if (direction === 'above') return value > threshold;
  if (direction === 'below') return value < threshold;
  if (direction === 'deviation') return circularDiff(value, threshold) > _hysteresis / 2;
  return false;
}

function isCleared(
  value: number,
  threshold: number,
  direction: string,
  hysteresis: number
): boolean {
  if (direction === 'above') return value <= threshold - hysteresis;
  if (direction === 'below') return value >= threshold + hysteresis;
  if (direction === 'deviation') return circularDiff(value, threshold) <= hysteresis / 2;
  return false;
}

// ── Telegram ──────────────────────────────────────────────────────────────────

async function sendTelegram(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  boatId: string,
  text: string
): Promise<void> {
  const { data: cfg } = await supabase
    .from('system_config')
    .select('value')
    .eq('key', 'telegram_bot_token')
    .single();
  const token = cfg?.value;
  if (!token) { console.warn('[sensor-alarm] no bot token'); return; }

  const { data: subs } = await supabase
    .from('telegram_subscribers')
    .select('chat_id')
    .eq('boat_id', boatId);

  if (!subs || subs.length === 0) {
    console.warn(`[sensor-alarm] no subscribers for boat ${boatId}`);
    return;
  }

  for (const sub of subs) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: sub.chat_id, text, parse_mode: 'HTML' }),
      });
    } catch (e) {
      console.error('[sensor-alarm] Telegram error', sub.chat_id, e);
    }
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Load all enabled alarms with boat names
  const { data: alarms, error: alarmErr } = await supabase
    .from('sensor_alarms')
    .select('*, boats(name)')
    .eq('enabled', true);

  if (alarmErr) {
    console.error('[sensor-alarm] load error', alarmErr.message);
    return json({ error: alarmErr.message }, 500);
  }

  if (!alarms || alarms.length === 0) {
    return json({ checked: 0, results: [] });
  }

  // Group alarms by boat_id — one telemetry fetch per boat
  const byBoat: Record<string, typeof alarms> = {};
  for (const a of alarms) {
    if (!byBoat[a.boat_id]) byBoat[a.boat_id] = [];
    byBoat[a.boat_id].push(a);
  }

  const results: { boat: string; sensor: string; status: string }[] = [];
  const nowMs = Date.now();

  for (const [boatId, boatAlarms] of Object.entries(byBoat)) {
    const boatName: string =
      (boatAlarms[0].boats as { name: string } | null)?.name ?? boatId;

    // Fetch telemetry once per boat
    const { data: tel } = await supabase
      .from('telemetry')
      .select(
        'env_aws_ms, env_twa_rad, nav_hdg_rad, env_pressure_pa, env_depth_m,' +
        'temp_water, batt_main_soc, batt_main_v, tank_fw, tank_dsl, updated_at'
      )
      .eq('boat_id', boatId)
      .single() as { data: TelRow | null };

    const staleMs = tel?.updated_at
      ? nowMs - new Date(tel.updated_at).getTime()
      : Infinity;
    const isStale = staleMs > 5 * 60 * 1000;

    if (isStale) {
      console.log(`[sensor-alarm] ${boatName}: telemetry stale (${Math.round(staleMs / 1000)}s) — skipping`);
      for (const a of boatAlarms) results.push({ boat: boatName, sensor: a.sensor, status: 'stale' });
      continue;
    }

    for (const alarm of boatAlarms) {
      const def = SENSOR_DEFS[alarm.sensor];
      if (!def) { results.push({ boat: boatName, sensor: alarm.sensor, status: 'unknown_sensor' }); continue; }

      const value = tel ? def.extract(tel) : null;
      if (value == null) {
        results.push({ boat: boatName, sensor: alarm.sensor, status: 'no_data' });
        continue;
      }

      const threshold  = alarm.threshold_value ?? def.defaultThreshold;
      const hysteresis = alarm.hysteresis      ?? def.defaultHysteresis;
      const dir        = alarm.threshold_direction;

      const breaching = isBreaching(value, threshold, dir, hysteresis);
      const cleared   = isCleared(value, threshold, dir, hysteresis);

      const dirLabel = dir === 'above' ? '>' : dir === 'below' ? '<' : '±';

      // ── STATE MACHINE ─────────────────────────────────────────────────────

      if (alarm.state === 'ok') {
        if (breaching) {
          await supabase.from('sensor_alarms').update({
            state: 'grace',
            grace_started_at: new Date(nowMs).toISOString(),
            updated_at: new Date(nowMs).toISOString(),
          }).eq('id', alarm.id);
          results.push({ boat: boatName, sensor: alarm.sensor, status: 'grace_started' });
        } else {
          results.push({ boat: boatName, sensor: alarm.sensor, status: 'ok' });
        }
        continue;
      }

      if (alarm.state === 'grace') {
        if (!breaching) {
          await supabase.from('sensor_alarms').update({
            state: 'ok',
            grace_started_at: null,
            updated_at: new Date(nowMs).toISOString(),
          }).eq('id', alarm.id);
          results.push({ boat: boatName, sensor: alarm.sensor, status: 'grace_cleared' });
          continue;
        }
        const graceStarted = alarm.grace_started_at
          ? new Date(alarm.grace_started_at).getTime()
          : nowMs;
        const graceElapsed = (nowMs - graceStarted) / 1000;
        if (graceElapsed < (alarm.grace_period_s ?? 60)) {
          results.push({ boat: boatName, sensor: alarm.sensor, status: 'in_grace' });
          continue;
        }

        // Grace period elapsed — fire alarm
        const msg =
          `⚠️ <b>SENSOR ALARM — ${boatName}</b>\n` +
          `${def.emoji} ${def.label}: <b>${value} ${def.unit}</b>\n` +
          `Threshold: ${dirLabel} ${threshold} ${def.unit}`;

        await sendTelegram(supabase, boatId, msg);
        await supabase.from('sensor_alarms').update({
          state: 'alarming',
          last_alarmed_at: new Date(nowMs).toISOString(),
          alarm_count: (alarm.alarm_count ?? 0) + 1,
          grace_started_at: null,
          updated_at: new Date(nowMs).toISOString(),
        }).eq('id', alarm.id);
        results.push({ boat: boatName, sensor: alarm.sensor, status: 'alarm_triggered' });
        continue;
      }

      if (alarm.state === 'alarming') {
        if (cleared) {
          const msg =
            `✅ <b>${def.label} alarm cleared — ${boatName}</b>\n` +
            `${def.emoji} Current: ${value} ${def.unit}`;

          await sendTelegram(supabase, boatId, msg);
          await supabase.from('sensor_alarms').update({
            state: 'ok',
            grace_started_at: null,
            last_alarmed_at: null,
            updated_at: new Date(nowMs).toISOString(),
          }).eq('id', alarm.id);
          results.push({ boat: boatName, sensor: alarm.sensor, status: 'alarm_cleared' });
          continue;
        }

        // Still alarming — repeat every 60 min
        const lastAlarmed = alarm.last_alarmed_at
          ? new Date(alarm.last_alarmed_at).getTime()
          : 0;
        const repeatIntervalMs = 60 * 60 * 1000;

        if (nowMs - lastAlarmed >= repeatIntervalMs) {
          const count = (alarm.alarm_count ?? 1) + 1;
          const msg =
            `⚠️ <b>SENSOR ALARM — ${boatName}</b>\n` +
            `${def.emoji} ${def.label}: <b>${value} ${def.unit}</b>\n` +
            `Threshold: ${dirLabel} ${threshold} ${def.unit}\n` +
            `Alert #${count}`;

          await sendTelegram(supabase, boatId, msg);
          await supabase.from('sensor_alarms').update({
            last_alarmed_at: new Date(nowMs).toISOString(),
            alarm_count: count,
            updated_at: new Date(nowMs).toISOString(),
          }).eq('id', alarm.id);
          results.push({ boat: boatName, sensor: alarm.sensor, status: 'alarm_repeated' });
        } else {
          results.push({ boat: boatName, sensor: alarm.sensor, status: 'still_alarming' });
        }
        continue;
      }
    }
  }

  console.log(`[sensor-alarm] checked ${results.length} alarms`);
  return json({ checked: results.length, results });
});
