// D1fix7: the executor only supports 'floor' and 'wall' placements
// (placementOk special-cases 'wall'; cellsOf returns [] for anything else).
// Cards may say 'surface'/'table'/etc.; normalise those to 'floor' on the
// object while keeping the stored card unchanged.
export function normalizePlacement(raw: unknown): 'floor' | 'wall' {
  return raw === 'wall' ? 'wall' : 'floor';
}

// The original card value when it was normalised away, for the
// object_understood event payload. Null when nothing was normalised
// ('wall' and 'floor' pass through unchanged).
export function placementFrom(raw: unknown): string | null {
  if (raw === 'wall' || raw === 'floor') return null;
  return typeof raw === 'string' && /^[a-z_]{1,20}$/.test(raw) ? raw : 'other';
}
