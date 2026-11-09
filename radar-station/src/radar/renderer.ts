// WebGL2-PPI: Polartextur (Zeilen = Peilung, Spalten = Entfernung) → Shader rechnet in Bildschirmkoordinaten um.
// R-Kanal = Echo (Rohwert 0..255), G-Kanal = Nachleuchten/Trails (255 → 0 über `trails` Sekunden).
import type { Legend } from '../data/mayara.svelte';
import type { SpokeBatch } from './spokeDecoder';
import type { Palette, Theme } from '../lib/settings.svelte';

export interface View {
	width: number; // CSS px
	height: number;
	dpr: number;
	cx: number; // Eigenschiff-Position im Canvas (CSS px)
	cy: number;
	ppm: number; // Pixel je Meter (CSS px)
	up: number; // wahre Peilung, die nach oben zeigt (rad)
	heading: number; // für nicht stabilisierte Spokes
	gamma: number;
	opacity: number;
}

const COLS = 1024;

const VS = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D tex;
uniform sampler2D pal;
uniform vec2 size;      // Gerätepixel
uniform vec2 center;    // Gerätepixel, y nach unten
uniform float ppm;      // Gerätepixel je Meter
uniform float up;
uniform float heading;
uniform float stab;     // 1 = Zeilen sind wahre Peilung
uniform float spokeRange;
uniform float gamma;
uniform float opacity;
uniform vec4 trailColor;
out vec4 o;
const float TAU = 6.28318530718;
void main(){
  vec2 s = vec2(gl_FragCoord.x, size.y - gl_FragCoord.y) - center;
  float d = length(s) / ppm;
  if (d >= spokeRange || spokeRange <= 0.) { o = vec4(0.); return; }
  float b = atan(s.x, -s.y) + up;       // wahre Peilung
  if (stab < .5) b -= heading;           // relativ zum Bug
  float row = fract(b / TAU);
  vec2 v = texture(tex, vec2(d / spokeRange, row)).rg;
  float raw = floor(v.r * 255. + .5);
  vec4 c = texture(pal, vec2((raw + .5) / 256., .5));
  c.a = pow(c.a, gamma);
  float tr = v.g * trailColor.a;
  vec4 t = vec4(trailColor.rgb, tr);
  vec4 r = c.a > .02 ? c : t;
  o = vec4(r.rgb * r.a, r.a) * opacity;
}`;

export class RadarRenderer {
	private gl: WebGL2RenderingContext;
	private prog: WebGLProgram;
	private tex: WebGLTexture;
	private pal: WebGLTexture;
	private u: Record<string, WebGLUniformLocation | null> = {};
	private rows = 2048;
	private buf: Uint8Array; // RG je Zelle
	private dirtyLo = Infinity;
	private dirtyHi = -1;
	private stabilized = false;
	spokeRange = 0;
	private lastSpokeRange = 0;
	lastSpoke = 0;
	private trailSec = 0;
	private revMs = 2500;
	private trailRgba: [number, number, number, number] = [0.3, 0.6, 1, 0.55];
	/** Index-Tabelle Textur-Spalte → Strahl-Sample je Strahllänge (statt 1024 Divisionen pro Strahl) */
	private colMap = new Uint16Array(COLS);
	private colMapL = 0;

	constructor(private canvas: HTMLCanvasElement) {
		const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false });
		if (!gl) throw new Error('WebGL2 not available');
		this.gl = gl;
		this.prog = this.program(VS, FS);
		const vb = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, vb);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
		const loc = gl.getAttribLocation(this.prog, 'p');
		gl.enableVertexAttribArray(loc);
		gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
		for (const n of ['tex', 'pal', 'size', 'center', 'ppm', 'up', 'heading', 'stab', 'spokeRange', 'gamma', 'opacity', 'trailColor'])
			this.u[n] = gl.getUniformLocation(this.prog, n);
		this.buf = new Uint8Array(this.rows * COLS * 2);
		this.tex = gl.createTexture()!;
		this.allocTex();
		this.pal = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, this.pal);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		this.setPalette(null, 'multicolor', 'dusk');
	}

	private program(vs: string, fs: string) {
		const gl = this.gl;
		const mk = (type: number, src: string) => {
			const s = gl.createShader(type)!;
			gl.shaderSource(s, src);
			gl.compileShader(s);
			if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
			return s;
		};
		const p = gl.createProgram()!;
		gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
		gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
		gl.linkProgram(p);
		if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
		return p;
	}

	private allocTex() {
		const gl = this.gl;
		gl.bindTexture(gl.TEXTURE_2D, this.tex);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, COLS, this.rows, 0, gl.RG, gl.UNSIGNED_BYTE, this.buf);
		// NEAREST: Rohwerte dürfen nicht interpoliert werden (Palette-Index)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
	}

	setSpokesPerRev(n: number) {
		if (n > 0 && n !== this.rows) {
			this.rows = n;
			this.buf = new Uint8Array(n * COLS * 2);
			this.allocTex();
		}
	}

	setTrails(sec: number, revMs: number) {
		this.trailSec = sec;
		if (revMs > 300) this.revMs = revMs;
		if (!sec) {
			for (let i = 1; i < this.buf.length; i += 2) this.buf[i] = 0;
			this.markAll();
		}
	}

	clear() {
		this.buf.fill(0);
		this.markAll();
	}

	private markAll() {
		this.dirtyLo = 0;
		this.dirtyHi = this.rows - 1;
	}

	/**
	 * @param heading eigener wahrer Kurs (rad) für Spokes ohne `bearing`; null = unbekannt (dann relativ)
	 */
	addSpokes(b: SpokeBatch, heading: number | null, legend: Legend | null) {
		const rows = this.rows;
		const doppA = legend?.dopplerApproaching?.[0] ?? -1;
		const doppR = legend?.dopplerReceding?.[0] ?? -1;
		const pc = legend?.pixelColors ?? 16;
		const strong = legend?.strongReturn ?? 10;
		const histStart = legend && legend.historyStart > pc ? legend.historyStart : 255;
		const decay = this.trailSec ? Math.max(1, Math.round((255 * this.revMs) / (this.trailSec * 1000))) : 0;
		for (let i = 0; i < b.n; i++) {
			const L = b.len[i];
			if (!L) continue;
			const range = b.range[i];
			if (range !== this.lastSpokeRange) {
				// neue Range → alte Echos haben falschen Maßstab
				this.lastSpokeRange = range;
				this.buf.fill(0);
				this.markAll();
			}
			this.spokeRange = range;
			let row: number;
			if (b.bearing[i] >= 0) {
				row = b.bearing[i] % rows;
				this.stabilized = true;
			} else if (heading != null) {
				row = (b.angle[i] + Math.round((heading / (Math.PI * 2)) * rows)) % rows;
				this.stabilized = true;
			} else {
				row = b.angle[i] % rows;
				this.stabilized = false;
			}
			const off = row * COLS * 2;
			const src = i * b.stride;
			if (L !== this.colMapL) {
				for (let c = 0; c < COLS; c++) this.colMap[c] = Math.floor((c * L) / COLS);
				this.colMapL = L;
			}
			const map = this.colMap;
			for (let c = 0; c < COLS; c++) {
				let v = b.data[src + map[c]];
				if (v >= histStart) v = 0;
				const k = off + c * 2;
				this.buf[k] = v;
				if (decay) {
					const isEcho = (v >= strong && v < pc) || v === doppA || v === doppR;
					const g = this.buf[k + 1];
					this.buf[k + 1] = isEcho ? 255 : g > decay ? g - decay : 0;
				}
			}
			if (row < this.dirtyLo) this.dirtyLo = row;
			if (row > this.dirtyHi) this.dirtyHi = row;
		}
		this.lastSpoke = Date.now();
	}

	setPalette(legend: Legend | null, palette: Palette, theme: Theme) {
		const pc = legend?.pixelColors ?? 16;
		const lut = new Uint8Array(256 * 4);
		const ramp = rampFor(theme === 'night' ? 'night' : palette);
		for (let v = 1; v < pc; v++) {
			const f = (v - 1) / Math.max(1, pc - 2);
			const [r, g, b, a] = sampleRamp(ramp, f);
			lut.set([r, g, b, a], v * 4);
		}
		const da = legend?.dopplerApproaching?.[0];
		const dr = legend?.dopplerReceding?.[0];
		if (da != null && da < 256) lut.set(theme === 'night' ? [255, 90, 60, 255] : [255, 40, 160, 255], da * 4);
		if (dr != null && dr < 256) lut.set(theme === 'night' ? [140, 40, 30, 255] : [40, 220, 255, 255], dr * 4);
		this.trailRgba = theme === 'night' ? [0.6, 0.1, 0.05, 0.45] : palette === 'yellow' ? [0.1, 0.45, 1, 0.5] : [0.25, 0.55, 1, 0.5];
		const gl = this.gl;
		gl.bindTexture(gl.TEXTURE_2D, this.pal);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
	}

	private upload() {
		if (this.dirtyHi < this.dirtyLo) return;
		const gl = this.gl;
		gl.bindTexture(gl.TEXTURE_2D, this.tex);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		const lo = this.dirtyLo;
		const n = this.dirtyHi - lo + 1;
		gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, lo, COLS, n, gl.RG, gl.UNSIGNED_BYTE, this.buf.subarray(lo * COLS * 2, (lo + n) * COLS * 2));
		this.dirtyLo = Infinity;
		this.dirtyHi = -1;
	}

	/** Trails altern auch ohne neue Spokes nicht – sie werden beim Überschreiben der Zeile reduziert. */
	render(v: View) {
		const gl = this.gl;
		const W = Math.round(v.width * v.dpr);
		const H = Math.round(v.height * v.dpr);
		if (this.canvas.width !== W || this.canvas.height !== H) {
			this.canvas.width = W;
			this.canvas.height = H;
		}
		this.upload();
		gl.viewport(0, 0, W, H);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		const stale = Date.now() - this.lastSpoke > 4000;
		if (stale) return;
		gl.useProgram(this.prog);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.tex);
		gl.uniform1i(this.u.tex, 0);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, this.pal);
		gl.uniform1i(this.u.pal, 1);
		gl.uniform2f(this.u.size, W, H);
		gl.uniform2f(this.u.center, v.cx * v.dpr, v.cy * v.dpr);
		gl.uniform1f(this.u.ppm, v.ppm * v.dpr);
		gl.uniform1f(this.u.up, v.up);
		gl.uniform1f(this.u.heading, v.heading);
		gl.uniform1f(this.u.stab, this.stabilized ? 1 : 0);
		gl.uniform1f(this.u.spokeRange, this.spokeRange);
		gl.uniform1f(this.u.gamma, 1 / Math.max(0.2, v.gamma));
		gl.uniform1f(this.u.opacity, v.opacity);
		gl.uniform4f(this.u.trailColor, ...this.trailRgba);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	get isStabilized() {
		return this.stabilized;
	}

	destroy() {
		const gl = this.gl;
		gl.deleteTexture(this.tex);
		gl.deleteTexture(this.pal);
		gl.deleteProgram(this.prog);
	}
}

type Stop = [number, number, number, number, number]; // pos, r, g, b, a

function rampFor(p: Palette | 'night'): Stop[] {
	switch (p) {
		case 'yellow': // B&G/Simrad-Klassik: Gelb auf Schwarz
			return [
				[0, 90, 70, 0, 110],
				[0.4, 200, 170, 0, 220],
				[1, 255, 240, 60, 255]
			];
		case 'green':
			return [
				[0, 0, 70, 30, 110],
				[0.5, 30, 200, 90, 230],
				[1, 170, 255, 170, 255]
			];
		case 'night':
			return [
				[0, 70, 0, 0, 120],
				[0.5, 170, 20, 10, 230],
				[1, 255, 70, 40, 255]
			];
		default: // Mehrfarbig (Garmin/Raymarine): Blau → Grün → Gelb → Rot
			return [
				[0, 0, 40, 160, 120],
				[0.25, 0, 170, 120, 200],
				[0.5, 120, 220, 0, 235],
				[0.75, 255, 200, 0, 250],
				[1, 255, 40, 20, 255]
			];
	}
}

function sampleRamp(r: Stop[], f: number): [number, number, number, number] {
	for (let i = 1; i < r.length; i++) {
		if (f <= r[i][0]) {
			const a = r[i - 1];
			const b = r[i];
			const t = (f - a[0]) / (b[0] - a[0] || 1);
			return [1, 2, 3, 4].map((k) => Math.round(a[k] + (b[k] - a[k]) * t)) as [number, number, number, number];
		}
	}
	const l = r[r.length - 1];
	return [l[1], l[2], l[3], l[4]];
}
