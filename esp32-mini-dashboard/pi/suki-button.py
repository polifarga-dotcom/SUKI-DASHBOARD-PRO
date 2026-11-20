#!/usr/bin/env python3
# Funk-Taster an der Steuerstation: Shelly BLU Button Tough 1 (SBBT-002C, BTHome v2 über Bluetooth LE).
# Der Pi liest die Werbepakete direkt mit (kein Shelly-Gateway nötig) und löst über Node-RED aus:
#   1× = alle Alarme quittieren (wie Taste am Mini Dash; bei Wachalarm zusätzlich Wache bestätigen)
#   2× = Wache bestätigen
#   3× = Anker setzen ("Drop Anchor Now": Bugposition, Radius 6 × Tiefe) – nur unter 1 kn und ohne aktiven Anker
#   lang = Anker aufholen (nur wenn ein Anker aktiv ist)
# Rückmeldung über den Piezo an GPIO17: 1/2/3 kurze Töne = erledigt, 2 lange = Anker auf, 1 sehr langer = abgelehnt.
#
#   suki-button             Dienst (nur angelernte Taster aus config.json)
#   suki-button --learn     60 s lauschen, den ersten gedrückten Shelly-Taster anlernen
#   suki-button --press N   Aktion N (1, 2, 3, 4=lang) ohne Taster auslösen
#   --dry                   Anker-Aktionen nur prüfen (Node-RED dry run), nichts setzen
#   suki-button --selftest
import asyncio, json, os, subprocess, sys, time, urllib.request

CFG = os.path.expanduser('~/suki-button/config.json')
NR = 'http://127.0.0.1:1880/esp-dash/api'
SHARED = 'http://127.0.0.1:8091/tiles/api/shared'  # chart-proxy: Wachalarm aller Geräte
BTHOME = '0000fcd2-0000-1000-8000-00805f9b34fb'
PIN = '17'
DRY = '--dry' in sys.argv
EVENTS = {1: 'press', 2: 'double', 3: 'triple', 4: 'long'}

# BTHome-v2-Objekte: ID → Länge in Bytes (nur was Shelly-Taster senden; Unbekanntes beendet das Lesen)
OBJ_LEN = {0x00: 1, 0x01: 1, 0x3A: 1, 0x3C: 2, 0x2D: 1, 0x2E: 1}


def parse(data: bytes):
    """BTHome v2 Service-Data → {'pid':…, 'battery':…, 'button':…}; None bei verschlüsselt/ungültig"""
    if not data or data[0] & 0x01 or (data[0] >> 5) != 2:
        return None  # shortcut: verschlüsselter Modus nicht unterstützt (MAC-Filter statt Schlüssel), bei Bedarf AES-CCM ergänzen
    out, i = {}, 1
    while i < len(data):
        oid = data[i]
        n = OBJ_LEN.get(oid)
        if n is None or i + 1 + n > len(data):
            break
        v = int.from_bytes(data[i + 1:i + 1 + n], 'little')
        if oid == 0x00: out['pid'] = v
        elif oid == 0x01: out['battery'] = v
        elif oid == 0x3A and 'button' not in out: out['button'] = v
        i += 1 + n
    return out


def beep(*ms):
    """Töne (an, aus, an, …) in ms; teilt sich GPIO17 mit suki-buzzer (der schreibt nur bei Wechseln)"""
    for k, d in enumerate(ms):
        subprocess.run(['pinctrl', 'set', PIN, 'op', 'dh' if k % 2 == 0 else 'dl'], check=False)
        time.sleep(d / 1000)
    subprocess.run(['pinctrl', 'set', PIN, 'op', 'dl'], check=False)


OK = {1: (120,), 2: (120, 150, 120), 3: (120, 150, 120, 150, 120)}
UP = (600, 250, 600)
NO = (1500,)


def http(url, body=None, method=None):
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        return e.code, {}
    except Exception as e:
        return 0, {'error': str(e)}


def confirm_watch():
    code, s = http(SHARED)
    if code != 200: return False
    s['lastAgo'] = 0
    return http(SHARED, s, 'PUT')[0] == 200


