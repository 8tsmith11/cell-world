import { LEADERBOARD } from '../config';
import type { LineageStats } from '../sim/lineages';

export interface Category {
  name: string;
  /** Higher is better; null means the lineage doesn't qualify. */
  score: (l: LineageStats) => number | null;
  format: (l: LineageStats) => string;
}

const minutes = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

export const CATEGORIES: Category[] = [
  {
    name: 'Apex Predator',
    score: (l) => (l.biomass >= LEADERBOARD.apexMinBiomass ? l.trophic : null),
    format: (l) => `trophic level ${l.trophic.toFixed(2)}`,
  },
  { name: 'Most Biomass', score: (l) => l.biomass, format: (l) => `${Math.round(l.biomass)} nutrient` },
  { name: 'Largest Population', score: (l) => l.organisms, format: (l) => `${l.organisms} organisms` },
  { name: 'Largest Organism', score: (l) => l.largest, format: (l) => `${l.largest} cells` },
  { name: 'Most Energy', score: (l) => l.energy, format: (l) => `${Math.round(l.energy)} energy` },
  { name: 'Oldest Lineage', score: (l) => l.ageSec, format: (l) => minutes(l.ageSec) },
];

/** The leading living lineage in each category (null if none qualifies). */
export function leaders(stats: LineageStats[]): (LineageStats | null)[] {
  return CATEGORIES.map((c) => {
    let best: LineageStats | null = null;
    let bestScore = -Infinity;
    for (const l of stats) {
      if (l.extinct) continue;
      const s = c.score(l);
      if (s !== null && s > bestScore) {
        bestScore = s;
        best = l;
      }
    }
    return best;
  });
}
