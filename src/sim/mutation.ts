// Mutation: an offspring's genome is a copy of its parent's design with a
// chance of changes. DOM-free.
import { CELL, DESIGN, MUTATION, NEURON_INPUTS, TIMER, TIP } from '../config';
import {
  ALLOWED_REPRODUCTION,
  CELL_KINDS,
  type Design,
  type DesignCell,
  freshCell,
  HEX_DIRS,
  hexDistance,
  isSource,
  isTarget,
  jetStrength,
  NEURON_INPUT_KEYS,
  neuronBias,
  neuronSpeed,
  normalizeDesign,
  bodyMix,
  type ProximityFilter,
  TIP_CHANNELS,
  timerCycles,
  timerDuty,
  timerPhase,
  tipDeposit,
  tipGrow,
  validateDesign,
} from './genome';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Returns a mutated copy of the design and how many mutations were applied.
 * Every chance is scaled by the design's mutation rate (default: ×1), and now
 * and then an offspring mutates in a burst (several times the usual rates).
 * Small mutations roll per part (each wire, Jet, neuron, tip, timer), so they
 * already scale with size; structural mutations get one extra roll per
 * MUTATION.cellsPerRoll cells, so bigger bodies change more per reproduction.
 * Each mutation is tried on its own and kept only if the design stays valid.
 */
