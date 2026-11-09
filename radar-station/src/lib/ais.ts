// AIS-Klartexte: Flaggenstaat aus der MMSI (MID nach ITU-R M.585, Anhang „Maritime Identification Digits“),
// Schiffstyp aus dem AIS-Typcode, Navigationsstatus.

const MID: Record<number, string> = {
	// Europa
	201: 'Albania', 202: 'Andorra', 203: 'Austria', 204: 'Portugal (Azores)', 205: 'Belgium', 206: 'Belarus', 207: 'Bulgaria',
	208: 'Vatican', 209: 'Cyprus', 210: 'Cyprus', 211: 'Germany', 212: 'Cyprus', 213: 'Georgia', 214: 'Moldova', 215: 'Malta',
	216: 'Armenia', 218: 'Germany', 219: 'Denmark', 220: 'Denmark', 224: 'Spain', 225: 'Spain', 226: 'France', 227: 'France',
	228: 'France', 229: 'Malta', 230: 'Finland', 231: 'Faroe Islands', 232: 'United Kingdom', 233: 'United Kingdom',
	234: 'United Kingdom', 235: 'United Kingdom', 236: 'Gibraltar', 237: 'Greece', 238: 'Croatia', 239: 'Greece', 240: 'Greece',
	241: 'Greece', 242: 'Morocco', 243: 'Hungary', 244: 'Netherlands', 245: 'Netherlands', 246: 'Netherlands', 247: 'Italy',
	248: 'Malta', 249: 'Malta', 250: 'Ireland', 251: 'Iceland', 252: 'Liechtenstein', 253: 'Luxembourg', 254: 'Monaco',
	255: 'Portugal (Madeira)', 256: 'Malta', 257: 'Norway', 258: 'Norway', 259: 'Norway', 261: 'Poland', 262: 'Montenegro',
	263: 'Portugal', 264: 'Romania', 265: 'Sweden', 266: 'Sweden', 267: 'Slovakia', 268: 'San Marino', 269: 'Switzerland',
	270: 'Czech Republic', 271: 'Turkey', 272: 'Ukraine', 273: 'Russia', 274: 'North Macedonia', 275: 'Latvia', 276: 'Estonia',
	277: 'Lithuania', 278: 'Slovenia', 279: 'Serbia',
	// Nord- und Mittelamerika, Karibik
	301: 'Anguilla', 303: 'USA (Alaska)', 304: 'Antigua and Barbuda', 305: 'Antigua and Barbuda', 306: 'Netherlands (Caribbean)',
	307: 'Aruba', 308: 'Bahamas', 309: 'Bahamas', 310: 'Bermuda', 311: 'Bahamas', 312: 'Belize', 314: 'Barbados', 316: 'Canada',
	319: 'Cayman Islands', 321: 'Costa Rica', 323: 'Cuba', 325: 'Dominica', 327: 'Dominican Republic', 329: 'France (Guadeloupe)',
	330: 'Grenada', 331: 'Greenland', 332: 'Guatemala', 334: 'Honduras', 336: 'Haiti', 338: 'USA', 339: 'Jamaica',
	341: 'Saint Kitts and Nevis', 343: 'Saint Lucia', 345: 'Mexico', 347: 'France (Martinique)', 348: 'Montserrat', 350: 'Nicaragua',
	351: 'Panama', 352: 'Panama', 353: 'Panama', 354: 'Panama', 355: 'Panama', 356: 'Panama', 357: 'Panama', 358: 'Puerto Rico',
	359: 'El Salvador', 361: 'Saint Pierre and Miquelon', 362: 'Trinidad and Tobago', 364: 'Turks and Caicos', 366: 'USA',
	367: 'USA', 368: 'USA', 369: 'USA', 370: 'Panama', 371: 'Panama', 372: 'Panama', 373: 'Panama', 374: 'Panama',
	375: 'St Vincent and the Grenadines', 376: 'St Vincent and the Grenadines', 377: 'St Vincent and the Grenadines',
	378: 'British Virgin Islands', 379: 'US Virgin Islands',
	// Asien
	401: 'Afghanistan', 403: 'Saudi Arabia', 405: 'Bangladesh', 408: 'Bahrain', 410: 'Bhutan', 412: 'China', 413: 'China',
	414: 'China', 416: 'Taiwan', 417: 'Sri Lanka', 419: 'India', 422: 'Iran', 423: 'Azerbaijan', 425: 'Iraq', 428: 'Israel',
	431: 'Japan', 432: 'Japan', 434: 'Turkmenistan', 436: 'Kazakhstan', 437: 'Uzbekistan', 438: 'Jordan', 440: 'South Korea',
	441: 'South Korea', 443: 'Palestine', 445: 'North Korea', 447: 'Kuwait', 450: 'Lebanon', 451: 'Kyrgyzstan', 453: 'Macao',
	455: 'Maldives', 457: 'Mongolia', 459: 'Nepal', 461: 'Oman', 463: 'Pakistan', 466: 'Qatar', 468: 'Syria',
	470: 'United Arab Emirates', 471: 'United Arab Emirates', 472: 'Tajikistan', 473: 'Yemen', 475: 'Yemen', 477: 'Hong Kong',
	478: 'Bosnia and Herzegovina',
	// Ozeanien
	501: 'France (Adélie Land)', 503: 'Australia', 506: 'Myanmar', 508: 'Brunei', 510: 'Micronesia', 511: 'Palau',
	512: 'New Zealand', 514: 'Cambodia', 515: 'Cambodia', 516: 'Christmas Island', 518: 'Cook Islands', 520: 'Fiji',
	523: 'Cocos Islands', 525: 'Indonesia', 529: 'Kiribati', 531: 'Laos', 533: 'Malaysia', 536: 'Northern Mariana Islands',
	538: 'Marshall Islands', 540: 'New Caledonia', 542: 'Niue', 544: 'Nauru', 546: 'French Polynesia', 548: 'Philippines',
	550: 'Timor-Leste', 553: 'Papua New Guinea', 555: 'Pitcairn', 557: 'Solomon Islands', 559: 'American Samoa', 561: 'Samoa',
	563: 'Singapore', 564: 'Singapore', 565: 'Singapore', 566: 'Singapore', 567: 'Thailand', 570: 'Tonga', 572: 'Tuvalu',
	574: 'Vietnam', 576: 'Vanuatu', 577: 'Vanuatu', 578: 'Wallis and Futuna',
	// Afrika
	601: 'South Africa', 603: 'Angola', 605: 'Algeria', 607: 'France (St Paul / Amsterdam)', 608: 'Ascension Island',
	609: 'Burundi', 610: 'Benin', 611: 'Botswana', 612: 'Central African Republic', 613: 'Cameroon', 615: 'Congo',
	616: 'Comoros', 617: 'Cabo Verde', 618: 'France (Crozet)', 619: "Côte d'Ivoire", 620: 'Comoros', 621: 'Djibouti',
	622: 'Egypt', 624: 'Ethiopia', 625: 'Eritrea', 626: 'Gabon', 627: 'Ghana', 629: 'Gambia', 630: 'Guinea-Bissau',
	631: 'Equatorial Guinea', 632: 'Guinea', 633: 'Burkina Faso', 634: 'Kenya', 635: 'France (Kerguelen)', 636: 'Liberia',
	637: 'Liberia', 638: 'South Sudan', 642: 'Libya', 644: 'Lesotho', 645: 'Mauritius', 647: 'Madagascar', 649: 'Mali',
	650: 'Mozambique', 654: 'Mauritania', 655: 'Malawi', 656: 'Niger', 657: 'Nigeria', 659: 'Namibia', 660: 'France (Réunion)',
	661: 'Rwanda', 662: 'Sudan', 663: 'Senegal', 664: 'Seychelles', 665: 'Saint Helena', 666: 'Somalia', 667: 'Sierra Leone',
	668: 'São Tomé and Príncipe', 669: 'Eswatini', 670: 'Chad', 671: 'Togo', 672: 'Tunisia', 674: 'Tanzania', 675: 'Uganda',
	676: 'DR Congo', 677: 'Tanzania', 678: 'Zambia', 679: 'Zimbabwe',
	// Südamerika
	701: 'Argentina', 710: 'Brazil', 720: 'Bolivia', 725: 'Chile', 730: 'Colombia', 735: 'Ecuador', 740: 'Falkland Islands',
	745: 'France (Guiana)', 750: 'Guyana', 755: 'Paraguay', 760: 'Peru', 765: 'Suriname', 770: 'Uruguay', 775: 'Venezuela'
};

