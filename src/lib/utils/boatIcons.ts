/**
 * Top-down boat silhouette SVGs — bow pointing up (y=0 direction)
 * viewBox: 0 0 40 60  |  Uses "COL" as fill color placeholder
 * Call boatIconSvg(type, '#hex') to get the final colored SVG string.
 */

const SVGS: Record<string, string> = {
  monohull: [
    '<svg viewBox="0 0 40 60" width="40" height="60">',
    // Sleek narrow hull: sharp bow, widest at 40%, tapers to stern with notch
    '<path d="M20 3 C22 6 25 14 26 24 C27 35 26 46 24 54 L20 57 L16 54',
    ' C14 46 13 35 14 24 C15 14 18 6 20 3Z"',
    ' fill="COL" stroke="rgba(255,255,255,0.25)" stroke-width="1" stroke-linejoin="round"/>',
    // Keel centre stripe
    '<line x1="20" y1="7" x2="20" y2="53"',
    ' stroke="rgba(0,0,0,0.28)" stroke-width="1.5" stroke-linecap="round"/>',
    // Bow highlight dot
    '<circle cx="20" cy="4" r="2.2" fill="rgba(255,255,255,0.9)"/>',
    '</svg>',
  ].join(''),

  catamaran: [
    '<svg viewBox="0 0 40 60" width="40" height="60">',
    // Port hull — cigar, centred at x=8
    '<path d="M8 4 C5 8 4 18 4 30 C4 42 6 50 8 54 C10 50 12 42 12 30',
    ' C12 18 11 8 8 4Z" fill="COL" stroke="rgba(255,255,255,0.25)" stroke-width="1"/>',
    // Stbd hull — perfect mirror, centred at x=32
    '<path d="M32 4 C35 8 36 18 36 30 C36 42 34 50 32 54 C30 50 28 42 28 30',
    ' C28 18 29 8 32 4Z" fill="COL" stroke="rgba(255,255,255,0.25)" stroke-width="1"/>',
    // Forward crossbeam (rounded)
    '<rect x="12" y="14" width="16" height="3.5" rx="1.75"',
    ' fill="COL" opacity="0.9"/>',
    // Aft crossbeam
    '<rect x="12" y="38" width="16" height="3.5" rx="1.75"',
    ' fill="COL" opacity="0.9"/>',
    // Centre mast dot on forward beam
    '<circle cx="20" cy="22" r="2" fill="rgba(255,255,255,0.85)"/>',
    '</svg>',
  ].join(''),

  trimaran: [
    '<svg viewBox="0 0 40 60" width="40" height="60">',
    // Main hull — narrow, full length, centred at x=20
    '<path d="M20 3 C22 7 23 16 23 29 C23 41 22 50 20 55',
    ' C18 50 17 41 17 29 C17 16 18 7 20 3Z"',
    ' fill="COL" stroke="rgba(255,255,255,0.25)" stroke-width="1"/>',
    // Port ama — longer, positioned alongside main hull, centred at x=7
    '<path d="M7 12 C5 15 4 22 4 32 C4 42 5 48 7 52',
    ' C9 48 10 42 10 32 C10 22 9 15 7 12Z"',
    ' fill="COL" stroke="rgba(255,255,255,0.18)" stroke-width="0.8" opacity="0.9"/>',
    // Stbd ama — perfect mirror, centred at x=33
    '<path d="M33 12 C35 15 36 22 36 32 C36 42 35 48 33 52',
    ' C31 48 30 42 30 32 C30 22 31 15 33 12Z"',
    ' fill="COL" stroke="rgba(255,255,255,0.18)" stroke-width="0.8" opacity="0.9"/>',
    // Port crossbeam (from ama to main hull)
    '<rect x="10" y="24" width="7" height="2.5" rx="1.25" fill="COL" opacity="0.95"/>',
    // Stbd crossbeam
    '<rect x="23" y="24" width="7" height="2.5" rx="1.25" fill="COL" opacity="0.95"/>',
    // Bow highlight
    '<circle cx="20" cy="4" r="2.2" fill="rgba(255,255,255,0.85)"/>',
    '</svg>',
  ].join(''),

  motorboat: [
    '<svg viewBox="0 0 40 60" width="40" height="60">',
    // Wide rounded hull — bullet bow, parallel sides, flat stern
    '<path d="M20 5 C25 6 30 14 31 24 C32 34 31 45 29 52 L11 52',
    ' C9 45 8 34 9 24 C10 14 15 6 20 5Z"',
    ' fill="COL" stroke="rgba(255,255,255,0.25)" stroke-width="1" stroke-linejoin="round"/>',
    // Windshield — trapezoidal, slightly translucent blue
    '<path d="M14 22 L26 22 L25 31 L15 31Z"',
    ' fill="rgba(180,230,255,0.22)" stroke="rgba(255,255,255,0.45)"',
    ' stroke-width="0.9" stroke-linejoin="round"/>',
    // Short bow centreline
    '<line x1="20" y1="7" x2="20" y2="18"',
    ' stroke="rgba(0,0,0,0.2)" stroke-width="1.2" stroke-linecap="round"/>',
    // Twin engine dots at stern (symmetric)
    '<circle cx="16" cy="50" r="1.8" fill="rgba(255,255,255,0.55)"/>',
    '<circle cx="24" cy="50" r="1.8" fill="rgba(255,255,255,0.55)"/>',
    '</svg>',
  ].join(''),
};

export function boatIconSvg(type: string, color: string): string {
  return (SVGS[type] ?? SVGS.monohull).replaceAll('COL', color);
}

// Small version for Settings selector (uses CSS currentColor)
export const BOAT_ICON_LABELS: Record<string, string> = {
  monohull:  'Monohull',
  catamaran: 'Catamaran',
  trimaran:  'Trimaran',
  motorboat: 'Motorboat',
};

export function boatIconSettingsSvg(type: string): string {
  return (SVGS[type] ?? SVGS.monohull)
    .replace(' width="40" height="60"', ' width="30" height="45"')
    .replaceAll('COL', 'currentColor');
}
