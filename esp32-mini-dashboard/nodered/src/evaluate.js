// ESP32 Mini Dashboard — Auswertung (läuft jede Sekunde)
// Liest die zwischengespeicherten SignalK-/Supabase-Daten aus dem Flow-Context,
// wertet Schwellwerte mit Hysterese aus und legt den fertigen Display-State
// in flow.state ab. Der ESP32 und der Browser-Simulator holen nur noch diesen
// State ab — die gesamte Logik lebt hier, die Firmware ist ein reines Display.

const DEF = {
    windAlarmOn: true, windAlarmKn: 25, windHystKn: 2, windSource: 'auto', windAvgSec: 10, windWinMin: 2,
    battAlarmOn: true, battLowSoc: 30, battHystSoc: 3, battLowVolt: 0, battInstance: 'auto',
    waterAlarmOn: true, waterLowPct: 15, waterHystPct: 3, waterInstance: 'auto',
    engMaxRpm: 3000, engRedRpm: 2500, engGreenFrom: 1800, engGreenTo: 2200, fuelInstance: 'auto', fuelUseSensor: true,
    fuelCurve: '800:0.8,1000:1.2,1500:2.2,2000:3.8,2500:6.2,3000:9.5',
    baroAlarmOn: true, baroLowHpa: 995, baroHystHpa: 1, baroWinMin: 2,
    anchorAlarmOn: true, anchorLocalFallback: true,
    ackMinutes: 5, staleSec: 30, tz: 'Europe/Rome', testUntil: 0, night: false,
    soundOn: true, soundNight: 'short',
};
const cfg = Object.assign({}, DEF, flow.get('cfg') || {});
const now = Date.now();
const MS2KN = 1.943844;

const ageS = (ts) => (ts ? (now - new Date(ts).getTime()) / 1000 : Infinity);
const isNum = (v) => typeof v === 'number' && isFinite(v);
const r1 = (v) => (isNum(v) ? Math.round(v * 10) / 10 : null);
const leaf = (o) => (o && typeof o === 'object' && 'value' in o ? o : null);

const alarms = [];   // { key, text }
const warns = [];    // text

// ── Batterie ──────────────────────────────────────────────────────────────
const skB = flow.get('sk_batt');
const bTree = (skB && skB.data && typeof skB.data === 'object') ? skB.data : {};
const batts = Object.keys(bTree)
    .filter((k) => bTree[k] && typeof bTree[k] === 'object')
    .map((k) => {
        const b = bTree[k];
        const soc = leaf(b.capacity && b.capacity.stateOfCharge);
        const v = leaf(b.voltage);
        const a = leaf(b.current);
        return {
            id: k,
            name: (leaf(b.name) && b.name.value) || null,
            soc: soc && isNum(soc.value) ? soc.value * 100 : null,
            socTs: soc ? soc.timestamp : null,
            v: v && isNum(v.value) ? v.value : null,
            vTs: v ? v.timestamp : null,
            a: a && isNum(a.value) ? a.value : null,
        };
    })
    .sort((x, y) => (parseFloat(x.id) || 0) - (parseFloat(y.id) || 0));
flow.set('batt_list', batts.map((b) => ({ id: b.id, soc: r1(b.soc), v: r1(b.v), a: r1(b.a) })));

let bat = null;
if (cfg.battInstance !== 'auto') bat = batts.find((b) => b.id === String(cfg.battInstance)) || null;
// Auto: kleinste Instanz mit SOC (gleiche Regel wie das SignalK-Plugin der Pro App)
if (!bat) bat = batts.find((b) => b.soc != null) || batts.find((b) => b.v != null) || null;

