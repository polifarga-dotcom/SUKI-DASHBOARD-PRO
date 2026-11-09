import { mount } from 'svelte';
import 'leaflet/dist/leaflet.css';
import './app.css';
import App from './App.svelte';

export default mount(App, { target: document.getElementById('app')! });

// Füllstand der Schieberegler (--p) für die eigene Darstellung in app.css.
// Werte ändern sich auch ohne Eingabe (Radar meldet zurück) → zusätzlich periodisch nachziehen.
function sliderFill(el: HTMLInputElement) {
	const min = Number(el.min || 0);
	const max = Number(el.max || 100);
	const p = max > min ? ((Number(el.value) - min) / (max - min)) * 100 : 0;
	const v = `${Math.max(0, Math.min(100, p))}%`;
	if (el.style.getPropertyValue('--p') !== v) el.style.setProperty('--p', v);
}
document.addEventListener('input', (e) => {
	const t = e.target as HTMLInputElement;
	if (t?.type === 'range') sliderFill(t);
});
setInterval(() => document.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(sliderFill), 400);
