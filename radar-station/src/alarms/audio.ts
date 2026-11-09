// Alarmtöne über Web Audio. iPad/Safari: AudioContext erst nach einer Bedienung freischalten (unlockAudio).
let ac: AudioContext | null = null;

export function unlockAudio() {
	try {
		if (!ac) ac = new (window.AudioContext || (window as any).webkitAudioContext)();
		if (ac.state === 'suspended') ac.resume();
		// stiller Puffer → iOS gibt die Audioausgabe frei
		const b = ac.createBuffer(1, 1, 22050);
		const s = ac.createBufferSource();
		s.buffer = b;
		s.connect(ac.destination);
		s.start(0);
	} catch {
		/* kein Audio */
	}
}

export const audioReady = () => !!ac && ac.state === 'running';

function tone(freq: number, start: number, dur: number, vol: number) {
	if (!ac) return;
	const o = ac.createOscillator();
	const g = ac.createGain();
	o.type = 'square';
	o.frequency.value = freq;
	g.gain.setValueAtTime(0, start);
	g.gain.linearRampToValueAtTime(vol * 0.25, start + 0.01);
	g.gain.setValueAtTime(vol * 0.25, start + dur - 0.02);
	g.gain.linearRampToValueAtTime(0, start + dur);
	o.connect(g).connect(ac.destination);
	o.start(start);
	o.stop(start + dur + 0.02);
}

/** Kollisionsalarm: zweitonig (wie IEC-62288-„Alarm“) */
export function playAlarm(vol: number) {
	if (!ac) return;
	const t = ac.currentTime + 0.02;
	tone(1046, t, 0.16, vol);
	tone(784, t + 0.2, 0.16, vol);
	tone(1046, t + 0.4, 0.16, vol);
	tone(784, t + 0.6, 0.16, vol);
}

/** Warnung: ein kurzer Doppelton */
export function playWarning(vol: number) {
	if (!ac) return;
	const t = ac.currentTime + 0.02;
	tone(880, t, 0.12, vol * 0.8);
	tone(880, t + 0.2, 0.12, vol * 0.8);
}

export function playClick(vol: number) {
	if (!ac) return;
	tone(1400, ac.currentTime + 0.01, 0.03, vol * 0.4);
}