const batt = { st: 'na', soc: null, v: null, a: null, id: bat ? bat.id : null, thr: cfg.battLowSoc };
if (bat && Math.min(ageS(bat.socTs), ageS(bat.vTs)) < cfg.staleSec && skB && ageS(skB.t) < cfg.staleSec) {
    batt.soc = bat.soc != null ? Math.round(bat.soc) : null;
    batt.v = bat.v != null ? Math.round(bat.v * 100) / 100 : null;
    batt.a = r1(bat.a);
    let low = context.get('battLow') || false;
    if (batt.soc != null) {
        if (!low && batt.soc < cfg.battLowSoc) low = true;
        else if (low && batt.soc >= cfg.battLowSoc + cfg.battHystSoc) low = false;
    } else if (cfg.battLowVolt > 0 && batt.v != null) {
        if (!low && batt.v < cfg.battLowVolt) low = true;
        else if (low && batt.v >= cfg.battLowVolt + 0.2) low = false;
    }
    context.set('battLow', low);
    batt.st = low && cfg.battAlarmOn ? 'alarm' : 'ok';
    if (batt.st === 'alarm') {
        alarms.push({ key: 'batt', text: batt.soc != null
            ? `BATTERY ${batt.soc} % < ${cfg.battLowSoc} %`
            : `BATTERY ${batt.v} V < ${cfg.battLowVolt} V` });
    }
} else {
    warns.push('No battery data');
}

// ── Frischwasser ──────────────────────────────────────────────────────────
const skT = flow.get('sk_tanks');
const fwTree = (skT && skT.data && skT.data.freshWater && typeof skT.data.freshWater === 'object') ? skT.data.freshWater : {};
const tanks = Object.keys(fwTree)
    .filter((k) => fwTree[k] && typeof fwTree[k] === 'object')
    .map((k) => {
        const lvl = leaf(fwTree[k].currentLevel), cap = leaf(fwTree[k].capacity);
        return { id: k, lvl: lvl && isNum(lvl.value) ? lvl.value * 100 : null, ts: lvl ? lvl.timestamp : null,
            capL: cap && isNum(cap.value) ? cap.value * 1000 : null };
    })
    .sort((x, y) => (parseFloat(x.id) || 0) - (parseFloat(y.id) || 0));
flow.set('tank_list', tanks.map((t) => ({ id: t.id, pct: r1(t.lvl), capL: t.capL != null ? Math.round(t.capL) : null })));

let tank = null;
if (cfg.waterInstance !== 'auto') tank = tanks.find((t) => t.id === String(cfg.waterInstance)) || null;
if (!tank) tank = tanks.find((t) => t.lvl != null) || null;

const water = { st: 'na', pct: null, l: null, cap: null, id: tank ? tank.id : null, thr: cfg.waterLowPct };
if (tank && tank.lvl != null && ageS(tank.ts) < cfg.staleSec && ageS(skT.t) < cfg.staleSec) {
    water.pct = Math.round(tank.lvl);
    if (tank.capL != null) { water.cap = Math.round(tank.capL); water.l = Math.round(tank.capL * tank.lvl / 100); }
    let low = context.get('waterLow') || false;
    if (!low && water.pct < cfg.waterLowPct) low = true;
    else if (low && water.pct >= cfg.waterLowPct + cfg.waterHystPct) low = false;
    context.set('waterLow', low);
    water.st = low && cfg.waterAlarmOn ? 'alarm' : 'ok';
    if (water.st === 'alarm') alarms.push({ key: 'water', text: `WATER ${water.pct} % < ${cfg.waterLowPct} %` });
} else {
    warns.push('No tank data');
}

// ── Wind ──────────────────────────────────────────────────────────────────
const skW = flow.get('sk_wind');
const wTree = (skW && skW.data) || {};
const tws = leaf(wTree.speedTrue), aws = leaf(wTree.speedApparent);
let wsrc = null;
if (cfg.windSource === 'true') wsrc = tws ? ['TWS', tws] : null;
else if (cfg.windSource === 'apparent') wsrc = aws ? ['AWS', aws] : null;
else wsrc = (tws && ageS(tws.timestamp) < cfg.staleSec) ? ['TWS', tws] : (aws ? ['AWS', aws] : null);

