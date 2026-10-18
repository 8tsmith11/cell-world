// Organism designs (what players build in the editor) and the genomes compiled
// from them. DOM-free: used by the simulation worker and the editor alike.
import { CELL, DESIGN, DNA, JET, NEURON } from '../config';

// ------------------------------------------------------------- hex grid
// Axial coordinates (q, r), pointy-top. Neighbor centers are one cell diameter apart.

export const HEX_DIRS: readonly [number, number][] = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

export const hexKey = (q: number, r: number) => (q + 1024) * 2048 + (r + 1024);

/** Position in units of one cell diameter (y down). */
export function hexToLocal(q: number, r: number): [number, number] {
  return [q + r / 2, (r * Math.sqrt(3)) / 2];
}

export function hexDistance(q1: number, r1: number, q2: number, r2: number): number {
  const dq = q1 - q2;
  const dr = r1 - r2;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

/** Rotates (q, r) by `steps` × 60° (clockwise on screen). */
export function hexRotate(q: number, r: number, steps: number): [number, number] {
  let a = q;
  let b = r;
  for (let i = 0; i < ((steps % 6) + 6) % 6; i++) [a, b] = [-b, a + b];
  return [a, b];
}

/** Index of the hex direction closest to the vector (q, r). */
export function nearestHexDir(q: number, r: number): number {
  const [x, y] = hexToLocal(q, r);
  let best = 0;
  let bestDot = -Infinity;
  HEX_DIRS.forEach(([dq, dr], i) => {
    const [dx, dy] = hexToLocal(dq, dr);
    const d = x * dx + y * dy;
    if (d > bestDot) {
      bestDot = d;
      best = i;
    }
  });
  return best;
}

export function areNeighbors(q1: number, r1: number, q2: number, r2: number): boolean {
  return hexDistance(q1, r1, q2, r2) === 1;
}

// ------------------------------------------------------------- designs

export const SENSOR_KINDS = ['lightSensor', 'nutrientSensor', 'temperatureSensor', 'touchSensor', 'proximitySensor'] as const;
export const CELL_KINDS = ['leaf', 'mouth', 'root', 'fat', 'spike', 'decomposer', 'jet', ...SENSOR_KINDS, 'neuron'] as const;
export type CellKind = (typeof CELL_KINDS)[number];
export const isSensor = (k: CellKind) => (SENSOR_KINDS as readonly string[]).includes(k);
/** Cells whose outputs can drive others: sensors and neurons. */
export const isSource = (k: CellKind) => isSensor(k) || k === 'neuron';
/** Cells that take wired inputs: Jets and neurons. */
export const isTarget = (k: CellKind) => k === 'jet' || k === 'neuron';

/** Neuron internal inputs, each with its own weight set on the neuron. */
export const NEURON_INPUT_KEYS = ['forward', 'sideways', 'turning', 'eaten', 'energy', 'nutrient', 'size', 'noise'] as const;
export type NeuronInput = (typeof NEURON_INPUT_KEYS)[number];

/**
 * Behavior wiring: a source (sensor or neuron, index into the body) drives a
 * target (Jet or neuron). A Jet's strength = its base + sum of weight × input,
 * clamped to 0-1; a neuron's target = tanh(bias + sum of weight × input + internal inputs).
 */
export interface Wire {
  source: number;
  target: number;
  /** -1 to 1. */
  weight: number;
  /** For sensor sources: its level (0 to 1) or its change (-1 to 1). Neurons have one output. */
  output: 'level' | 'change';
  /** Pattern only: whether the target is in the same repeat, the previous one, or the next ones. */
  repeat?: 'same' | 'previous' | 'next';
}
export type GrowthType = 'form' | 'blob' | 'pattern';
export type ReproductionType = 'split' | 'bud' | 'fragment';

export interface DesignCell {
  q: number;
  r: number;
  kind: CellKind;
  /** Jet only: firing strength, 0 to 1. */
  strength?: number;
  /** Proximity sensor only: count only cells of this type (absent = any cell). */
  filter?: CellKind;
  /** Neuron only: bias, speed (0-1) of moving toward its target, internal input weights, and "being eaten" range in cells. */
  bias?: number;
  speed?: number;
  inputs?: Partial<Record<NeuronInput, number>>;
  eatenRange?: number;
  /**
   * Set when compiled into a plan: hex direction (index into HEX_DIRS) from
   * this cell to the cell it's attached to, or -1. A Jet pushes that way.
   */
  push?: number;
  /** Set when compiled into a plan: the slot's index in the plan. */
  index?: number;
}

export interface BlobSettings {
  maxCells: number;
  /** Mix weights per kind. Absent in designs from the editor (the body sets the mix); mutation can add and shift them. */
  mix?: Partial<Record<CellKind, number>>;
}

/**
 * Blob's cell mix comes from the body: each kind is chosen in proportion to
 * how many cells of that kind the body has.
 */
export function bodyMix(d: Design): Record<CellKind, number> {
  const mix = Object.fromEntries(CELL_KINDS.map((k) => [k, 0])) as Record<CellKind, number>;
  if (d.blob.mix) {
    for (const k of CELL_KINDS) mix[k] = d.blob.mix[k] ?? 0;
    return mix;
  }
  for (const c of d.cells) mix[c.kind]++;
  return mix;
}

/** Strength for Jets that Blob adds: the average of the body's Jets (or the default). */
export function blobJetStrength(d: Design): number {
  const jets = d.cells.filter((c) => c.kind === 'jet');
  return jets.length ? jets.reduce((s, c) => s + jetStrength(c), 0) / jets.length : JET.defaultStrength;
}

export interface Design {
  name: string;
  /** Body cells in placement order. cells[0] is the starter. For Pattern, the body is the motif. */
  cells: DesignCell[];
  growth: GrowthType;
  /** Blob: grows the body first, then adds cells at random free edge spots up to maxCells. */
  blob: BlobSettings;
  /** Pattern: indices into `cells`. */
  pattern: { start: number; ends: number[]; maxRepeats: number };
  reproduction: ReproductionType;
  /** Behavior wiring from sensors and neurons to Jets and neurons. Applies to Form and Pattern designs. */
  wiring?: Wire[];
  /** 0-1 (default in the middle); scales all mutation chances. Inherited by offspring. */
  mutationRate?: number;
  /** 0-1: how hard offspring are launched away when it buds, splits or fragments (0 = no launch). */
  launch?: number;
  /** Stored energy and nutrient a cell spends to add one cell. */
  growEnergy: number;
  growNutrient: number;
}

/** Reproduction types each growth type allows. */
export const ALLOWED_REPRODUCTION: Record<GrowthType, ReproductionType[]> = {
  form: ['bud'],
  blob: ['split', 'bud', 'fragment'],
  pattern: ['split', 'bud', 'fragment'],
};

export function singleCellDesign(name: string, kind: CellKind): Design {
  return {
    name,
    cells: [{ q: 0, r: 0, kind }],
    growth: 'form',
    blob: { maxCells: DESIGN.blobMaxCellsDefault },
    pattern: { start: 0, ends: [], maxRepeats: DESIGN.patternMaxRepeatsDefault },
    reproduction: 'bud',
    growEnergy: DESIGN.growEnergyDefault,
    growNutrient: DESIGN.growNutrientDefault,
  };
}

/** Built-in single-cell designs, always available. */
export const BUILTIN_DESIGNS: Design[] = [singleCellDesign('Leaf', 'leaf'), singleCellDesign('Mouth', 'mouth')];

/** Upgrades designs saved before wiring had general sources and targets ({sensor, jet} wires). */
export function normalizeDesign(d: Design): Design {
  if (d.wiring?.some((w) => (w as unknown as { sensor?: number }).sensor !== undefined)) {
    d.wiring = d.wiring.map((w) => {
      const old = w as unknown as { sensor?: number; jet?: number };
      return old.sensor !== undefined ? { source: old.sensor, target: old.jet!, weight: w.weight, output: w.output } : w;
    });
  }
  return d;
}

export const neuronBias = (c: DesignCell) => c.bias ?? NEURON.defaultBias;
export const neuronSpeed = (c: DesignCell) => c.speed ?? NEURON.defaultSpeed;

/** Returns a reason the design can't be used, or null if it's valid. */
export function validateDesign(d: Design): string | null {
  normalizeDesign(d);
  if (!d.cells.length) return 'Place at least one cell.';
  if (d.cells.length > DESIGN.maxCells) return `A body can have at most ${DESIGN.maxCells} cells.`;
  const seen = new Set<number>();
  for (let i = 0; i < d.cells.length; i++) {
    const c = d.cells[i];
    const k = hexKey(c.q, c.r);
    if (seen.has(k)) return 'Two cells share a spot.';
    seen.add(k);
    if (i > 0 && !d.cells.slice(0, i).some((p) => areNeighbors(p.q, p.r, c.q, c.r))) {
      return 'Every cell must touch a cell placed before it.';
    }
  }
  if (!ALLOWED_REPRODUCTION[d.growth].includes(d.reproduction)) return 'That reproduction type is not allowed for this growth type.';
  if (d.cells.some((c) => c.strength !== undefined && !(c.strength >= 0 && c.strength <= 1))) return 'Jet strength must be between 0 and 1.';
  if (d.cells.some((c) => c.filter !== undefined && !(CELL_KINDS as readonly string[]).includes(c.filter))) return 'Unknown proximity sensor filter.';
  for (const w of d.wiring ?? []) {
    if (!d.cells[w.source] || !isSource(d.cells[w.source].kind) || !d.cells[w.target] || !isTarget(d.cells[w.target].kind)) {
      return 'A connection must run from a sensor or neuron to a Jet or neuron.';
    }
    if (!(w.weight >= -1 && w.weight <= 1)) return 'Connection weights must be between -1 and 1.';
  }
  for (const c of d.cells) {
    if (c.speed !== undefined && !(c.speed >= 0 && c.speed <= 1)) return 'Neuron speed must be between 0 and 1.';
    if (c.bias !== undefined && !(c.bias >= -1 && c.bias <= 1)) return 'Neuron bias must be between -1 and 1.';
  }
  if (d.launch !== undefined && !(d.launch >= 0 && d.launch <= 1)) return 'Launch strength must be between 0 and 1.';
  if (d.growNutrient < CELL.bodyNutrient) return `Each new cell needs at least ${CELL.bodyNutrient} nutrient for its body.`;
  if (d.growth === 'blob' && d.blob.maxCells < d.cells.length) return 'Max cells must be at least the body size.';
  if (d.growth === 'pattern') {
    const { start, ends } = d.pattern;
    if (!d.cells[start]) return 'Mark a start cell for the motif.';
    if (!ends.length) return 'Mark at least one end point.';
    if (ends.some((e) => !d.cells[e] || e === start)) return 'End points must be motif cells other than the start.';
  }
  return null;
}

// ------------------------------------------------------------- genomes

/** A compiled connection into a target plan slot. */
export interface SlotWire {
  /** Source plan slot. */
  source: number;
  weight: number;
  /** Use the sensor's change output (sensor sources only). */
  change: boolean;
}

export interface Genome {
  design: Design;
  /** Behavior wiring by target plan slot (Form and Pattern designs; empty otherwise). */
  wires: Map<number, SlotWire[]>;
  /** Ordered slots to grow (organism-local hex positions). plan[0] is the starter. */
  plan: DesignCell[];
  /** Size at which the organism stops growing and can reproduce. */
  maxCells: number;
  /** Body-frame "forward" (layout units): the way its Jets push overall, or +x without Jets. */
  forward: [number, number];
}

function forwardOf(plan: DesignCell[]): [number, number] {
  let fx = 0;
  let fy = 0;
  for (const c of plan) {
    if (c.kind !== 'jet' || c.push === undefined || c.push < 0) continue;
    const [x, y] = hexToLocal(...HEX_DIRS[c.push]);
    fx += x;
    fy += y;
  }
  const len = Math.hypot(fx, fy);
  return len > 1e-6 ? [fx / len, fy / len] : [1, 0];
}

/** Turns a design into the plan its organisms grow. */
export function compileGenome(design: Design): Genome {
  normalizeDesign(design);
  const wires = new Map<number, SlotWire[]>();
  const addWire = (target: number, wire: SlotWire) => {
    let list = wires.get(target);
    if (!list) wires.set(target, (list = []));
    list.push(wire);
  };
  if (design.growth === 'pattern') {
    const { plan: raw, repeats } = patternPlan(design);
    const plan = withAttachments(raw);
    // Wiring drawn in the motif is copied into every repeat. Targets can be in
    // the same repeat, the previous one (the one it attached to), or the next
    // ones (every repeat attached to it).
    for (const rep of repeats) {
      for (const w of design.wiring ?? []) {
        const source = rep.slots[w.source];
        if (source < 0) continue;
        const where = w.repeat ?? 'same';
        const into =
          where === 'same' ? [rep] : where === 'previous' ? (rep.parent >= 0 ? [repeats[rep.parent]] : []) : rep.children.map((c) => repeats[c]);
        for (const r of into) {
          const target = r.slots[w.target];
          if (target >= 0) addWire(target, { source, weight: w.weight, change: w.output === 'change' });
        }
      }
    }
    return { design, plan, maxCells: plan.length, wires, forward: forwardOf(plan) };
  }
  // For Form and Blob the plan is the body in order, so plan slot = body index.
  const plan = withAttachments(design.cells.map((c) => ({ ...c })));
  const maxCells = design.growth === 'blob' ? Math.min(DESIGN.maxCells, design.blob.maxCells) : plan.length;
  if (design.growth === 'form') {
    for (const w of design.wiring ?? []) addWire(w.target, { source: w.source, weight: w.weight, change: w.output === 'change' });
  }
  return { design, plan, maxCells, wires, forward: forwardOf(plan) };
}

/**
 * Pattern: repeats of the motif. Each repeat attaches its start cell next to an
 * end point of the previous repeat, continuing in the direction from start to
 * that end. One end point makes a chain; several make it branch. Within a
 * repeat, cells are ordered outward from the start so each touches an earlier
 * one. Spots already taken are skipped.
 */
interface Repeat {
  /** Plan slot of each motif cell in this repeat (-1 where the spot was already taken). */
  slots: number[];
  parent: number;
  children: number[];
}

function patternPlan(d: Design): { plan: DesignCell[]; repeats: Repeat[] } {
  const motif = d.cells;
  const s = motif[d.pattern.start];
  const rel = motif.map((c) => [c.q - s.q, c.r - s.r] as [number, number]);
  const order = bfsOrder(motif, d.pattern.start);
  const mainDir = nearestHexDir(...rel[d.pattern.ends[0]]);
  const plan: DesignCell[] = [];
  const taken = new Set<number>();
  const repeats: Repeat[] = [];
  // Each queued repeat: rotation (60° steps), where its start cell goes, and the repeat it attaches to.
  const queue: { rot: number; q: number; r: number; parent: number }[] = [{ rot: 0, q: s.q, r: s.r, parent: -1 }];
  while (queue.length && repeats.length < Math.max(1, d.pattern.maxRepeats) && plan.length < DESIGN.maxCells) {
    const rep = queue.shift()!;
    const index = repeats.length;
    const slots = motif.map(() => -1);
    repeats.push({ slots, parent: rep.parent, children: [] });
    if (rep.parent >= 0) repeats[rep.parent].children.push(index);
    for (const i of order) {
      const [dq, dr] = hexRotate(...rel[i], rep.rot);
      const q = rep.q + dq;
      const r = rep.r + dr;
      const k = hexKey(q, r);
      if (taken.has(k) || plan.length >= DESIGN.maxCells) continue;
      taken.add(k);
      // Copy the motif cell's own settings (Jet strength, sensor filter, neuron settings).
      const { q: _q, r: _r, ...settings } = motif[i];
      slots[i] = plan.length;
      plan.push({ ...settings, q, r });
    }
    for (const e of d.pattern.ends) {
      const [eq, er] = hexRotate(...rel[e], rep.rot);
      const dir = nearestHexDir(eq, er);
      const [sq, sr] = HEX_DIRS[dir];
      queue.push({ rot: rep.rot + (nearestHexDir(...rel[e]) - mainDir), q: rep.q + eq + sq, r: rep.r + er + sr, parent: index });
    }
  }
  return { plan, repeats };
}

/**
 * The cell each cell is attached to: its earliest-placed neighbor before it
 * (the cell it grows from). The starter has none before it, so it uses its
 * earliest neighbor after it. Jets push toward this cell, exhaust pointing away.
 */
export function attachDirection(cells: DesignCell[], i: number): number {
  const c = cells[i];
  const pick = (j: number) => HEX_DIRS.findIndex(([dq, dr]) => c.q + dq === cells[j].q && c.r + dr === cells[j].r);
  for (let j = 0; j < i; j++) if (areNeighbors(c.q, c.r, cells[j].q, cells[j].r)) return pick(j);
  for (let j = i + 1; j < cells.length; j++) if (areNeighbors(c.q, c.r, cells[j].q, cells[j].r)) return pick(j);
  return -1;
}

function withAttachments(plan: DesignCell[]): DesignCell[] {
  return plan.map((c, i) => ({ ...c, push: attachDirection(plan, i), index: i }));
}

/** A Jet is blocked (no thrust) when a cell of its own body sits in its exhaust hex. */
export function jetBlocked(cells: DesignCell[], i: number): boolean {
  const dir = attachDirection(cells, i);
  if (dir < 0) return false;
  const [dq, dr] = HEX_DIRS[dir];
  const q = cells[i].q - dq;
  const r = cells[i].r - dr;
  return cells.some((c) => c.q === q && c.r === r);
}

/** DNA cost to release one organism: the sum of its body cells' costs. */
export function releaseCost(d: Design): number {
  return d.cells.reduce((sum, c) => sum + DNA.cellCost[c.kind], 0);
}

/** Strength a Jet fires at (from the design, or the default). */
export const jetStrength = (c: DesignCell) => c.strength ?? JET.defaultStrength;

function bfsOrder(cells: DesignCell[], start: number): number[] {
  const order = [start];
  const seen = new Set([start]);
  for (let h = 0; h < order.length; h++) {
    const c = cells[order[h]];
    cells.forEach((o, j) => {
      if (!seen.has(j) && areNeighbors(c.q, c.r, o.q, o.r)) {
        seen.add(j);
        order.push(j);
      }
    });
  }
  return order;
}

/** Sums used by the editor's stats panel. */
export function designStats(d: Design) {
  const g = compileGenome(d);
  const plan = g.plan;
  // Expected count per kind: the plan, plus Blob's random cells split by the body's mix.
  const extra = g.maxCells - plan.length;
  const mix = bodyMix(d);
  const total = d.cells.length || 1;
  const kinds = Object.fromEntries(
    CELL_KINDS.map((k) => [k, plan.filter((c) => c.kind === k).length + (d.growth === 'blob' ? Math.round((extra * mix[k]) / total) : 0)]),
  ) as Record<CellKind, number>;
  return {
    cells: g.maxCells,
    kinds,
    /** Nutrient to grow from the starter to full size. */
    growNutrient: Math.max(0, g.maxCells - 1) * d.growNutrient,
    /** Nutrient that must be stored before reproducing. */
    reproduceNutrient: d.growNutrient,
  };
}
