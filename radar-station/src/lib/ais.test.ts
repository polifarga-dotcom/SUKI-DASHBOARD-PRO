import { describe, it, expect } from 'vitest';
import { countryOf, shipTypeText, navStateText } from './ais';

describe('countryOf', () => {
	it('ship MMSIs', () => {
		expect(countryOf('211897610')).toBe('Germany'); // SUKI
		expect(countryOf('247163050')).toBe('Italy');
		expect(countryOf('215000000')).toBe('Malta');
		expect(countryOf('538001234')).toBe('Marshall Islands');
		expect(countryOf('366123456')).toBe('USA');
	});
	it('special stations', () => {
		expect(countryOf('002111240')).toBe('Germany'); // Küstenfunkstelle
		expect(countryOf('992151234')).toBe('Malta'); // AtoN
		expect(countryOf('111232001')).toBe('United Kingdom'); // SAR-Flugzeug
		expect(countryOf('970123456')).toBe('AIS-SART (no flag)');
		expect(countryOf('12345')).toBe('Unknown');
		expect(countryOf('')).toBe('—');
	});
});

describe('texts', () => {
	it('ship types', () => {
		expect(shipTypeText(36)).toBe('Sailing');
		expect(shipTypeText(70)).toBe('Cargo');
		expect(shipTypeText(81)).toBe('Tanker · hazard A');
		expect(shipTypeText(null, 'Pleasure')).toBe('Pleasure');
	});
	it('nav status', () => {
		expect(navStateText('moored')).toBe('Moored');
		expect(navStateText('motoring')).toBe('Under way using engine');
		expect(navStateText(undefined)).toBe('—');
	});
});