/** alle Ländernamen (für den Übersetzungstest) */
export const ALL_COUNTRIES = () => [...new Set(Object.values(MID))];

/** MID aus der MMSI je nach Stationsart (Schiff, Küstenfunkstelle, AtoN, SAR-Flugzeug, Beiboot) */
export function midOf(mmsi: string): number | null {
	if (!/^\d{9}$/.test(mmsi)) return null;
	if (/^97[024]/.test(mmsi)) return null; // SART / MOB / EPIRB: keine Flagge
	if (mmsi.startsWith('111')) return Number(mmsi.slice(3, 6)); // SAR-Luftfahrzeug
	if (mmsi.startsWith('00')) return Number(mmsi.slice(2, 5)); // Küstenfunkstelle
	if (mmsi.startsWith('0')) return Number(mmsi.slice(1, 4)); // Gruppenruf
	if (mmsi.startsWith('98') || mmsi.startsWith('99')) return Number(mmsi.slice(2, 5)); // Beiboot / AtoN
	if (mmsi.startsWith('8')) return Number(mmsi.slice(1, 4)); // Handfunkgerät
	return Number(mmsi.slice(0, 3));
}

type Tr = (s: string) => string;
const same: Tr = (s) => s;

/** Flaggenstaat; `tr` übersetzt den englischen Namen (i18n) */
export function countryOf(mmsi: string | undefined | null, tr: Tr = same): string {
	if (!mmsi) return '—';
	if (/^970/.test(mmsi)) return tr('AIS-SART (no flag)');
	if (/^972/.test(mmsi)) return tr('AIS MOB device (no flag)');
	if (/^974/.test(mmsi)) return tr('EPIRB-AIS (no flag)');
	const mid = midOf(mmsi);
	return tr((mid != null && MID[mid]) || 'Unknown');
}

