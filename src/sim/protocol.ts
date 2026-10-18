import type { Design } from './genome';
import type { ExtinctionEvent, LineageStats } from './lineages';

// Messages between the main thread and the simulation worker.

export type ToWorker =
  | { type: 'generate'; seed: number }
  /** Release one organism of a design for a player; answered with 'released' carrying the same id. */
  | { type: 'release'; id: number; design: Design; owner: number; x: number; y: number }
  | { type: 'inspect'; ids: number[] }
  | { type: 'pause'; paused: boolean }
  | { type: 'step' }
  | { type: 'speed'; speed: number };
// `inspect` selects the cells whose full fields come back in each frame (hover, for every player).

export interface WorldMsg {
  type: 'world';
  seed: number;
  width: number;
  height: number;
  depth: Float32Array;
  temperature: Float32Array;
  currentDir: Float32Array;
  currentStrength: Float32Array;
}

export interface OrganismInfo {
  id: number;
  owner: number;
  lineage: number;
  /** Summary of the organism's genome (its design). */
  genome: { name: string; growth: string; reproduction: string; maxCells: number };
  /** Filled in by the host: "<player>'s <design>". */
  lineageName?: string;
  /** Generations since release (1 = released) and mutations accumulated. */
  generation: number;
  mutations: number;
  /** The organism's own (possibly mutated) design, so a player can load it into the editor. */
  design: Design;
  cellCount: number;
}

export interface CellInfo {
  id: number;
  alive: number;
  type: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  energy: number;
  bodyNutrient: number;
  storedNutrient: number;
  age: number;
  organism: number;
  org: OrganismInfo | null;
}

export interface FrameMsg {
  type: 'frame';
  tick: number;
  time: number;
  paused: boolean;
  /** Cell slots in use (arrays below have this length; type 0 = empty slot). */
  cellCount: number;
  cellType: Uint8Array;
  cellX: Float32Array;
  cellY: Float32Array;
  cellAngle: Float32Array;
  cellEnergy: Float32Array;
  /** Body nutrient per cell (dead cells fade as it returns to the water). */
  cellNutrient: Uint32Array;
  /** Bonded cell pairs: [a0, b0, a1, b1, ...]. */
  bonds: Int32Array;
  /** 1 if a Mouth drained the cell this tick. */
  cellDrained: Uint8Array;
  /** 1 if a Jet fired this tick. */
  cellFiring: Uint8Array;
  cellOrganism: Int32Array;
  /** Lineage and owner of each cell (Dead cells keep theirs). */
  cellLineage: Int32Array;
  cellOwner: Int32Array;
  /** Cell events since the previous frame (see CellEvent in sim.ts). */
  events: Float32Array;
  waterNutrient: Uint32Array;
  living: number;
  dead: number;
  organisms: number;
  waterNutrientTotal: number;
  cellNutrientTotal: number;
  inspect: CellInfo[];
}

export type ReleaseResult = { type: 'released'; id: number } & ({ ok: true; lineage: number } | { ok: false; reason: string });

/** Every LINEAGE.statsIntervalSec: per-lineage stats and extinctions since the last report. */
export interface LineageReport {
  type: 'lineages';
  stats: LineageStats[];
  extinctions: ExtinctionEvent[];
}

export type FromWorker = WorldMsg | FrameMsg | ReleaseResult | LineageReport;