// Verlauf (10 min) für Mittelwert und Böen-Maximum
let hist = flow.get('wind_hist') || [];
if (wsrc && isNum(wsrc[1].value) && ageS(wsrc[1].timestamp) < cfg.staleSec) {
    const t = new Date(wsrc[1].timestamp).getTime();
    if (!hist.length || hist[hist.length - 1][0] !== t) hist.push([t, wsrc[1].value * MS2KN]);
}
hist = hist.filter((h) => now - h[0] < 6 * 3600000);  // 6 h für das Verlaufsdiagramm
flow.set('wind_hist', hist);

const wind = { st: 'na', kn: null, max: null, src: wsrc ? wsrc[0] : null, thr: cfg.windAlarmKn };
const recent = hist.filter((h) => now - h[0] < cfg.windAvgSec * 1000);
if (recent.length && skW && ageS(skW.t) < cfg.staleSec) {
    wind.kn = r1(recent.reduce((s, h) => s + h[1], 0) / recent.length);
    const last10 = hist.filter((h) => now - h[0] < 600000);
    wind.max = r1(Math.max.apply(null, last10.map((h) => h[1])));
    // 60 gemittelte Punkte über windWinMin, wie beim Barometer
    const wWin = cfg.windWinMin * 60000, wStart = now - wWin, WN = 60;
    const wSum = new Array(WN).fill(0), wCnt = new Array(WN).fill(0);
    for (const h of hist) {
        if (h[0] < wStart) continue;
        const i = Math.min(WN - 1, Math.floor((h[0] - wStart) / wWin * WN));
        wSum[i] += h[1]; wCnt[i]++;
    }
    wind.hist = wSum.map((v, i) => (wCnt[i] ? Math.round(v / wCnt[i] * 10) / 10 : null));
    wind.win = cfg.windWinMin;
    let high = context.get('windHigh') || false;
    if (!high && wind.kn >= cfg.windAlarmKn) high = true;
    else if (high && wind.kn < cfg.windAlarmKn - cfg.windHystKn) high = false;
    context.set('windHigh', high);
    wind.st = high && cfg.windAlarmOn ? 'alarm' : 'ok';
    if (wind.st === 'alarm') alarms.push({ key: 'wind', text: `WIND ${wind.kn} kn >= ${cfg.windAlarmKn} kn` });
} else {
    warns.push('No wind data');
}

// ── Barometer ─────────────────────────────────────────────────────────────
// Verlauf bis 6 h im Flow-Context; ans Display gehen 60 gemittelte Punkte über baroWinMin
const skP = flow.get('sk_baro');
const pLeaf = skP && leaf(skP.data);
let bHist = flow.get('baro_hist') || [];
if (pLeaf && isNum(pLeaf.value) && ageS(pLeaf.timestamp) < cfg.staleSec) {
    const t = new Date(pLeaf.timestamp).getTime();
    if (!bHist.length || bHist[bHist.length - 1][0] !== t) bHist.push([t, pLeaf.value / 100]);
}
bHist = bHist.filter((h) => now - h[0] < 6 * 3600000);
flow.set('baro_hist', bHist);

const baro = { st: 'na', hpa: null, thr: cfg.baroLowHpa, d: null, win: cfg.baroWinMin, hist: [] };
if (pLeaf && isNum(pLeaf.value) && ageS(pLeaf.timestamp) < cfg.staleSec && ageS(skP.t) < cfg.staleSec) {
    baro.hpa = r1(pLeaf.value / 100);
    const winMs = cfg.baroWinMin * 60000, start = now - winMs, N = 60;
    const sums = new Array(N).fill(0), cnt = new Array(N).fill(0);
    for (const h of bHist) {
        if (h[0] < start) continue;
        const i = Math.min(N - 1, Math.floor((h[0] - start) / winMs * N));
        sums[i] += h[1]; cnt[i]++;
    }
    baro.hist = sums.map((v, i) => (cnt[i] ? Math.round(v / cnt[i] * 10) / 10 : null));
    const inWin = bHist.filter((h) => h[0] >= start);
    if (inWin.length > 1) baro.d = r1(inWin[inWin.length - 1][1] - inWin[0][1]);
    let low = context.get('baroLow') || false;
    if (!low && baro.hpa < cfg.baroLowHpa) low = true;
    else if (low && baro.hpa >= cfg.baroLowHpa + cfg.baroHystHpa) low = false;
    context.set('baroLow', low);
    baro.st = low && cfg.baroAlarmOn ? 'alarm' : 'ok';
    if (baro.st === 'alarm') alarms.push({ key: 'baro', text: `PRESSURE ${baro.hpa} hPa < ${cfg.baroLowHpa} hPa` });
} else {
    warns.push('No pressure data');
}