def act(n):
    """führt die Aktion aus, gibt die Tonfolge zurück"""
    code, st = http(NR + '/state?ais=0')
    if code != 200:
        print('node-red nicht erreichbar', st, flush=True); return NO
    anc = st.get('anchor') or {}
    if n == 1:
        ok = http(NR + '/ack', {}, 'POST')[0] == 200
        if any(k.startswith('watch@') for k in st.get('alarmKeys') or []): confirm_watch()
        return OK[1] if ok else NO
    if n == 2:
        return OK[2] if confirm_watch() else NO
    if n == 3:
        sog = (st.get('ais') or {}).get('ownSog') or 0
        if anc.get('act'):
            print('anker setzen abgelehnt: anker schon aktiv', flush=True); return NO
        if sog >= 1:
            print('anker setzen abgelehnt: sog %.1f kn' % sog, flush=True); return NO
        code, r = http(NR + '/anchor', {'action': 'dry' if DRY else 'drop_now'}, 'POST')
        print('anker setzen', code, r, flush=True)
        return OK[3] if code == 200 else NO
    if n == 4:
        if not anc.get('act'):
            print('anker auf abgelehnt: kein anker aktiv', flush=True); return NO
        code, r = http(NR + '/anchor', {'action': 'dry' if DRY else 'up'}, 'POST')
        print('anker auf', code, r, flush=True)
        return UP if code == 200 else NO
    return None


def load_cfg():
    try:
        with open(CFG) as f: return json.load(f)
    except Exception:
        return {'macs': []}


async def scan(learn=False):
    from bleak import BleakScanner
    cfg = load_cfg()
    macs = {m.upper() for m in cfg.get('macs', [])}
    last_pid = {}
    done = asyncio.Event()
    busy = asyncio.Lock()

    async def handle(mac, ev):
        async with busy:  # eine Aktion nach der anderen, Töne nicht überlappen
            tones = await asyncio.to_thread(act, ev)
            print('%s %s → %s' % (mac, EVENTS[ev], 'ok' if tones and tones != NO else 'abgelehnt'), flush=True)
            if tones: await asyncio.to_thread(beep, *tones)

    def cb(dev, adv):
        data = adv.service_data.get(BTHOME)
        if not data: return
        p = parse(data)
        if not p or not p.get('button'): return
        mac = dev.address.upper()
        if p.get('pid') is not None:
            if last_pid.get(mac) == p['pid']: return  # dasselbe Ereignis wird mehrfach gesendet
            last_pid[mac] = p['pid']
        if learn:
            os.makedirs(os.path.dirname(CFG), exist_ok=True)
            cfg['macs'] = sorted(macs | {mac})
            with open(CFG, 'w') as f: json.dump(cfg, f, indent=2)
            print('angelernt: %s (Batterie %s %%)' % (mac, p.get('battery')), flush=True)
            beep(*OK[1]); done.set(); return
        if mac not in macs: return
        if p['button'] in EVENTS: asyncio.get_running_loop().create_task(handle(mac, p['button']))

    async with BleakScanner(cb, adapter=cfg.get('adapter', 'hci1')):
        if learn:
            print('Taster jetzt 1× drücken (60 s) …', flush=True)
            try: await asyncio.wait_for(done.wait(), 60)
            except asyncio.TimeoutError: print('kein Taster gesehen', flush=True); sys.exit(1)
        else:
            print('lausche auf %s' % (', '.join(sorted(macs)) or 'nichts – erst --learn'), flush=True)
            await asyncio.Event().wait()


def selftest():
    # Shelly BLU Button: 0x44 = BTHome v2, unverschlüsselt, „trigger based“; pid 7, Batterie 100 %, Taste 3 (dreifach)
    assert parse(bytes([0x44, 0x00, 0x07, 0x01, 0x64, 0x3A, 0x03])) == {'pid': 7, 'battery': 100, 'button': 3}
    assert parse(bytes([0x45, 0x00, 0x07])) is None  # verschlüsselt
    assert parse(bytes([0x44, 0x00, 0x08, 0x3A, 0x00])) == {'pid': 8, 'button': 0}
    print('selftest ok')


if __name__ == '__main__':
    if '--selftest' in sys.argv: selftest()
    elif '--press' in sys.argv:
        n = int(sys.argv[sys.argv.index('--press') + 1])
        t = act(n); print(EVENTS.get(n), '→', 'ok' if t and t != NO else 'abgelehnt'); t and beep(*t)
    else: asyncio.run(scan('--learn' in sys.argv))