/** AIS-Schiffstyp (Nachricht 5/24) */
export function shipTypeText(id: number | null | undefined, name?: string, tr: Tr = same): string {
	if (id == null) return name || '—';
	const sub = (base: string) => {
		const d = id % 10;
		return tr(base) + (d >= 1 && d <= 4 ? ` · ${tr('hazard')} ${'ABCD'[d - 1]}` : '');
	};
	if (id >= 20 && id <= 29) return tr('Wing in ground');
	const fixed: Record<number, string> = {
		30: 'Fishing', 31: 'Towing', 32: 'Towing (large)', 33: 'Dredging / underwater ops', 34: 'Diving ops', 35: 'Military ops',
		36: 'Sailing', 37: 'Pleasure craft', 50: 'Pilot vessel', 51: 'Search and rescue', 52: 'Tug', 53: 'Port tender',
		54: 'Anti-pollution', 55: 'Law enforcement', 58: 'Medical transport', 59: 'Noncombatant ship'
	};
	if (fixed[id]) return tr(fixed[id]);
	if (id >= 40 && id <= 49) return sub('High-speed craft');
	if (id >= 60 && id <= 69) return sub('Passenger');
	if (id >= 70 && id <= 79) return sub('Cargo');
	if (id >= 80 && id <= 89) return sub('Tanker');
	if (id >= 90 && id <= 99) return sub('Other');
	return name || `Type ${id}`;
}

/** SignalK navigation.state → Klartext */
const NAV_STATE: Record<string, string> = {
	motoring: 'Under way using engine',
	anchored: 'At anchor',
	'not under command': 'Not under command',
	'restricted manouverability': 'Restricted manoeuvrability',
	'restricted maneuverability': 'Restricted manoeuvrability',
	'constrained by draft': 'Constrained by draught',
	moored: 'Moored',
	aground: 'Aground',
	fishing: 'Engaged in fishing',
	sailing: 'Under way sailing',
	'hazardous material high speed': 'Hazardous cargo (HSC)',
	'hazardous material wing in ground': 'Hazardous cargo (WIG)',
	'power-driven vessel towing astern': 'Towing astern',
	'power-driven vessel pushing ahead or towing alongside': 'Pushing ahead / towing alongside',
	'ais-sart': 'AIS-SART active',
	default: 'Not defined'
};

export function navStateText(state: string | undefined | null, tr: Tr = same): string {
	if (!state) return '—';
	const k = NAV_STATE[state.toLowerCase()];
	return k ? tr(k) : state.charAt(0).toUpperCase() + state.slice(1);
}
