import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Dev-Server leitet dieselben Pfade wie nginx auf dem Pi weiter → App-Code ist in Dev und Prod identisch.
const PI = process.env.SUKI_PI ?? 'http://192.168.0.100:8090';
// Build-Kennung: steckt im Code (__BUILD__) und als version.txt neben der App → laufende Geräte erkennen Updates
const BUILD = new Date().toISOString().slice(0, 19).replace('T', ' ');

export default defineConfig({
	plugins: [
		svelte(),
		{ name: 'build-version', generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.txt', source: BUILD }); } }
	],
	define: { __BUILD__: JSON.stringify(BUILD) },
	server: {
		port: 5180,
		host: true,
		proxy: {
			'/signalk': { target: PI, ws: true, changeOrigin: true },
			'/mayara': { target: PI, ws: true, changeOrigin: true },
			'/mayara-emu': { target: PI, ws: true, changeOrigin: true },
			'/tiles': { target: PI, changeOrigin: true }
		}
	},
	build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
	worker: { format: 'es' },
	test: { include: ['src/**/*.test.ts', 'pi/**/*.test.mjs'] }
});
