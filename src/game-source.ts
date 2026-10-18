import type { Design } from './sim/genome';
import type { CellInfo } from './sim/protocol';

/** Static world fields, generated from the seed. */
export interface StaticWorld {
  seed: number;
  depth: Float32Array;
  temperature: Float32Array;
  currentDir: Float32Array;
  currentStrength: Float32Array;
}

/** Cell state for drawing, one entry per cell slot (type 0 = empty slot). */
export interface RenderCells {
  cellCount: number;
  cellType: Uint8Array;
  cellX: Float32Array;
  cellY: Float32Array;
  cellAngle: Float32Array;
  cellEnergy: Float32Array;
  /** Body nutrient (dead cells fade with it). */
  cellNutrient: Uint32Array;
  /** 1 while a Mouth, Spike or Decomposer is draining the cell. */
  cellDrained: Uint8Array;
  /** 1 while a Jet is firing. */
  cellFiring: Uint8Array;
  /** Owning player of each cell (its organism's owner). */
  cellOwner: Int32Array;
  /** Bonded cell pairs: [a0, b0, a1, b1, ...]. */
  bonds: Int32Array;
}

/** A design the host can spawn in debug mode, and the player who owns it. */
export interface SpawnChoice {
  label: string;
  owner: number;
  design: Design;
}

/** One of the player's own species (lineages). */
export interface SpeciesInfo {
  name: string;
  organisms: number;
  extinct: boolean;
}

export interface BoardEntry {
  category: string;
  /** Lineage name, or '' when nobody qualifies yet. */
  lineage: string;
  color: number;
  value: string;
}

export interface FeedItem {
  text: string;
  color: number;
  /** performance.now() when it arrived. */
  at: number;
}

export interface ViewRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * What the game view reads from and talks to. The host implements it on top of
 * its own simulation worker; clients implement it on top of replicated state.
 */
export interface GameSource {
  readonly isHost: boolean;
  /** This player's id (the host is 0). */
  readonly selfId: number;
  readonly debug: boolean;
  /** Bumped whenever the static world is (re)generated. */
  readonly worldVersion: number;
  readonly world: StaticWorld | null;
  cells(now: number): RenderCells | null;
  /** Water nutrient per tile. */
  water(): Uint32Array | null;
  time(): number;
  paused(): boolean;
  /** Full fields of the hovered cell, when known. */
  hoverInfo(): CellInfo | null;
  setHover(id: number): void;
  setView(view: ViewRect): void;
  /** Nutrient totals (debug mode only). */
  stats(): { water: number; cells: number } | null;
  /** Host debug tools; no-ops elsewhere. */
  reroll(): void;
  spawn(choice: SpawnChoice, x: number, y: number): void;
  /** Designs the host can spawn: built-ins plus every player's saved designs. Bumps designsVersion. */
  spawnChoices(): SpawnChoice[];
  readonly designsVersion: number;
  /** This player's saved designs changed (clients send them to the host). */
  shareDesigns(designs: Design[]): void;
  togglePause(): void;
  step(): void;
  /** Simulation speed multiplier (debug mode, host only). */
  setSpeed(speed: number): void;
  /** A short message for this player, e.g. why a release failed. */
  notice(): string;
  /** Release one organism of one of this player's saved designs (costs DNA). */
  releaseDesign(design: Design, x: number, y: number): void;
  /** This player's DNA (each player sees only their own). */
  dna(): number | null;
  species(): SpeciesInfo[];
  board(): BoardEntry[];
  feed(): FeedItem[];
  playerColor(owner: number): number;
}