// ── Anker (Supabase via mfd-anchor Edge Function) ─────────────────────────
const cloud = flow.get('anchor') || {};
const cloudOk = cloud.t && ageS(cloud.t) < Math.max(cfg.staleSec, 30);
const anc = (cloud.data && cloud.data.anchor) || null;
const skN = flow.get('sk_nav');
const pos = skN && skN.data && leaf(skN.data.position);
const posOk = pos && pos.value && ageS(pos.timestamp) < cfg.staleSec;

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
}

const anchor = { st: 'na', act: false, dist: null, rad: null, cloud: !!cloudOk };
if (anc) {
    anchor.act = !!anc.active;
    anchor.rad = isNum(anc.radius_m) ? Math.round(anc.radius_m) : null;
    if (anchor.act && posOk && isNum(anc.lat) && isNum(anc.lon)) {
        anchor.dist = Math.round(haversine(pos.value.latitude, pos.value.longitude, anc.lat, anc.lon));
    }
    if (!anchor.act) {
        anchor.st = 'off';
    } else if (cloudOk && anc.alarming) {
        anchor.st = 'alarm';
    } else if (!cloudOk && cfg.anchorLocalFallback && anchor.dist != null && anchor.rad != null) {
        // Cloud weg (z.B. Starlink): lokale Driftprüfung mit zuletzt bekannter Ankerposition
        let since = context.get('localDragSince') || 0;
        if (anchor.dist > anchor.rad) { if (!since) since = now; } else since = 0;
        context.set('localDragSince', since);
        const delay = (isNum(anc.alarm_delay_s) ? anc.alarm_delay_s : 10) * 1000;
        anchor.st = since && now - since >= delay ? 'alarm' : 'ok';
    } else {
        anchor.st = 'ok';
    }
    if (anchor.st === 'alarm' && cfg.anchorAlarmOn) {
        alarms.push({ key: 'anchor', text: cloudOk ? 'ANCHOR ALARM' : `ANCHOR DRAG ${anchor.dist} m (local)` });
    } else if (anchor.st === 'alarm') {
        anchor.st = 'ok';
    }
}
if (!cloudOk) warns.push(anc ? 'Cloud offline - anchor status last known' : 'Cloud offline - anchor status unknown');