export function mutate(parent: Design, rng: () => number): { design: Design; count: number } {
  let design: Design = normalizeDesign(structuredClone(parent));
  let scale = (design.mutationRate ?? MUTATION.defaultRate) / MUTATION.defaultRate;
  if (rng() < MUTATION.burstChance) scale *= MUTATION.burstFactor;
  const small = MUTATION.small * scale;
  const rare = MUTATION.rare * scale;
  const nudge = (size: number) => (rng() * 2 - 1) * size;
  const pick = <T>(list: readonly T[]) => list[Math.floor(rng() * list.length)];
  const rolls = Math.min(MUTATION.maxRolls, 1 + Math.floor(design.cells.length / MUTATION.cellsPerRoll));
  let count = 0;

  /** Applies one change to a copy; keeps it if the design is still valid. */
  const attempt = (change: (d: Design) => boolean) => {
    const trial = structuredClone(design);
    if (change(trial) && validateDesign(trial) === null) {
      design = trial;
      count++;
    }
  };
  /** A structural mutation: rolled once per size step of the body. */
  const structural = (change: (d: Design) => boolean, chance = rare) => {
    for (let k = 0; k < rolls; k++) if (rng() < chance) attempt(change);
  };

  // ------------------------------------------------------------- small, frequent

  (design.wiring ?? []).forEach((_, k) => {
    if (rng() < small) attempt((d) => ((d.wiring![k].weight = clamp(d.wiring![k].weight + nudge(MUTATION.weightNudge), -1, 1)), true));
    // Rarer rewiring details: which output, which repeat, which tip signal.
    if (rng() < rare) attempt((d) => ((d.wiring![k].output = d.wiring![k].output === 'level' ? 'change' : 'level'), true));
    if (rng() < rare && (design.growth === 'pattern' || design.growth === 'worm')) {
      attempt((d) => ((d.wiring![k].repeat = pick(['same', 'previous', 'next'] as const)), true));
    }
    if (rng() < rare && design.cells[design.wiring![k].target]?.kind === 'tip') attempt((d) => ((d.wiring![k].channel = pick(TIP_CHANNELS)), true));
  });
  design.cells.forEach((c, i) => {
    if (c.kind === 'jet' && rng() < small) attempt((d) => ((d.cells[i].strength = clamp(jetStrength(d.cells[i]) + nudge(MUTATION.strengthNudge), 0, 1)), true));
    if (c.kind === 'neuron') {
      if (rng() < small) attempt((d) => ((d.cells[i].bias = clamp(neuronBias(d.cells[i]) + nudge(MUTATION.biasNudge), -1, 1)), true));
      if (rng() < small) attempt((d) => ((d.cells[i].speed = clamp(neuronSpeed(d.cells[i]) + nudge(MUTATION.speedNudge), 0, 1)), true));
      if (rng() < small) {
        attempt((d) => {
          const key = pick(NEURON_INPUT_KEYS);
          const inputs = { ...(d.cells[i].inputs ?? {}) };
          inputs[key] = round2(clamp((inputs[key] ?? 0) + nudge(MUTATION.inputNudge), -1, 1));
          d.cells[i].inputs = inputs;
          return true;
        });
      }
      if (rng() < small) {
        attempt((d) => {
          const range = d.cells[i].eatenRange ?? NEURON_INPUTS.eatenRangeMax;
          d.cells[i].eatenRange = clamp(range + (rng() < 0.5 ? -1 : 1), 1, NEURON_INPUTS.eatenRangeMax);
          return true;
        });
      }
    }
    if (c.kind === 'tip') {
      if (rng() < small) {
        attempt((d) => {
          const cell = d.cells[i];
          const which = pick(['grow', 'turn', 'branch'] as const);
          const now = which === 'grow' ? tipGrow(cell) : (cell[which] ?? 0);
          cell[which] = round2(clamp(now + nudge(MUTATION.tipNudge), -1, 1));
          return true;
        });
      }
      if (rng() < rare) {
        attempt((d) => {
          const dep = [...tipDeposit(d.cells[i])];
          const roll = rng();
          if (roll < 0.4 && dep.length < TIP.maxDeposit) dep.splice(Math.floor(rng() * (dep.length + 1)), 0, pick(CELL_KINDS));
          else if (roll < 0.6 && dep.length > 1) dep.splice(Math.floor(rng() * dep.length), 1);
          else dep[Math.floor(rng() * dep.length)] = pick(CELL_KINDS);
          d.cells[i].deposit = dep;
          return true;
        });
      }
    }
    if (c.kind === 'timer') {
      if (rng() < small) attempt((d) => ((d.cells[i].phase = round2((((timerPhase(d.cells[i]) + nudge(MUTATION.timerNudge)) % 1) + 1) % 1)), true));
      if (rng() < small) attempt((d) => ((d.cells[i].duty = round2(clamp(timerDuty(d.cells[i]) + nudge(MUTATION.timerNudge), 0.02, 0.98))), true));
      if (rng() < rare) attempt((d) => ((d.cells[i].cycles = clamp(timerCycles(d.cells[i]) + (rng() < 0.5 ? -1 : 1), 1, TIMER.maxCycles)), true));
    }
  });
  if (rng() < small) attempt((d) => ((d.growEnergy = Math.round(clamp(d.growEnergy + nudge(MUTATION.energyNudge), DESIGN.growEnergyMin, DESIGN.growEnergyMax))), true));
  if (rng() < small) attempt((d) => ((d.growNutrient = Math.round(clamp(d.growNutrient + nudge(MUTATION.nutrientNudge), CELL.bodyNutrient, DESIGN.growNutrientMax))), true));
  if (rng() < small) attempt((d) => ((d.launch = round2(clamp((d.launch ?? 0) + nudge(MUTATION.launchNudge), 0, 1))), true));
  if (rng() < small) attempt((d) => ((d.mutationRate = round2(clamp((d.mutationRate ?? MUTATION.defaultRate) + nudge(MUTATION.rateNudge), 0, 1))), true));
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
  if ((design.growth === 'pattern' || design.growth === 'worm') && rng() < small) {
    attempt((d) => ((d.pattern.maxRepeats = clamp(d.pattern.maxRepeats + (rng() < 0.5 ? -1 : 1), 1, DESIGN.patternMaxRepeatsMax)), true));
  }

  // ------------------------------------------------------------- rare, structural

  // Change a cell's type (it starts with that type's fresh settings).
  structural((d) => {
    const i = Math.floor(rng() * d.cells.length);
    const kind = pick(CELL_KINDS.filter((k) => k !== d.cells[i].kind));
    d.cells[i] = freshCell(d.cells[i].q, d.cells[i].r, kind, rng);
    dropBadWires(d);
    return true;
  });
  // Add a cell on the edge: half the time a copy of the cell it grows from, otherwise a random type.
  structural((d) => {
    if (d.cells.length >= DESIGN.maxCells) return false;
    const fromIndex = Math.floor(rng() * d.cells.length);
    const from = d.cells[fromIndex];
    const [dq, dr] = pick(HEX_DIRS);
    const q = from.q + dq;
    const r = from.r + dr;
    if (hexDistance(q, r, 0, 0) > DESIGN.gridRadius || d.cells.some((c) => c.q === q && c.r === r)) return false;
    const cell: DesignCell = rng() < 0.5 ? { ...structuredClone(from), q, r } : freshCell(q, r, pick(CELL_KINDS), rng);
    delete cell.push;
    delete cell.index;
    d.cells.push(cell);
    const added = d.cells.length - 1;
    // A Worm's new cell joins the part (head, segment or tail) it grew from.
    if (d.worm?.head.includes(fromIndex)) d.worm.head.push(added);
    else if (d.worm?.tail.includes(fromIndex)) d.worm.tail.push(added);
    if (d.growth === 'blob') d.blob.maxCells = Math.max(d.blob.maxCells, d.cells.length);
    return true;
  });
  // Remove a cell, only if the design stays connected (validation checks that).
  structural((d) => {
    if (d.cells.length < 2) return false;
    const idx = Math.floor(rng() * d.cells.length);
    if (d.pattern.start === idx) return false;
    d.cells.splice(idx, 1);
    const shift = (i: number) => (i > idx ? i - 1 : i);
    const keep = (list: number[]) => list.filter((e) => e !== idx).map(shift);
    d.wiring = (d.wiring ?? []).filter((w) => w.source !== idx && w.target !== idx).map((w) => ({ ...w, source: shift(w.source), target: shift(w.target) }));
    d.pattern.start = shift(d.pattern.start);
    d.pattern.ends = keep(d.pattern.ends);
    if (d.worm) d.worm = { head: keep(d.worm.head), tail: keep(d.worm.tail) };
    if (d.growth === 'blob') d.blob.maxCells = Math.max(d.blob.maxCells, d.cells.length);
    return true;
  });
  // Add or remove a wiring connection (any source to any target).
  structural((d) => {
    d.wiring = d.wiring ?? [];
    if (d.wiring.length && rng() < 0.5) {
      d.wiring.splice(Math.floor(rng() * d.wiring.length), 1);
      return true;
    }
    const sources = d.cells.map((c, i) => [c, i] as const).filter(([c]) => isSource(c.kind));
    const targets = d.cells.map((c, i) => [c, i] as const).filter(([c]) => isTarget(c.kind));
    if (!sources.length || !targets.length) return false;
    const source = pick(sources)[1];
    const target = pick(targets)[1];
    if (d.wiring.some((w) => w.source === source && w.target === target)) return false;
    const repeat = d.growth === 'pattern' || d.growth === 'worm' ? pick(['same', 'previous', 'next'] as const) : undefined;
    const channel = d.cells[target].kind === 'tip' ? pick(TIP_CHANNELS) : undefined;
    d.wiring.push({
      source,
      target,
      weight: Math.round(nudge(1) * 20) / 20,
      output: rng() < 0.5 ? 'level' : 'change',
      ...(repeat ? { repeat } : {}),
      ...(channel ? { channel } : {}),
    });
    return true;
  });
  // Change what a Proximity sensor counts (any cell, one type, or Dead cells).
  structural((d) => {
    const prox = d.cells.filter((c) => c.kind === 'proximitySensor');
    if (!prox.length) return false;
    const filter = pick<ProximityFilter | undefined>([undefined, 'dead', ...CELL_KINDS]);
    const cell = pick(prox);
    if (filter) cell.filter = filter;
    else delete cell.filter;
    return true;
  });
  // Switch between Form and Blob growth (half as often).
  structural((d) => {
    if (d.growth === 'form') {
      d.growth = 'blob';
      d.blob = { maxCells: Math.min(DESIGN.maxCells, d.cells.length + 2) };
    } else if (d.growth === 'blob') {
      d.growth = 'form';
      d.reproduction = 'bud';
    } else return false;
    return true;
  }, rare / 2);
  // Change the reproduction type, within what the growth type allows.
  structural((d) => {
    const options = ALLOWED_REPRODUCTION[d.growth].filter((t) => t !== d.reproduction);
    if (!options.length) return false;
    d.reproduction = pick(options);
    return true;
  });
  // Pattern: add or remove an end point.
  if (design.growth === 'pattern') {
    structural((d) => {
      const { ends, start } = d.pattern;
      if (ends.length > 1 && rng() < 0.5) {
        ends.splice(Math.floor(rng() * ends.length), 1);
        return true;
      }
      const options = d.cells.map((_, i) => i).filter((i) => i !== start && !ends.includes(i));
      if (!options.length) return false;
      ends.push(pick(options));
      return true;
    });
  }
  return { design, count };
}

/** Drops connections that no longer run from a source to a target. */
function dropBadWires(d: Design): void {
  d.wiring = (d.wiring ?? []).filter((w) => d.cells[w.source] && d.cells[w.target] && isSource(d.cells[w.source].kind) && isTarget(d.cells[w.target].kind));
  for (const w of d.wiring) if (d.cells[w.target].kind !== 'tip') delete w.channel;
}


