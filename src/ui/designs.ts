import type { Design } from '../sim/genome';

const KEY = 'cellworld.designs';

/** The player's saved designs, kept in this browser. Storage can be unavailable; then nothing is saved. */
export function loadDesigns(): Design[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Design[]) : [];
  } catch {
    return [];
  }
}

export function storeDesigns(designs: Design[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(designs));
    return true;
  } catch {
    return false;
  }
}