// ── Victron Energy Flow (lokaler MQTT-Broker des Cerbo GX) ────────────────
const vic = flow.get('vic') || {};
const vNum = (k) => (isNum(vic[k]) ? vic[k] : null);
const V = (k) => vNum('system/0/' + k);
const r0 = (v) => (isNum(v) ? Math.round(v) : null);
const sumPh = (prefix) => {
    let s = null;
    for (const ph of ['L1', 'L2', 'L3']) { const v = V(prefix + '/' + ph + '/Power'); if (v != null) s = (s || 0) + v; }
    return s;
};
const vicKeys = (re) => Object.keys(vic).filter((k) => re.test(k) && isNum(vic[k])).map((k) => vic[k]);
function fmtTTG(s) {
    if (!isNum(s) || s <= 0) return '';
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
    return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3600) / 60)}m`;
}
const SYS_STATE = { 0: 'Off', 1: 'Low power', 2: 'Fault', 3: 'Bulk', 4: 'Absorption', 5: 'Float', 6: 'Storage',
    7: 'Equalize', 8: 'Passthru', 9: 'Inverting', 10: 'Assisting', 11: 'Power supply', 244: 'Sustain',
    252: 'Ext. control', 256: 'Discharging', 257: 'Sustain', 258: 'Recharge', 259: 'Scheduled' };

let energy = { ok: false };
if (vic._t && now - vic._t < 60000) {
    const src = V('Ac/ActiveIn/Source');               // 240 = nicht verbunden
    const shoreW = sumPh('Ac/ActiveIn');
    const shoreV = vicKeys(/^vebus\/\d+\/Ac\/ActiveIn\/L1\/V$/)[0];
    const pvDay = vicKeys(/^solarcharger\/\d+\/History\/Daily\/0\/Yield$/);
    const invP = V('Dc/InverterCharger/Power') != null ? V('Dc/InverterCharger/Power') : V('Dc/Vebus/Power');
    const bState = V('Dc/Battery/State');              // 0 idle, 1 charging, 2 discharging
    energy = {
        ok: true,
        shore: { on: src != null && src !== 240 && ((shoreW || 0) > 5 || (shoreV || 0) > 50), w: r0(shoreW), v: r0(shoreV) },
        inv: { st: SYS_STATE[V('SystemState/State')] || '--', w: r0(invP) },
        ac: { w: r0(sumPh('Ac/ConsumptionOnOutput') != null ? sumPh('Ac/ConsumptionOnOutput') : sumPh('Ac/Consumption')) },
        pv: { w: r0(V('Dc/Pv/Power')), a: r1(V('Dc/Pv/Current')),
            today: pvDay.length ? Math.round(pvDay.reduce((a, b) => a + b, 0) * 100) / 100 : null },
        bat: { soc: r0(V('Dc/Battery/Soc')), v: V('Dc/Battery/Voltage') != null ? Math.round(V('Dc/Battery/Voltage') * 100) / 100 : null,
            a: r1(V('Dc/Battery/Current')), w: r0(V('Dc/Battery/Power')),
            st: ['Idle', 'Charging', 'Discharging'][bState] || '--', ttg: fmtTTG(V('Dc/Battery/TimeToGo')) },
        dc: { w: r0(V('Dc/System/Power')) },
    };
}

// ── Wetter (Open-Meteo, alle 30 min) + Mond (met.no) für Screen 3 ─────────
const WMO = (c) => {
    if (c === 0) return ['sun', 'Clear'];
    if (c === 1) return ['partly', 'Mainly clear'];
    if (c === 2) return ['partly', 'Partly cloudy'];
    if (c === 3) return ['cloud', 'Overcast'];
    if (c === 45 || c === 48) return ['fog', 'Fog'];
    if (c >= 51 && c <= 57) return ['rain', 'Drizzle'];
    if (c >= 61 && c <= 67) return ['rain', 'Rain'];
    if (c >= 71 && c <= 77) return ['snow', 'Snow'];
    if (c >= 80 && c <= 82) return ['rain', 'Showers'];
    if (c === 85 || c === 86) return ['snow', 'Snow showers'];
    if (c >= 95) return ['storm', 'Thunderstorm'];
    return ['cloud', '--'];
};
const DIR8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const dir8 = (d) => (isNum(d) ? DIR8[Math.round(((d % 360) + 360) % 360 / 45) % 8] : '');
const hm = (iso) => (typeof iso === 'string' && iso.length >= 16 ? iso.substr(11, 5) : '--');
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const moonName = (p) => (!isNum(p) ? '' : p < 11 || p >= 349 ? 'New moon' : p < 79 ? 'Waxing crescent' : p < 101 ? 'First quarter'
    : p < 169 ? 'Waxing gibbous' : p < 191 ? 'Full moon' : p < 259 ? 'Waning gibbous' : p < 281 ? 'Last quarter' : 'Waning crescent');

const wxc = flow.get('wx');
const moon = flow.get('moon') || {};
let weather = { ok: false };
if (wxc && wxc.data && wxc.data.daily && wxc.data.current) {
    const d = wxc.data.daily, c = wxc.data.current;
    const day = (i) => {
        const date = d.time[i], m = moon[date] || {};
        const dt = new Date(date + 'T12:00:00Z');
        const ic = WMO(d.weather_code[i]);
        return {
            dow: DOW[dt.getUTCDay()], date: dt.getUTCDate() + ' ' + MON[dt.getUTCMonth()],
            ic: ic[0], txt: ic[1], max: r0(d.temperature_2m_max[i]), min: r0(d.temperature_2m_min[i]),
            ws: r0(d.wind_speed_10m_max[i]), wg: r0(d.wind_gusts_10m_max[i]), wd: dir8(d.wind_direction_10m_dominant[i]),
            pp: r0(d.precipitation_probability_max[i]), ps: r1(d.precipitation_sum[i]),
            sr: hm(d.sunrise[i]), ss: hm(d.sunset[i]), mr: hm(m.rise), ms: hm(m.set), mp: isNum(m.phase) ? Math.round(m.phase) : null,
        };
    };
    const ic = WMO(c.weather_code);
    const today = day(0);
    const mp = moon[d.time[0]] ? moon[d.time[0]].phase : null;
    weather = {
        ok: true,
        upd: new Date(wxc.t).toLocaleTimeString('en-GB', { timeZone: cfg.tz, hour: '2-digit', minute: '2-digit' }),
        old: now - wxc.t > 3 * 3600000,   // Vorhersage älter als 3 h (kein Internet)
        cur: { t: r0(c.temperature_2m), ic: ic[0], txt: ic[1], night: c.is_day === 0,
            ws: r0(c.wind_speed_10m), wg: r0(c.wind_gusts_10m), wd: dir8(c.wind_direction_10m) },
        today: today,
        mp: isNum(mp) ? Math.round(mp) : null, mpn: moonName(mp),
        days: [1, 2, 3].filter((i) => i < d.time.length).map(day),
    };
}

// ── Motor (SignalK propulsion.* — nur vorhanden, solange der Motor läuft) ──
const skE = flow.get('sk_prop');
const eTree = (skE && skE.data && typeof skE.data === 'object' && ageS(skE.t) < cfg.staleSec) ? skE.data : {};
const ORDER = { main: 0, port: 1, starboard: 2 };
const eId = Object.keys(eTree).filter((k) => eTree[k] && typeof eTree[k] === 'object')
    .sort((a, b) => (ORDER[a] !== undefined ? ORDER[a] : 9) - (ORDER[b] !== undefined ? ORDER[b] : 9) || a.localeCompare(b))[0];
const E = eId ? eTree[eId] : {};
const lv = (o) => (leaf(o) && isNum(o.value) && ageS(o.timestamp) < cfg.staleSec ? o.value : null);
const rpmHz = lv(E.revolutions);
const rpm = rpmHz != null ? Math.round(rpmHz * 60) : null;
const tempK = lv(E.temperature) != null ? lv(E.temperature) : lv(E.coolantTemperature);
const runS = lv(E.runTime);
const rateM3s = E.fuel ? lv(E.fuel.rate) : null;
// Letzte bekannte Werte merken (werden in engine.json auf dem Pi gesichert)
const last = flow.get('eng_last') || {};
if (runS != null) last.hours = runS / 3600;
if (tempK != null) last.tempC = tempK - 273.15;
if (runS != null || tempK != null) last.t = now;
flow.set('eng_last', last);
const running = rpm != null && rpm > 50;

// Verbrauch: Sensor (fuel.rate) bevorzugt, sonst Kurve l/h über Drehzahl, linear interpoliert
function curveLph(r) {
    const pts = String(cfg.fuelCurve).split(',').map((p) => p.split(':').map(Number))
        .filter((p) => p.length === 2 && isNum(p[0]) && isNum(p[1])).sort((a, b) => a[0] - b[0]);
    if (!pts.length) return null;
    if (r <= pts[0][0]) return pts[0][1] * r / pts[0][0];
    for (let i = 1; i < pts.length; i++) {
        if (r <= pts[i][0]) return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * (r - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]);
    }
    return pts[pts.length - 1][1];
}
let lph = null, est = false;
if (cfg.fuelUseSensor && rateM3s != null && rateM3s > 0) lph = rateM3s * 3.6e6;
else if (running) { lph = curveLph(rpm); est = true; }

// Dieseltank: tanks.fuel.* oder tanks.diesel.*
const tTree = (skT && skT.data) || {};
const fuelTanks = [];
['fuel', 'diesel'].forEach((type) => {
    const g = tTree[type];
    if (!g || typeof g !== 'object') return;
    Object.keys(g).forEach((k) => {
        const lvl = leaf(g[k] && g[k].currentLevel), cap = leaf(g[k] && g[k].capacity);
        fuelTanks.push({ id: type + '.' + k, lvl: lvl && isNum(lvl.value) && ageS(lvl.timestamp) < cfg.staleSec ? lvl.value : null,
            capL: cap && isNum(cap.value) ? cap.value * 1000 : null });
    });
});
fuelTanks.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
flow.set('fuel_list', fuelTanks.map((t) => ({ id: t.id, pct: t.lvl != null ? Math.round(t.lvl * 100) : null, capL: t.capL != null ? Math.round(t.capL) : null })));
let ft = cfg.fuelInstance !== 'auto' ? fuelTanks.find((t) => t.id === cfg.fuelInstance) : null;
if (!ft) ft = fuelTanks.find((t) => t.lvl != null) || null;
const fuelL = ft && ft.lvl != null && ft.capL != null ? ft.lvl * ft.capL : null;

// Reichweite bei aktuellem Verbrauch (+ SOG für Seemeilen)
const sogLeaf = skN && skN.data && leaf(skN.data.speedOverGround);
const sog = sogLeaf && isNum(sogLeaf.value) && ageS(sogLeaf.timestamp) < cfg.staleSec ? sogLeaf.value * MS2KN : null;
const rangeH = running && lph && fuelL != null ? fuelL / lph : null;
const engine = {
    on: running, rpm: rpm != null ? rpm : (eId ? 0 : null), max: cfg.engMaxRpm, red: cfg.engRedRpm,
    g0: cfg.engGreenFrom, g1: cfg.engGreenTo,
    temp: last.tempC != null ? Math.round(last.tempC) : null, tempLive: tempK != null,
    hrs: last.hours != null ? Math.round(last.hours * 10) / 10 : null,
    lph: lph != null ? Math.round(lph * 10) / 10 : null, est: est,
    fuelPct: ft && ft.lvl != null ? Math.round(ft.lvl * 100) : null, fuelL: fuelL != null ? Math.round(fuelL) : null,
    fuelCap: ft && ft.capL != null ? Math.round(ft.capL) : null,
    rangeH: rangeH != null ? Math.round(rangeH * 10) / 10 : null,
    rangeNm: rangeH != null && sog != null && sog > 0.5 ? Math.round(rangeH * sog) : null,
    sog: sog != null ? r1(sog) : null,
};

// ── Anker-Screen (Karte, Werte, Einstellungen) ───────────────────────────
const skD = flow.get('sk_depth');
const dLeaf = skD && skD.data && (leaf(skD.data.belowSurface) || leaf(skD.data.belowTransducer));
const depthM = dLeaf && isNum(dLeaf.value) && ageS(dLeaf.timestamp) < cfg.staleSec ? dLeaf.value : null;
const hdgLeaf = skN && skN.data && (leaf(skN.data.headingTrue) || leaf(skN.data.headingMagnetic));
const hdgDeg = hdgLeaf && isNum(hdgLeaf.value) && ageS(hdgLeaf.timestamp) < cfg.staleSec ? ((hdgLeaf.value * 180 / Math.PI) % 360 + 360) % 360 : null;
const toR = Math.PI / 180;
function bearingTo(la1, lo1, la2, lo2) {
    const y = Math.sin((lo2 - lo1) * toR) * Math.cos(la2 * toR);
    const x = Math.cos(la1 * toR) * Math.sin(la2 * toR) - Math.sin(la1 * toR) * Math.cos(la2 * toR) * Math.cos((lo2 - lo1) * toR);
    return (Math.atan2(y, x) / toR + 360) % 360;
}
// Track (Breadcrumb): alle 10 s eine Position, max. 2 h, nur solange der Anker aktiv ist
let track = flow.get('anc_track') || [];
if (anc && anc.active && posOk) {
    const lastT = track.length ? track[track.length - 1][0] : 0;
    if (now - lastT > 10000) track.push([now, pos.value.latitude, pos.value.longitude]);
} else if (anc && !anc.active) track = [];
track = track.filter((p) => now - p[0] < 2 * 3600000);
flow.set('anc_track', track);
const ancMap = {
    lat: anc && isNum(anc.lat) ? anc.lat : null, lon: anc && isNum(anc.lon) ? anc.lon : null,
    chain: anc && isNum(anc.chain_length_m) ? Math.round(anc.chain_length_m) : null,
    brg: anc && isNum(anc.bearing_deg) ? Math.round(anc.bearing_deg) : null,
    delay: anc && isNum(anc.alarm_delay_s) ? anc.alarm_delay_s : null,
    alarming: !!(anc && anc.alarming), muted: !!(anc && anc.alarm_telegram_muted),
    dset: anc && isNum(anc.anchor_depth_at_set) ? r1(anc.anchor_depth_at_set) : null,
    blat: posOk ? pos.value.latitude : null, blon: posOk ? pos.value.longitude : null,
    hdg: hdgDeg != null ? Math.round(hdgDeg) : null, depth: depthM != null ? r1(depthM) : null,
    btoa: null, scope: null, track: [],
};
if (ancMap.lat != null && ancMap.blat != null) {
    ancMap.btoa = Math.round(bearingTo(ancMap.blat, ancMap.blon, ancMap.lat, ancMap.lon));
    ancMap.boff = [Math.round((ancMap.blon - ancMap.lon) * 111320 * Math.cos(ancMap.lat * toR)), Math.round((ancMap.blat - ancMap.lat) * 111320)];
    const dist = anchor.dist;
    if (anc.active && dist != null && ancMap.dset != null && ancMap.dset > 0.5) ancMap.scope = r1(dist / ancMap.dset);
    // Track relativ zum Anker in Metern (Ost, Nord), max. 120 Punkte
    const mLat = 111320, mLon = 111320 * Math.cos(ancMap.lat * toR);
    const step = Math.max(1, Math.ceil(track.length / 120));
    ancMap.track = track.filter((_, i) => i % step === 0 || i === track.length - 1)
        .map((p) => [Math.round((p[2] - ancMap.lon) * mLon), Math.round((p[1] - ancMap.lat) * mLat)]);
}
anchor.map = ancMap;

// ── Test-Alarm ────────────────────────────────────────────────────────────
if (cfg.testUntil && now < cfg.testUntil) alarms.push({ key: 'test', text: 'TEST ALARM' });

// ── Quittierung: gilt nur für die Alarme, die beim Quittieren aktiv waren ──
const ack = flow.get('ack') || { until: 0, keys: [] };
const acked = now < ack.until;
const blink = alarms.some((a) => !acked || ack.keys.indexOf(a.key) < 0);

const state = {
    v: 1,
    ts: Math.round(now / 1000),
    time: new Date(now).toLocaleTimeString('en-GB', { timeZone: cfg.tz, hour: '2-digit', minute: '2-digit' }),
    utc: new Date(now).toISOString().slice(11, 16),
    status: alarms.length ? 'alarm' : (warns.length ? 'warn' : 'ok'),
    blink: blink,
    night: !!cfg.night,
    // Ton am Display: 'full' = Piepen im Blinktakt, 'short' = kurzer Pieps alle 2 s, 'off'
    beep: !blink || !cfg.soundOn ? 'off' : (cfg.night ? cfg.soundNight : 'full'),
    acked: alarms.length > 0 && !blink,
    msg: alarms.length ? alarms.map((a) => a.text).join('  |  ') : warns.join('  |  '),
    batt: batt,
    energy: energy,
    weather: weather,
    engine: engine,
    water: water,
    wind: wind,
    baro: baro,
    anchor: anchor,
    alarmKeys: alarms.map((a) => a.key),
};
flow.set('state', state);
return null;
