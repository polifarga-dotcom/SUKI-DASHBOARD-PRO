// ESP32 Mini Dashboard — Auswertung (läuft jede Sekunde)
// Liest die zwischengespeicherten SignalK-/Supabase-Daten aus dem Flow-Context,
// wertet Schwellwerte mit Hysterese aus und legt den fertigen Display-State
// in flow.state ab. Der ESP32 und der Browser-Simulator holen nur noch diesen
// State ab — die gesamte Logik lebt hier, die Firmware ist ein reines Display.

const DEF = {
    windAlarmOn: true, windAlarmKn: 25, windHystKn: 2, windSource: 'auto', windAvgSec: 10, windWinMin: 2,
    battAlarmOn: true, battLowSoc: 30, battHystSoc: 3, battLowVolt: 0, battInstance: 'auto',
    waterAlarmOn: true, waterLowPct: 15, waterHystPct: 3, waterInstance: 'auto',
    sailStyle: 'tacho', sailCloseFrom: 30, sailCloseTo: 50,
    aisMode: 'cruising', aisCruiseNm: 0.5, aisOffshoreNm: 2, aisTcpaMin: 20, aisRangeNm: 2,
    sosPob: 2, sosDesc: 'sailing trimaran, 14 metres',
    bwSwap: false, bwWarnPct: 75, bwHighPct: 90, fuelWarnPct: 20, fuelLowPct: 10,
    rigAlarmOn: true, rigWarnT: 3.2, rigAlarmT: 4.2, rigHystT: 0.1, rigScaleT: 5,
    engTempAlarmOn: true, engTempWarnC: 90, engTempAlarmC: 95, engTempHystC: 2,
    engMaxRpm: 3000, engRedRpm: 2500, engGreenFrom: 1800, engGreenTo: 2200, fuelInstance: 'auto', fuelUseSensor: true,
    fuelCurve: '800:0.8,1000:1.2,1500:2.2,2000:3.8,2500:6.2,3000:9.5',
    baroAlarmOn: true, baroLowHpa: 995, baroHystHpa: 1, baroWinMin: 2,
    anchorAlarmOn: true, stormAlarmOn: true, anchorLocalFallback: true,
    ackMinutes: 5, staleSec: 30, testUntil: 0, night: false,
    soundOn: true, soundNight: 'short',
};
const cfg = Object.assign({}, DEF, flow.get('cfg') || {});
// Zeitzone automatisch aus der GPS-Position (Open-Meteo, IANA-Name → Sommer-/Winterzeit automatisch);
// zuletzt bekannte Zone ist in config.json gesichert (tzAuto), ohne Daten gilt UTC
const tz = flow.get('tz_auto') || cfg.tzAuto || 'UTC';
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
    const pvYest = vicKeys(/^solarcharger\/\d+\/History\/Daily\/1\/Yield$/);
    // weitere Batterien (alle außer dem aktiven Batteriemonitor) und einzelne MPPTs, wie in der Pro App
    const inst = (re) => [...new Set(Object.keys(vic).map((k) => (re.exec(k) || [])[1]).filter(Boolean))];
    const primB = (/battery\/(\d+)/.exec(String(vic['system/0/ActiveBatteryService'] || '')) || [])[1];
    const r2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);
    const bats = inst(/^battery\/(\d+)\//).filter((i) => i !== primB && isNum(vic['battery/' + i + '/Dc/0/Voltage']))
        .map((i) => ({ n: String(vic['battery/' + i + '/CustomName'] || 'Battery ' + i).slice(0, 16),
            soc: r0(vic['battery/' + i + '/Soc']), v: r2(vic['battery/' + i + '/Dc/0/Voltage']), a: r1(vic['battery/' + i + '/Dc/0/Current']) }))
        .sort((a, b) => a.n.localeCompare(b.n));
    const mppts = inst(/^solarcharger\/(\d+)\//).filter((i) => isNum(vic['solarcharger/' + i + '/Yield/Power']))
        .map((i) => ({ n: String(vic['solarcharger/' + i + '/CustomName'] || 'MPPT ' + i).slice(0, 14),
            w: r0(vic['solarcharger/' + i + '/Yield/Power']), kwh: r2(vic['solarcharger/' + i + '/History/Daily/0/Yield']) }))
        .sort((a, b) => a.n.localeCompare(b.n));
    energy = {
        ok: true,
        shore: { on: src != null && src !== 240 && ((shoreW || 0) > 5 || (shoreV || 0) > 50), w: r0(shoreW), v: r0(shoreV) },
        inv: { st: SYS_STATE[V('SystemState/State')] || '--', w: r0(invP) },
        ac: { w: r0(sumPh('Ac/ConsumptionOnOutput') != null ? sumPh('Ac/ConsumptionOnOutput') : sumPh('Ac/Consumption')) },
        pv: { w: r0(V('Dc/Pv/Power')), a: r1(V('Dc/Pv/Current')),
            today: pvDay.length ? Math.round(pvDay.reduce((a, b) => a + b, 0) * 100) / 100 : null,
            yest: pvYest.length ? Math.round(pvYest.reduce((a, b) => a + b, 0) * 100) / 100 : null, mppts: mppts.slice(0, 6) },
        bat: { soc: r0(V('Dc/Battery/Soc')), v: V('Dc/Battery/Voltage') != null ? Math.round(V('Dc/Battery/Voltage') * 100) / 100 : null,
            a: r1(V('Dc/Battery/Current')), w: r0(V('Dc/Battery/Power')),
            st: ['Idle', 'Charging', 'Discharging'][bState] || '--', ttg: fmtTTG(V('Dc/Battery/TimeToGo')),
            n: primB && vic['battery/' + primB + '/CustomName'] ? String(vic['battery/' + primB + '/CustomName']).slice(0, 16) : '' },
        bats: bats.slice(0, 3),
        dc: { w: r0(V('Dc/System/Power')) },
    };
}
// Verbrauchs-/Ertragsverlauf der letzten 10 min (Hintergrund-Diagramm in Solar, AC Loads, DC Loads): 60 Mittelwerte
{
    let eh = (flow.get('energy_hist') || []).filter((h) => now - h[0] < 600000);
    if (energy.ok && (!eh.length || now - eh[eh.length - 1][0] >= 1000)) eh.push([now, energy.pv.w, energy.ac.w, energy.dc.w]);
    flow.set('energy_hist', eh);
    if (energy.ok) {
        const EW = 600000, ES = now - EW, EN = 60;
        const bucket = (k) => {
            const sum = new Array(EN).fill(0), cnt = new Array(EN).fill(0);
            for (const h of eh) {
                if (!isNum(h[k])) continue;
                const i = Math.min(EN - 1, Math.floor((h[0] - ES) / EW * EN));
                sum[i] += h[k]; cnt[i]++;
            }
            return sum.map((v, i) => (cnt[i] ? Math.round(v / cnt[i]) : null));
        };
        energy.pv.hist = bucket(1); energy.ac.hist = bucket(2); energy.dc.hist = bucket(3);
    }
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
    // Tagesverlauf: 4 Abschnitte ab dem aktuellen (MORNING 06–12, MIDDAY 12–18, EVENING 18–22, NIGHT 22–06),
    // aus den Stundenwerten; der laufende Abschnitt zählt erst ab der aktuellen Stunde
    const parts = [];
    const hh = wxc.data.hourly;
    if (hh && Array.isArray(hh.time)) {
        const loc = new Date(now).toLocaleString('sv-SE', { timeZone: tz });   // "2026-10-07 10:23:00"
        const h = +loc.substr(11, 2), i0 = hh.time.indexOf(loc.substr(0, 10) + 'T' + loc.substr(11, 2) + ':00');
        const PD = [['MORNING', 6, 6], ['MIDDAY', 12, 6], ['EVENING', 18, 4], ['NIGHT', 22, 8]];
        let pi = h >= 6 && h < 12 ? 0 : h >= 12 && h < 18 ? 1 : h >= 18 && h < 22 ? 2 : 3;
        let st = i0 - ((h - PD[pi][1] + 24) % 24);   // Index des Abschnittsbeginns
        const today0 = loc.substr(0, 10);
        for (let k = 0; i0 >= 0 && k < 4; k++) {
            const [lbl, sh, len] = PD[pi];
            const a = k === 0 ? i0 : st, b = Math.min(st + len, hh.time.length);
            let tmax = -99, tmin = 99, code = 0, ws = 0, wg = 0, pp = 0, ps = 0, u = 0, v = 0, dayN = 0, n = 0;
            for (let i = a; i < b; i++) {
                if (!isNum(hh.temperature_2m[i])) continue;
                n++;
                tmax = Math.max(tmax, hh.temperature_2m[i]); tmin = Math.min(tmin, hh.temperature_2m[i]);
                code = Math.max(code, hh.weather_code[i] || 0);
                ws = Math.max(ws, hh.wind_speed_10m[i] || 0); wg = Math.max(wg, hh.wind_gusts_10m[i] || 0);
                pp = Math.max(pp, hh.precipitation_probability[i] || 0); ps += hh.precipitation[i] || 0;
                const wr = (hh.wind_direction_10m[i] || 0) * Math.PI / 180, sp = hh.wind_speed_10m[i] || 0;
                u += Math.sin(wr) * sp; v += Math.cos(wr) * sp;
                if (hh.is_day[i]) dayN++;
            }
            if (n) {
                const date = hh.time[st].substr(0, 10), wic = WMO(code);
                parts.push({ lbl, hrs: (k === 0 ? 'now' : String(sh).padStart(2, '0')) + '–' + String((sh + len) % 24).padStart(2, '0'),
                    dl: k === 0 || date === today0 ? '' : DOW[new Date(date + 'T12:00:00Z').getUTCDay()],
                    ic: wic[0], txt: wic[1], night: dayN * 2 < n, max: r0(tmax), min: r0(tmin),
                    ws: r0(ws), wg: r0(wg), wd: dir8((Math.atan2(u, v) * 180 / Math.PI + 360) % 360), pp: r0(pp), ps: r1(ps) });
            }
            st += len; pi = (pi + 1) % 4;
        }
    }
    const mp = moon[d.time[0]] ? moon[d.time[0]].phase : null;
    weather = {
        ok: true,
        upd: new Date(wxc.t).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }),
        old: now - wxc.t > 3 * 3600000,   // Vorhersage älter als 3 h (kein Internet)
        cur: { t: r0(c.temperature_2m), ic: ic[0], txt: ic[1], night: c.is_day === 0,
            ws: r0(c.wind_speed_10m), wg: r0(c.wind_gusts_10m), wd: dir8(c.wind_direction_10m) },
        today: today,
        mp: isNum(mp) ? Math.round(mp) : null, mpn: moonName(mp),
        days: [1, 2, 3].filter((i) => i < d.time.length).map(day),
        parts: parts,
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
// Kurs: rechtweisend bevorzugt, aber nur wenn frisch — sonst missweisend (SignalK liefert headingTrue teils selten)
const hdgFresh = (k) => { const l = skN && skN.data && leaf(skN.data[k]); return l && isNum(l.value) && ageS(l.timestamp) < cfg.staleSec ? l : null; };
const hdgLeaf = hdgFresh('headingTrue') || hdgFresh('headingMagnetic');
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

// ── Segeln: Wind (B&G-Stil) + Rigg-Loadsensoren (Cyclops, rigging.*.tension in N) ──
const N_PER_T = 9806.65;
const skR = flow.get('sk_rig');
const rTree = (skR && skR.data && typeof skR.data === 'object' && ageS(skR.t) < cfg.staleSec) ? skR.data : {};
// Der Cyclops-Gateway benennt die Pfade nach dem Sensornamen (rigging.<name>.tension) —
// Namen wie port/bb/backbord bzw. starboard/stbd/sb/steuerbord werden automatisch zugeordnet.
const rigKeys = Object.keys(rTree).filter((k) => rTree[k] && rTree[k].tension);
const rigKey = (side) => {
    const re = side === 'port' ? /(^|_)(port|bb|backbord|p|left)(_|$)|port|backbord/i
        : /(^|_)(starboard|stbd|stb|sb|steuerbord|s|right)(_|$)|starboard|steuerbord/i;
    return rigKeys.find((k) => k === side) || rigKeys.find((k) => re.test(k)) || null;
};
flow.set('rig_keys', rigKeys);
const rigSide = (side) => {
    const k = rigKey(side);
    const l = k && leaf(rTree[k].tension);
    return l && isNum(l.value) && ageS(l.timestamp) < cfg.staleSec ? l.value / N_PER_T : null;
};
const rig = { port: null, sb: null, pst: 'na', sst: 'na', warn: cfg.rigWarnT, alarm: cfg.rigAlarmT, scale: cfg.rigScaleT };
[['port', 'pst', 'rigPortHigh', 'PORT'], ['starboard', 'sst', 'rigSbHigh', 'STBD']].forEach(([side, stKey, ctxKey, label]) => {
    const t = rigSide(side);
    const key = side === 'port' ? 'port' : 'sb';
    if (t == null) { context.set(ctxKey, false); return; }
    rig[key] = Math.round(t * 100) / 100;
    // Alarm erst über rigAlarmT, endet unter rigAlarmT − Hysterese; orange = Warnbereich ohne Blinken
    let high = context.get(ctxKey) || false;
    if (!high && t > cfg.rigAlarmT) high = true;
    else if (high && t < cfg.rigAlarmT - cfg.rigHystT) high = false;
    context.set(ctxKey, high);
    rig[stKey] = high ? 'alarm' : t > cfg.rigWarnT ? 'warn' : 'ok';
    if (high && cfg.rigAlarmOn) alarms.push({ key: 'rig_' + key, text: `RIG ${label} ${rig[key].toFixed(2)} t > ${cfg.rigAlarmT} t` });
});
const wAng = leaf(wTree.angleApparent), tAng = leaf(wTree.angleTrueWater) || leaf(wTree.angleTrueGround);
const fresh = (l) => l && isNum(l.value) && ageS(l.timestamp) < cfg.staleSec;
const signedDeg = (rad) => { let d = rad * 180 / Math.PI; d = ((d + 180) % 360 + 360) % 360 - 180; return Math.round(d); };
const stwL = skN && skN.data && leaf(skN.data.speedThroughWater);
// AWS-Verlauf (eigener Verlauf, unabhängig von der Windquelle auf Screen 1)
let awsHist = flow.get('aws_hist') || [];
if (fresh(aws)) {
    const t = new Date(aws.timestamp).getTime();
    if (!awsHist.length || awsHist[awsHist.length - 1][0] !== t) awsHist.push([t, aws.value * MS2KN]);
}
awsHist = awsHist.filter((h) => now - h[0] < 6 * 3600000);
flow.set('aws_hist', awsHist);
const awWin = cfg.windWinMin * 60000, awStart = now - awWin;
const awSum = new Array(60).fill(0), awCnt = new Array(60).fill(0);
for (const h of awsHist) {
    if (h[0] < awStart) continue;
    const i = Math.min(59, Math.floor((h[0] - awStart) / awWin * 60));
    awSum[i] += h[1]; awCnt[i]++;
}
const aws10 = awsHist.filter((h) => now - h[0] < 600000).map((h) => h[1]);
const sail = {
    awsHist: awSum.map((v, i) => (awCnt[i] ? Math.round(v / awCnt[i] * 10) / 10 : null)),
    awsMax: aws10.length ? r1(Math.max.apply(null, aws10)) : null, win: cfg.windWinMin, style: cfg.sailStyle, cf: cfg.sailCloseFrom, ct: cfg.sailCloseTo,
    aws: fresh(aws) ? r1(aws.value * MS2KN) : null, awa: fresh(wAng) ? signedDeg(wAng.value) : null,
    tws: null, twa: null, twd: null, twCalc: false,
    stw: fresh(stwL) ? r1(stwL.value * MS2KN) : null, sog: sog != null ? r1(sog) : null,
    hdg: hdgDeg != null ? Math.round(hdgDeg) : null,
    rig: rig,
};

// Wahrer Wind: B&G-Werte bevorzugt, sonst selbst aus AWS/AWA + Fahrt durchs Wasser (Fallback SOG) berechnen
if (fresh(tws) && fresh(tAng)) {
    sail.tws = r1(tws.value * MS2KN); sail.twa = signedDeg(tAng.value);
} else if (fresh(aws) && fresh(wAng)) {
    const bs = fresh(stwL) ? stwL.value : (sogLeaf && isNum(sogLeaf.value) && ageS(sogLeaf.timestamp) < cfg.staleSec ? sogLeaf.value : 0);
    const u = aws.value * Math.cos(wAng.value) - bs, v = aws.value * Math.sin(wAng.value);
    sail.tws = r1(Math.sqrt(u * u + v * v) * MS2KN);
    sail.twa = signedDeg(Math.atan2(v, u));
    sail.twCalc = true;
}
// TWD (aus welcher Kompassrichtung der Wind weht): B&G directionTrue, sonst Kurs + TWA
const twdL = leaf(wTree.directionTrue);
if (fresh(twdL)) sail.twd = Math.round(((twdL.value * 180 / Math.PI) % 360 + 360) % 360);
else if (sail.twa != null && hdgDeg != null) sail.twd = Math.round(((hdgDeg + sail.twa) % 360 + 360) % 360);

// ── Tank-Screen: Water, Diesel, Black Main, Black Guest ──────────────────
const bwTree = (skT && skT.data && skT.data.blackWater && typeof skT.data.blackWater === 'object') ? skT.data.blackWater : {};
const bw = Object.keys(bwTree).filter((k) => bwTree[k] && typeof bwTree[k] === 'object').map((k) => {
    const lvl = leaf(bwTree[k].currentLevel), cap = leaf(bwTree[k].capacity);
    return { id: k, lvl: lvl && isNum(lvl.value) && ageS(lvl.timestamp) < cfg.staleSec ? lvl.value : null,
        capL: cap && isNum(cap.value) ? cap.value * 1000 : null };
}).sort((a, b) => (parseFloat(a.id) || 0) - (parseFloat(b.id) || 0));
if (cfg.bwSwap) bw.reverse();     // kleinste Instanz = Main (wie Pro App), per Setting tauschbar
const tankObj = (name, kind, pct, capL, st) => ({
    name, kind, pct: pct != null ? Math.round(pct) : null,
    l: pct != null && capL != null ? Math.round(capL * pct / 100) : null, cap: capL != null ? Math.round(capL) : null, st,
});
const bwSt = (p) => (p == null ? 'na' : p >= cfg.bwHighPct ? 'high' : p >= cfg.bwWarnPct ? 'warn' : 'ok');
const fuelPct = ft && ft.lvl != null ? ft.lvl * 100 : null;
const tanksScreen = [
    tankObj('WATER', 'water', water.pct, water.cap, water.st === 'alarm' ? 'high' : water.pct == null ? 'na' : 'ok'),
    tankObj('DIESEL', 'fuel', fuelPct, ft && ft.capL, fuelPct == null ? 'na' : fuelPct < cfg.fuelLowPct ? 'high' : fuelPct < cfg.fuelWarnPct ? 'warn' : 'ok'),
    tankObj('BLACK MAIN', 'black', bw[0] && bw[0].lvl != null ? bw[0].lvl * 100 : null, bw[0] && bw[0].capL, bwSt(bw[0] && bw[0].lvl != null ? bw[0].lvl * 100 : null)),
    tankObj('BLACK GUEST', 'black', bw[1] && bw[1].lvl != null ? bw[1].lvl * 100 : null, bw[1] && bw[1].capL, bwSt(bw[1] && bw[1].lvl != null ? bw[1].lvl * 100 : null)),
];

// ── SOS-Screen: VHF-Notruftexte (MAYDAY / PAN PAN) mit Live-Position ──────
const idv = (k) => { const v = flow.get('sk_' + k); return v ? v.data : null; };
const NATO = { A: 'ALFA', B: 'BRAVO', C: 'CHARLIE', D: 'DELTA', E: 'ECHO', F: 'FOXTROT', G: 'GOLF', H: 'HOTEL', I: 'INDIA',
    J: 'JULIETT', K: 'KILO', L: 'LIMA', M: 'MIKE', N: 'NOVEMBER', O: 'OSCAR', P: 'PAPA', Q: 'QUEBEC', R: 'ROMEO', S: 'SIERRA',
    T: 'TANGO', U: 'UNIFORM', V: 'VICTOR', W: 'WHISKEY', X: 'X-RAY', Y: 'YANKEE', Z: 'ZULU',
    0: 'ZERO', 1: 'ONE', 2: 'TWO', 3: 'THREE', 4: 'FOUR', 5: 'FIVE', 6: 'SIX', 7: 'SEVEN', 8: 'EIGHT', 9: 'NINE' };
const vName = typeof idv('id_name') === 'string' ? idv('id_name').toUpperCase() : 'SUKI';
const vMmsi = typeof idv('id_mmsi') === 'string' ? idv('id_mmsi') : null;
const vCs = idv('id_comm') && typeof idv('id_comm').callsignVhf === 'string' ? idv('id_comm').callsignVhf.toUpperCase() : null;
// Position zum Vorlesen: Grad, Minuten, Sekunden + Himmelsrichtung ausgeschrieben
const spoken = (v, isLat) => {
    const a = Math.abs(v);
    let d = Math.floor(a), m = Math.floor((a - d) * 60), sec = Math.round(((a - d) * 60 - m) * 60);
    if (sec === 60) { sec = 0; m++; } if (m === 60) { m = 0; d++; }
    return d + ' DEGREES ' + m + ' MINUTES ' + sec + ' SECONDS ' + (isLat ? (v >= 0 ? 'NORTH' : 'SOUTH') : (v >= 0 ? 'EAST' : 'WEST'));
};
const sos = {
    name: vName, cs: vCs, mmsi: vMmsi,
    mmsiFmt: vMmsi ? vMmsi.replace(/(\d{3})(?=\d)/g, '$1 ') : null,
    csPhon: vCs ? vCs.split('').map((c) => NATO[c] || c).join(' ') : null,
    lat: posOk ? spoken(pos.value.latitude, true) : null, lon: posOk ? spoken(pos.value.longitude, false) : null,
    utc: 'TIME ' + new Date(now).toISOString().substr(11, 5) + ' UTC',
    pob: cfg.sosPob, desc: String(cfg.sosDesc || '').toUpperCase(),
};

// Motortemperatur-Alarm (nur mit Live-Daten, also bei laufendem Motor): Volvo Penta D2-60 —
// Thermostat öffnet 75 °C, voll offen 87 °C → Warnung ab 90 °C, Alarm ab 95 °C (einstellbar)
engine.twarn = cfg.engTempWarnC; engine.talarm = cfg.engTempAlarmC; engine.tst = 'na';
if (tempK != null) {
    const tc = tempK - 273.15;
    let hot = context.get('engHot') || false;
    if (!hot && tc >= cfg.engTempAlarmC) hot = true;
    else if (hot && tc < cfg.engTempAlarmC - cfg.engTempHystC) hot = false;
    context.set('engHot', hot);
    engine.tst = hot && cfg.engTempAlarmOn ? 'alarm' : tc >= cfg.engTempWarnC ? 'warn' : 'ok';
    if (engine.tst === 'alarm') alarms.push({ key: 'engtemp', text: `ENGINE TEMP ${Math.round(tc)} C >= ${cfg.engTempAlarmC} C` });
} else context.set('engHot', false);

// Ecken am Drehzahlmesser: SOG, AWS, AWA, Wassertemperatur
const skWt = flow.get('sk_water');
const wtL = skWt && skWt.data && leaf(skWt.data.temperature);
engine.sog = sog != null ? r1(sog) : null;
engine.aws = sail.aws;
engine.awa = sail.awa;
engine.wtemp = wtL && isNum(wtL.value) && ageS(wtL.timestamp) < 120 ? r1(wtL.value - 273.15) : null;

// ── AIS: Radar, CPA/TCPA, Annäherungsalarm ────────────────────────────────
// Modi: anchor = kein Alarm, cruising = CPA < aisCruiseNm, offshore = CPA < aisOffshoreNm (jeweils TCPA < aisTcpaMin)
const NM = 1852;
const aisTab = flow.get('ais') || {};
const ownCogL = skN && skN.data && leaf(skN.data.courseOverGroundTrue);
const ownCog = ownCogL && isNum(ownCogL.value) && ageS(ownCogL.timestamp) < 60 ? ownCogL.value : 0;
const ownSog = sogLeaf && isNum(sogLeaf.value) && ageS(sogLeaf.timestamp) < cfg.staleSec ? sogLeaf.value : 0;
const aisThrNm = cfg.aisMode === 'offshore' ? cfg.aisOffshoreNm : cfg.aisMode === 'cruising' ? cfg.aisCruiseNm : null;
const ais = { mode: cfg.aisMode, thr: aisThrNm, cn: cfg.aisCruiseNm, on: cfg.aisOffshoreNm, own: !!posOk, targets: [], n: 0, alarms: 0 };
if (posOk) {
    const la0 = pos.value.latitude, lo0 = pos.value.longitude, mLon = 111320 * Math.cos(la0 * toR);
    const vo = [Math.sin(ownCog) * ownSog, Math.cos(ownCog) * ownSog];   // eigene Geschwindigkeit (Ost, Nord) m/s
    const list = [];
    for (const k of Object.keys(aisTab)) {
        const t = aisTab[k];
        if (!isNum(t.lat) || !isNum(t.lon)) continue;
        const age = (now - (t.tPos || 0)) / 1000;
        if (age > 1200) { delete aisTab[k]; continue; }                 // 20 min ohne Position → entfernen
        const e = (t.lon - lo0) * mLon, n = (t.lat - la0) * 111320;
        const dist = Math.sqrt(e * e + n * n);
        if (dist > 24 * NM) continue;
        const ts = isNum(t.sog) ? t.sog : 0, tc = isNum(t.cog) ? t.cog : 0;
        const rv = [Math.sin(tc) * ts - vo[0], Math.cos(tc) * ts - vo[1]];   // relative Geschwindigkeit
        const v2 = rv[0] * rv[0] + rv[1] * rv[1];
        let tcpa = v2 > 1e-4 ? -(e * rv[0] + n * rv[1]) / v2 : 0;      // s
        const cpa = tcpa > 0 ? Math.hypot(e + rv[0] * tcpa, n + rv[1] * tcpa) : dist;
        if (tcpa < 0) tcpa = 0;
        const stale = age > 600;
        let st = 'ok';
        if (aisThrNm != null && !stale) {
            const thrM = aisThrNm * NM, tWin = cfg.aisTcpaMin * 60;
            if (cpa < thrM && tcpa > 0 && tcpa < tWin) st = 'alarm';
            else if (cpa < thrM * 2 && tcpa > 0 && tcpa < tWin * 2) st = 'warn';
        }
        list.push({ m: String(t.mmsi || ''), nm: t.name || '', e: Math.round(e), n: Math.round(n),
            cog: Math.round(tc * 180 / Math.PI), sog: r1(ts * MS2KN), hdg: isNum(t.hdg) ? Math.round(t.hdg * 180 / Math.PI) : null,
            d: Math.round(dist / NM * 100) / 100, b: Math.round(((Math.atan2(e, n) / toR) + 360) % 360),
            cpa: Math.round(cpa / NM * 100) / 100, tcpa: tcpa > 0 ? Math.round(tcpa / 6) / 10 : null,
            st, stale, age: Math.round(age), cs: t.cs || '', ty: t.type || '', len: isNum(t.len) ? Math.round(t.len) : null,
            dest: t.dest || '', nav: typeof t.state === 'string' ? t.state : '' });
    }
    flow.set('ais', aisTab);
    // gefährlichste zuerst, dann nach Distanz; max. 30 Ziele ans Display
    const rank = { alarm: 0, warn: 1, ok: 2 };
    list.sort((a, b) => rank[a.st] - rank[b.st] || a.d - b.d);
    ais.n = list.length;
    ais.targets = list.slice(0, 30);
    for (const t of list) {
        if (t.st !== 'alarm') continue;
        ais.alarms++;
        alarms.push({ key: 'ais_' + t.m, text: `AIS ${t.nm || t.m} CPA ${t.cpa.toFixed(2)} NM in ${t.tcpa != null ? Math.round(t.tcpa) : 0} min` });
    }
    ais.ownCog = Math.round(ownCog * 180 / Math.PI); ais.ownSog = r1(ownSog * MS2KN);
}
// Heading-up: Bildschirm nach eigenem Heading drehen; ohne Heading COG (nur in Fahrt), sonst Nord oben
ais.up = hdgDeg != null ? Math.round(hdgDeg) : ownSog * MS2KN > 1 ? Math.round(ownCog * 180 / Math.PI) : null;
ais.upSrc = hdgDeg != null ? 'HDG' : ais.up != null ? 'COG' : 'N';

// ── Gewitterwarnung (MeteoAlarm): Orange/Rot = Alarm (4 h quittierbar), Gelb = Hinweis ──
const stc = flow.get('storm');
const storm = { on: cfg.stormAlarmOn !== false, lvl: null, region: (stc && stc.region) || '', to: null,
    fresh: !!(stc && now - stc.t < 3 * 3600000) };
if (storm.on && stc && storm.fresh) {
    const RANK = { yellow: 1, orange: 2, red: 3 };
    const act = (stc.list || []).filter((w) => w.from <= now && now <= w.to).sort((a, b) => RANK[b.lvl] - RANK[a.lvl]);
    const best = act[0];
    const hhmm = (ms) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
    if (best) {
        storm.lvl = best.lvl; storm.to = hhmm(best.to); storm.region = best.area;
        const txt = `THUNDERSTORM ${best.lvl.toUpperCase()} until ${hhmm(best.to)} (${best.area})`;
        if (best.lvl === 'yellow') {
            // Gelb: Hinweis, per Tipp 4 h ausblendbar; Schlüssel mit Ende der Warnung → eine neue Warnung erscheint wieder
            const nk = 'storm_yellow@' + best.to, ku = (flow.get('ack') || {}).kUntil || {};
            if (!(ku[nk] > now)) { warns.push(txt); storm.noteKey = nk; } else storm.noteAcked = true;
        } else alarms.push({ key: 'storm_' + best.lvl, text: txt });
    } else if (!storm.region) {
        // keine MeteoAlarm-Region (außerhalb Europas / weit auf See): nur Hinweis aus der Open-Meteo-Vorhersage
        const hh = wxc && wxc.data && wxc.data.hourly;
        if (hh && Array.isArray(hh.time)) {
            const loc = new Date(now).toLocaleString('sv-SE', { timeZone: tz });
            const i0 = hh.time.indexOf(loc.substr(0, 10) + 'T' + loc.substr(11, 2) + ':00');
            if (i0 >= 0 && hh.weather_code.slice(i0, i0 + 3).some((c) => c >= 95)) warns.push('Thunderstorm forecast next 2 h (no official warning area)');
        }
    }
} else if (storm.on && stc && !storm.fresh) {
    warns.push('Thunderstorm warnings not updated');
}

// ── Test-Alarm ────────────────────────────────────────────────────────────
if (cfg.testUntil && now < cfg.testUntil) alarms.push({ key: 'test', text: 'TEST ALARM' });

// ── Quittierung: gilt nur für die Alarme, die beim Quittieren aktiv waren ──
const ack = flow.get('ack') || { until: 0, keys: [] };
// je Alarm eigene Quittierdauer (kUntil), ältere Form { until, keys } weiter verstehen
const kU = ack.kUntil || {};
const isAcked = (k) => (kU[k] != null ? now < kU[k] : now < ack.until && ack.keys.indexOf(k) >= 0);
const blink = alarms.some((a) => !isAcked(a.key));

const state = {
    v: 1,
    ts: Math.round(now / 1000),
    time: new Date(now).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }),
    tz: tz,
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
    storm: storm,
    engine: engine,
    tanks: tanksScreen,
    sos: sos,
    ais: ais,
    sail: sail,
    water: water,
    wind: wind,
    baro: baro,
    anchor: anchor,
    alarmKeys: alarms.map((a) => a.key),
};
flow.set('state', state);
return null;
