// SUKI: gibt nur AIS aus, das unsere eigenen Funkempfänger (Vesper) per NMEA2000 liefern, als AIVDM auf ein
// eigenes Ereignis aus. Der ais-forwarder hört auf dieses Ereignis → Internet-AIS (PredictWind DataHub,
// Rufzeichen DATAHUB) wird nicht an MarineTraffic & Co. zurückgespeist. Lokal (nmea0183out) bleibt alles.
// Zusätzlich: eigene Position als Klasse-B-Meldung (der Vesper legt keine eigenen AIS-Meldungen auf den Bus).
const path = require('path');

const DEFAULT_CAN_NAMES = ['c078c3003f1132ba']; // Vesper Marine

module.exports = (app) => {
	// Kodierung vom Server-Plugin signalk-n2kais-to-nmea0183 wiederverwenden (exportiert convert())
	const n2kaisPath = require.resolve('signalk-n2kais-to-nmea0183', { paths: [path.dirname(require.main.filename), '/usr/lib/node_modules/signalk-server'] });
	const n2kais = require(n2kaisPath);
	const { AisEncode } = require(require.resolve('ggencoder', { paths: [path.dirname(n2kaisPath)] }));
	let cb;
	let timer;
	let allowed = new Set();
	let sent = 0;
	let ownTimer;
	let lastPos = 0;
	let lastStatic = 0;
	let ownSent = 0;

	const val = (p) => {
		const v = app.getSelfPath(p);
		return v && typeof v === 'object' && 'value' in v ? v.value : v;
	};
	const deg = (rad) => (rad == null ? undefined : ((rad * 180) / Math.PI).toFixed(0));

	/** Eigene Klasse-B-Meldungen (18 = Position, 24 A/B = Stammdaten) aus SignalK-Selbstdaten */
	function ownSentences(mmsi, withStatic) {
		const pos = app.getSelfPath('navigation.position');
		if (!pos || !pos.value || Date.now() - Date.parse(pos.timestamp) > 30000) return []; // keine alte Position melden
		const sog = val('navigation.speedOverGround');
		const msgs = [{ aistype: 18, repeat: 0, mmsi, sog: sog == null ? undefined : sog * 1.9438444924574, accuracy: 1, lon: pos.value.longitude, lat: pos.value.latitude, cog: deg(val('navigation.courseOverGroundTrue')), hdg: deg(val('navigation.headingTrue')) }];
		if (withStatic) {
			const len = val('design.length')?.overall;
			const beam = val('design.beam');
			const bow = val('sensors.gps.fromBow') ?? (len ? len / 2 : undefined);
			const dims = len && beam ? { dimA: Math.round(bow), dimB: Math.round(len - bow), dimC: Math.round(beam / 2), dimD: Math.round(beam / 2) } : {};
			msgs.push({ aistype: 24, repeat: 0, part: 0, mmsi, shipname: val('name') });
			msgs.push({ aistype: 24, repeat: 0, part: 1, mmsi, cargo: val('design.aisShipType')?.id ?? 36, callsign: val('communication.callsignVhf'), ...dims });
		}
		return msgs.map((m) => new AisEncode(m).nmea).filter(Boolean);
	}

	const plugin = {
		id: 'suki-ais-own',
		name: 'SUKI: own radio AIS only (for AIS forwarding)',
		description: 'Converts N2K AIS from the listed receivers only (CAN name) to AIVDM on its own event'
	};
	plugin.schema = {
		type: 'object',
		properties: {
			canNames: { type: 'array', title: 'CAN names of own AIS receivers', items: { type: 'string' }, default: DEFAULT_CAN_NAMES },
			event: { type: 'string', title: 'Output event (set the same in ais-forwarder)', default: 'ais-own' },
			ownPosition: { type: 'boolean', title: 'Also send own position (class B, every 1 min underway / 3 min below 2 kn)', default: true }
		}
	};

	// Busadressen können sich bei Neuvergabe ändern → aus den SignalK-Quellen (CAN-Name → Adresse) neu lesen
	function refresh(names) {
		const sources = app.signalk.retrieve().sources || {};
		const s = new Set();
		for (const prov of Object.values(sources))
			if (prov && typeof prov === 'object')
				for (const [addr, x] of Object.entries(prov)) if (x && x.n2k && names.includes(x.n2k.canName)) s.add(Number(x.n2k.src ?? addr));
		allowed = s;
		app.setPluginStatus(`Own AIS receivers at N2K address ${[...s].join(', ') || '— (none found)'}; ${sent} received sentences, ${ownSent} own reports sent`);
	}

	plugin.start = (opt) => {
		const names = opt.canNames && opt.canNames.length ? opt.canNames : DEFAULT_CAN_NAMES;
		const event = opt.event || 'ais-own';
		const self = app.getSelfPath('mmsi');
		refresh(names);
		timer = setInterval(() => refresh(names), 30000);
		cb = (msg) => {
			if (!allowed.has(Number(msg.src))) return;
			const enc = n2kais.convert(app, { sendSelf: true }, self, msg);
			if (enc && enc.nmea) {
				sent++;
				app.emit(event, enc.nmea);
			}
		};
		app.on('N2KAnalyzerOut', cb);
		if (opt.ownPosition !== false && self)
			ownTimer = setInterval(() => {
				const now = Date.now();
				const moving = (val('navigation.speedOverGround') ?? 0) > 1; // > ~2 kn
				if (now - lastPos < (moving ? 60e3 : 180e3)) return;
				const withStatic = now - lastStatic > 360e3;
				const out = ownSentences(self, withStatic);
				if (!out.length) return;
				lastPos = now;
				if (withStatic) lastStatic = now;
				ownSent++;
				for (const s of out) app.emit(event, s);
			}, 10e3);
	};
	plugin.stop = () => {
		clearInterval(timer);
		clearInterval(ownTimer);
		if (cb) app.removeListener('N2KAnalyzerOut', cb);
		cb = undefined;
	};
	return plugin;
};
