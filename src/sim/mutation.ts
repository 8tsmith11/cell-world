// Mutation: an offspring's genome is a copy of its parent's design with a
// chance of changes. DOM-free.
import { CELL, DESIGN, JET, MUTATION } from '../config';
import {
  CELL_KINDS,
  type Design,
  HEX_DIRS,
  hexDistance,
  isSensor,
  jetStrength,
  bodyMix,
  validateDesign,
} from './genome';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Returns a mutated copy of the design and how many mutations were applied.
 * Every chance is scaled by the design's mutation rate (default: ×1). Each
 * mutation is tried on its own and kept only if the design stays valid.
 */
export function mutate(parent: Design, rng: () => number): { design: Design; count: number } {
  let design: Design = structuredClone(parent);
  const scale = (design.mutationRate ?? MUTATION.defaultRate) / MUTATION.defaultRate;
  const small = MUTATION.small * scale;
  const rare = MUTATION.rare * scale;
  const nudge = (size: number) => (rng() * 2 - 1) * size;
  const pick = <T>(list: readonly T[]) => list[Math.floor(rng() * list.length)];
  let count = 0;

  /** Applies one change to a copy; keeps it if the design is still valid. */
  const attempt = (change: (d: Design) => boolean) => {
    const trial = structuredClone(design);
    if (change(trial) && validateDesign(trial) === null) {
      design = trial;
      count++;
    }
  };

  // ------------------------------------------------------------- small, frequent

  for (let k = 0; k < (design.wiring ?? []).length; k++) {
    if (rng() < small) attempt((d) => ((d.wiring![k].weight = clamp(d.wiring![k].weight + nudge(MUTATION.weightNudge), -1, 1)), true));
  }
  design.cells.forEach((c, i) => {
    if (c.kind === 'jet' && rng() < small) attempt((d) => ((d.cells[i].strength = clamp(jetStrength(d.cells[i]) + nudge(MUTATION.strengthNudge), 0, 1)), true));
  });
  if (rng() < small) attempt((d) => ((d.growEnergy = Math.round(clamp(d.growEnergy + nudge(MUTATION.energyNudge), DESIGN.growEnergyMin, DESIGN.growEnergyMax))), true));
  if (rng() < small) attempt((d) => ((d.growNutrient = Math.round(clamp(d.growNutrient + nudge(MUTATION.nutrientNudge), CELL.bodyNutrient, DESIGN.growNutrientMax))), true));
  if (design.growth === 'blob') {
    if (rng() < small) {
      attempt((d) => {
        const step = rng() < 0.5 ? -1 : 1;
        d.blob.maxCells = clamp(d.blob.maxCells + step * Math.ceil(rng() * MUTATION.maxCellsNudge), d.cells.length, DESIGN.maxCells);
        return true;
      });
    }
    // Shift mix proportions between kinds the Blob already uses.
    if (rng() < small) {
      attempt((d) => {
        const mix = bodyMix(d);
        const used = CELL_KINDS.filter((k) => mix[k] > 0);
        if (used.length < 2) return false;
        const from = pick(used);
        const to = pick(used.filter((k) => k !== from));
        const total = used.reduce((s, k) => s + mix[k], 0);
        const amount = Math.min(mix[from], total * MUTATION.mixShift);
        mix[from] -= amount;
        mix[to] += amount;
        d.blob.mix = Object.fromEntries(used.map((k) => [k, mix[k]]));
        return true;
      });
    }
  }
  if (design.growth === 'pattern' && rng() < small) {
    attempt((d) => ((d.pattern.maxRepeats = clamp(d.pattern.maxRepeats + (rng() < 0.5 ? -1 : 1), 1, DESIGN.patternMaxRepeatsMax)), true));
  }

  // ------------------------------------------------------------- rare, structural

  // Change a cell's type.
  if (rng() < rare) {
    attempt((d) => {
      const i = Math.floor(rng() * d.cells.length);
      const kind = pick(CELL_KINDS.filter((k) => k !== d.cells[i].kind));
      // A changed cell keeps only the settings that fit its new type.
      d.cells[i] = { q: d.cells[i].q, r: d.cells[i].r, kind, ...(kind === 'jet' ? { strength: jetStrength(d.cells[i]) } : {}) };
      d.wiring = (d.wiring ?? []).filter((w) => isSensor(d.cells[w.sensor].kind) && d.cells[w.jet].kind === 'jet');
      return true;
    });
  }
  // Add a cell on the edge of a Form or a Pattern motif.
  if ((design.growth === 'form' || design.growth === 'pattern') && rng() < rare) {
    attempt((d) => {
      if (d.cells.length >= DESIGN.maxCells) return false;
      const from = pick(d.cells);
      const [dq, dr] = pick(HEX_DIRS);
      const q = from.q + dq;
      const r = from.r + dr;
      if (hexDistance(q, r, 0, 0) > DESIGN.gridRadius || d.cells.some((c) => c.q === q && c.r === r)) return false;
      const kind = pick(CELL_KINDS);
      d.cells.push(kind === 'jet' ? { q, r, kind, strength: JET.defaultStrength } : { q, r, kind });
      return true;
    });
  }
  // Remove a cell, only if the design stays connected (validation checks that).
  if (rng() < rare) {
    attempt((d) => {
      if (d.cells.length < 2) return false;
      const idx = Math.floor(rng() * d.cells.length);
      d.cells.splice(idx, 1);
      const shift = (i: number) => (i > idx ? i - 1 : i);
      d.wiring = (d.wiring ?? []).filter((w) => w.sensor !== idx && w.jet !== idx).map((w) => ({ ...w, sensor: shift(w.sensor), jet: shift(w.jet) }));
      if (d.pattern.start === idx) return false;
      d.pattern.start = shift(d.pattern.start);
      d.pattern.ends = d.pattern.ends.filter((e) => e !== idx).map(shift);
      if (d.growth === 'blob') d.blob.maxCells = Math.max(d.blob.maxCells, d.cells.length);
      return true;
    });
  }
  // Add or remove a wiring connection.
  if (rng() < rare) {
    attempt((d) => {
      d.wiring = d.wiring ?? [];
      if (d.wiring.length && rng() < 0.5) {
        d.wiring.splice(Math.floor(rng() * d.wiring.length), 1);
        return true;
      }
      const sensors = d.cells.map((c, i) => [c, i] as const).filter(([c]) => isSensor(c.kind));
      const jets = d.cells.map((c, i) => [c, i] as const).filter(([c]) => c.kind === 'jet');
      if (!sensors.length || !jets.length) return false;
      const sensor = pick(sensors)[1];
      const jet = pick(jets)[1];
      if (d.wiring.some((w) => w.sensor === sensor && w.jet === jet)) return false;
      d.wiring.push({ sensor, jet, weight: Math.round(nudge(1) * 20) / 20, output: rng() < 0.5 ? 'level' : 'change' });
      return true;
    });
  }
  return { design, count };
}
