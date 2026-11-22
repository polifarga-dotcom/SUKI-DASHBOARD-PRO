import { describe, it, expect } from 'vitest';
import { cleanRoute, parseRoutes, parseCoord, toGpx, toKml, toGeoJson, toCsv, toNmea, MAX_PTS, wpWeather } from './routes.mjs';

const R = { id: 'abcd1234', name: 'Malta → Sizilien & zurück', color: '#ff9800', show: true, pts: [{ lat: 35.9, lon: 14.5, name: 'Valletta' }, { lat: 36.7, lon: 15.1 }, { lat: -1.25, lon: -2.5 }] };
const pts = (r) => r.pts.map((p) => [+p.lat.toFixed(5), +p.lon.toFixed(5)]);

describe('routes', () => {
	it('cleanRoute validates and trims', () => {
		expect(cleanRoute({ ...R, pts: [R.pts[0]] })).toBeNull(); // < 2 Punkte
		expect(cleanRoute({ ...R, pts: [R.pts[0], { lat: 91, lon: 0 }] })).toBeNull();
		expect(cleanRoute({ ...R, id: '../x' })).toBeNull();
		const c = cleanRoute({ ...R, name: 'x'.repeat(99), color: 'red' });
		expect(c.name.length).toBe(60);
		expect(c.color).toBe('#e040fb');
		expect(c.pts[0].name).toBe('Valletta');
	});

	it('round-trips through every export format', () => {
		for (const [mk, fn] of [[toGpx, 'a.gpx'], [toKml, 'a.kml'], [toGeoJson, 'a.geojson'], [toCsv, 'a.csv'], [toNmea, 'a.nmea']]) {
			const [r] = parseRoutes(mk([R]), fn);
			expect(pts(r), fn).toEqual(pts(R));
			if (fn !== 'a.nmea') expect(r.name, fn).toBe(R.name);
			expect(r.pts[0].name, fn).toBe('Valletta');
		}
	});

	it('reads GPX tracks and waypoints, thins long tracks', () => {
		const trk = `<gpx><trk><name>Log</name><trkseg>${Array.from({ length: 2500 }, (_, i) => `<trkpt lon="14.${i}" lat="36"></trkpt>`).join('')}</trkseg></trk></gpx>`;
		const [t] = parseRoutes(trk, 'x.gpx');
		expect(t.name).toBe('Log');
		expect(t.pts.length).toBe(MAX_PTS);
		const [w] = parseRoutes('<gpx><wpt lat="1" lon="2"><name>A</name></wpt><wpt lat="3" lon="4"/></gpx>', 'w.gpx');
		expect(pts(w)).toEqual([[1, 2], [3, 4]]);
	});

	it('reads CSV with header, Name;Lat;Lon and degree-minute coordinates', () => {
		const [a] = parseRoutes('Name;Breite;Länge\nA;36°05.5\'N;14°30\'E\nB;36 06.0 N;14 31.0 E', 'r.csv');
		expect(pts(a)).toEqual([[36.09167, 14.5], [36.1, 14.51667]]);
		const [b] = parseRoutes('A,35.5,14.25\nB,35.6,14.3', 'r.csv');
		expect(pts(b)).toEqual([[35.5, 14.25], [35.6, 14.3]]);
		expect(parseCoord('14°30\'W')).toBe(-14.5);
		expect(parseCoord('S 1 30')).toBe(-1.5);
		expect(parseCoord('abc')).toBeNaN();
	});

	it('reads NMEA WPL in RTE order', () => {
		const s = '$GPWPL,3600.000,N,01430.000,E,B*00\n$GPWPL,3530.000,N,01400.000,E,A*00\n$GPRTE,1,1,c,Trip,A,B*00';
		const [r] = parseRoutes(s, 'x.txt');
		expect(r.name).toBe('Trip');
		expect(pts(r)).toEqual([[35.5, 14], [36, 14.5]]);
	});
	it('reads PredictWind weather from waypoint names and keeps the full name', () => {
		const n = '20261121-1223-+0200-TWS10.1-TWD304-TWA52S-Pres1019';
		expect(wpWeather(n)).toEqual({ eta: Date.UTC(2026, 10, 21, 10, 23), off: 120, vals: { TWS: 10.1, TWD: 304, TWA: 52, Pres: 1019 }, side: 'S' });
		expect(wpWeather('20261121-1223-+0200-TWS8-TWA120P').side).toBe('P');
		expect(wpWeather('Valletta')).toBeNull();
		expect(wpWeather('20261123-2143-+0200-TWS19.4-TWD301-TWA-Pres1021').vals).toEqual({ TWS: 19.4, TWD: 301, Pres: 1021 }); // Ziel ohne TWA
		const [r] = parseRoutes(`<gpx><rte><name>ECMWF</name><rtept lat="39.8" lon="19.9"><name>${n}</name></rtept><rtept lat="39.7" lon="19.8"/></rte></gpx>`, 'pw.gpx');
		expect(r.pts[0].name).toBe(n);
	});
});
