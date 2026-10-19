import {
  BONDS,
  CELL,
  CHEMOSYNTH,
  COLONY,
  DEAD,
  FILTER,
  NUTRIENT_FLOW,
  SHELL,
  TIMER,
  TIP,
  DECOMPOSER,
  DESIGN,
  FAT,
  GROWTH,
  JET,
  LEAF,
  METABOLISM,
  MOUTH,
  LINEAGE,
  NEURON,
  NEURON_INPUTS,
  PHYSICS,
  RELEASE,
  ROOT,
  SENSOR,
  SIM,
  SPIKE,
  TEMPERATURE,
  WORLD,
} from '../config';
import { type CurrentField, sampleCurrent } from './currents';
import {
  compileGenome,
  type Design,
  type DesignCell,
  type Genome,
  HEX_DIRS,
  hexDistance,
  jetStrength,
  hexKey,
  hexToLocal,
  validateDesign,
  blobJetStrength,
  NEURON_INPUT_KEYS,
  neuronBias,
  neuronSpeed,
  timerCycles,
  timerDuty,
  timerPhase,
  tipDeposit,
  tipGrow,
  bodyMix,
  CELL_KINDS,
  type CellKind,
  type ProximityFilter,
  type SlotWire,
} from './genome';
import { type ExtinctionEvent, type LineageStats, Lineages } from './lineages';
import { mutate } from './mutation';
import { createRng } from './rng';
import { dayPhase, generateWorld, stepNutrientFlow, stepWorld, type World } from './world';

export const CellType = {
  None: 0,
  Leaf: 1,
  Dead: 2,
  Mouth: 3,
  Root: 4,
  Fat: 5,
  Spike: 6,
  Decomposer: 7,
  Jet: 8,
  LightSensor: 9,
  NutrientSensor: 10,
  TemperatureSensor: 11,
  TouchSensor: 12,
  ProximitySensor: 13,
  Neuron: 14,
  Chemosynth: 15,
  Filter: 16,
  Shell: 17,
  Tip: 18,
  Timer: 19,
} as const;
export const CELL_TYPE_NAMES = [
  'None',
  'Leaf',
  'Dead',
  'Mouth',
  'Root',
  'Fat',
  'Spike',
  'Decomposer',
  'Jet',
  'Light sensor',
  'Nutrient sensor',
  'Temperature sensor',
  'Touch sensor',
  'Proximity sensor',
  'Neuron',
  'Chemosynth',
  'Filter',
  'Shell',
  'Growth tip',
  'Timer',
];
export const isSensorType = (t: number) => t >= CellType.LightSensor && t <= CellType.ProximitySensor;
const KIND_TYPE = {
  leaf: CellType.Leaf,
  mouth: CellType.Mouth,
  root: CellType.Root,
  fat: CellType.Fat,
  spike: CellType.Spike,
  decomposer: CellType.Decomposer,
  jet: CellType.Jet,
  lightSensor: CellType.LightSensor,
  nutrientSensor: CellType.NutrientSensor,
  temperatureSensor: CellType.TemperatureSensor,
  touchSensor: CellType.TouchSensor,
  proximitySensor: CellType.ProximitySensor,
  neuron: CellType.Neuron,
  chemosynth: CellType.Chemosynth,
  filter: CellType.Filter,
  shell: CellType.Shell,
  tip: CellType.Tip,
  timer: CellType.Timer,
} as const;
/** Style key (see CELL_STYLE in config) for each cell type. */
export const TYPE_STYLE = [
  'dead',
  'leaf',
  'dead',
  'mouth',
  'root',
  'fat',
  'spike',
  'decomposer',
  'jet',
  'lightSensor',
  'nutrientSensor',
  'temperatureSensor',
  'touchSensor',
  'proximitySensor',
  'neuron',
  'chemosynth',
  'filter',
  'shell',
  'tip',
  'timer',
] as const;
/** Upkeep multiplier per cell type (METABOLISM.typeUpkeep, 1 where absent). */
const TYPE_UPKEEP = TYPE_STYLE.map((k) => METABOLISM.typeUpkeep[k] ?? 1);

/** Most bonds one cell can have (hex neighbors are 6; a little headroom). */
const BOND_SLOTS = 8;
const SQRT3_2 = Math.sqrt(3) / 2;
/** Angle of the hex direction (dq, dr) in the organism's layout. */
const hexAngle = (dq: number, dr: number) => Math.atan2(dr * SQRT3_2, dq + dr / 2);

/**
 * A timer's level: 1 while on, 0 while off, following the time of day. It
 * switches on at `phase` of each cycle and stays on for `duty` of it, with
 * edges ramped over TIMER.edge of a cycle.
 */
export function timerLevel(day: number, cycles: number, phase: number, duty: number): number {
  if (duty <= 0) return 0;
  if (duty >= 1) return 1;
  const p = (((day * cycles - phase) % 1) + 1) % 1; // position in the cycle; 0 = switch-on
  const e = Math.min(TIMER.edge, duty / 2);
  return Math.min(1, Math.max(0, Math.min(p, duty - p) / e));
}

/** Energy a cell of this type can hold. Fat holds much more. */
export const energyCap = (type: number) => (type === CellType.Fat ? FAT.maxEnergy : CELL.maxEnergy);
/** Stored nutrient a cell of this type can hold. Fat holds much more, Root somewhat more. */
export const storedCap = (type: number) =>
  type === CellType.Fat ? FAT.storedNutrientCap : type === CellType.Root ? ROOT.storedNutrientCap : CELL.storedNutrientCap;

/**
 * Events, recorded for network replication. Each event is EVENT_STRIDE numbers.
 * Cell events: kind, id, type, x, y, angle, energy, body nutrient, organism, owner, lineage.
 * Bond events: kind, cell A, cell B, then padding.
 * Died is the living -> Dead type change; TypeChanged covers any other change.
 * A cell that is eaten is Removed (it never becomes Dead).
 */
export const CellEvent = { Born: 1, Died: 2, Removed: 3, TypeChanged: 4, BondAdded: 5, BondRemoved: 6 } as const;
export const EVENT_STRIDE = 11;

/** Cells, bonds and organisms as flat typed arrays, plus the world they live in. DOM-free. */
export class Sim {
  readonly world: World;
  readonly worldWidth = WORLD.width * WORLD.tileSize;
  readonly worldHeight = WORLD.height * WORLD.tileSize;
  tick = 0;
  private rng: () => number;

  // Cells. `alive` is 1 for living cells; `type` None marks an empty slot.
  readonly alive = new Uint8Array(SIM.maxCells);
  readonly type = new Uint8Array(SIM.maxCells);
  readonly x = new Float32Array(SIM.maxCells);
  readonly y = new Float32Array(SIM.maxCells);
  readonly vx = new Float32Array(SIM.maxCells);
  readonly vy = new Float32Array(SIM.maxCells);
  /** Orientation of the organism's hex frame at this cell. */
  readonly angle = new Float32Array(SIM.maxCells);
  readonly energy = new Float32Array(SIM.maxCells);
  /** Nutrient the cell's body is made of (CELL.bodyNutrient while alive). */
  readonly bodyNutrient = new Uint32Array(SIM.maxCells);
  /** Surplus nutrient, up to CELL.storedNutrientCap. */
  readonly storedNutrient = new Uint32Array(SIM.maxCells);
  readonly age = new Uint32Array(SIM.maxCells);
  readonly organism = new Int32Array(SIM.maxCells).fill(-1);
  /** The cell's lineage. Kept after death, so Dead cells still count as that lineage (e.g. for Decomposers). */
  readonly cellLineage = new Int32Array(SIM.maxCells);
  /** Last Spike lineage to drain the cell, and when (for death credit). */
  private spikedBy = new Int32Array(SIM.maxCells);
  private spikedAt = new Int32Array(SIM.maxCells).fill(-1e9);
  /** Jet: hex direction (in its organism's layout) toward the cell it's attached to, or -1. It pushes that way. */
  readonly jetPush = new Int8Array(SIM.maxCells).fill(-1);
  readonly jetStrength = new Float32Array(SIM.maxCells);
  /** Which slot of its organism's plan the cell fills (-1 for Blob's random cells). Wiring uses it. */
  readonly planSlot = new Int16Array(SIM.maxCells).fill(-1);
  /** Neurons: output (-1 to 1), the previous tick's outputs, bias, speed, internal input weights, "being eaten" range, noise state. */
  readonly neuronOut = new Float32Array(SIM.maxCells);
  private neuronPrev = new Float32Array(SIM.maxCells);
  private neuronBias = new Float32Array(SIM.maxCells);
  private neuronSpeed = new Float32Array(SIM.maxCells);
  private neuronInputs = new Float32Array(SIM.maxCells * NEURON_INPUT_KEYS.length);
  private neuronEatenRange = new Uint8Array(SIM.maxCells);
  private neuronNoise = new Float32Array(SIM.maxCells);
  /** Energy drained from each cell by Mouths and Spikes this tick. */
  private drainTaken = new Float32Array(SIM.maxCells);
  /** Proximity sensors: the cell type they count (CellType), or 0 for any cell. */
  readonly proxFilter = new Uint8Array(SIM.maxCells);
  /** Sensors: current level (0 to 1), its recent moving average, and change (-1 to 1). */
  readonly sensorLevel = new Float32Array(SIM.maxCells);
  private sensorAvg = new Float32Array(SIM.maxCells);
  readonly sensorChange = new Float32Array(SIM.maxCells);
  /**
   * Growth tips: the hex direction they grow (in their organism's layout),
   * their Grow/Turn/Branch signals (3 per cell) and base values, the cell types
   * they leave behind (up to TIP.maxDeposit, as CellType) and how many, how
   * many cells they've left behind, and advances since they last branched.
   */
  readonly tipDir = new Int8Array(SIM.maxCells);
  readonly tipSignal = new Float32Array(SIM.maxCells * 3);
  private tipBase = new Float32Array(SIM.maxCells * 3);
  private tipDeposit = new Uint8Array(SIM.maxCells * TIP.maxDeposit);
  private tipDepositLen = new Uint8Array(SIM.maxCells);
  private tipCounter = new Uint16Array(SIM.maxCells);
  private tipSinceBranch = new Uint16Array(SIM.maxCells);
  /** Timers: cycles per day, phase and duty. */
  private timerCycles = new Uint8Array(SIM.maxCells);
  private timerPhase = new Float32Array(SIM.maxCells);
  private timerDuty = new Float32Array(SIM.maxCells);
  /** 1 while a Jet fired this tick (for the exhaust trail). */
  readonly firing = new Uint8Array(SIM.maxCells);
  /** 1 for cells of an organism with a living Root: they don't move at all. */
  private pinned = new Uint8Array(SIM.maxCells);
  /** The cell's spot in its organism's hex layout. */
  readonly hexQ = new Int16Array(SIM.maxCells);
  readonly hexR = new Int16Array(SIM.maxCells);
  /** High-water mark of used cell slots. */
  cellCount = 0;
  private freeCells: number[] = [];
  /** Events since the last drainEvents() call. */
  private events: number[] = [];

  // Bonds. bondA = -1 marks an empty slot.
  readonly bondA = new Int32Array(SIM.maxBonds).fill(-1);
  readonly bondB = new Int32Array(SIM.maxBonds).fill(-1);
  readonly bondRest = new Float32Array(SIM.maxBonds);
  bondCount = 0;
  private freeBonds: number[] = [];
  /** Each cell's bonds: up to BOND_SLOTS bond ids per cell, and how many it has. */
  private cellBonds = new Int32Array(SIM.maxCells * BOND_SLOTS);
  private bondDeg = new Uint8Array(SIM.maxCells);
  /** The cell's designed spot relative to its organism's origin, in world units (from hexQ/hexR). */
  private restX = new Float32Array(SIM.maxCells);
  private restY = new Float32Array(SIM.maxCells);

  // Organisms. orgCells 0 marks an empty slot.
  readonly owner = new Int32Array(SIM.maxOrganisms);
  readonly lineage = new Int32Array(SIM.maxOrganisms);
  readonly lineages = new Lineages();
  /** Latest lineage report (every LINEAGE.statsIntervalSec), taken by the worker. */
  lineageReport: { stats: LineageStats[]; extinctions: ExtinctionEvent[] } | null = null;
  readonly genomeId = new Int32Array(SIM.maxOrganisms);
  readonly orgCells = new Int32Array(SIM.maxOrganisms);
  /** Generations since release (released organisms are generation 1), and mutations accumulated along the way. */
  readonly generation = new Int32Array(SIM.maxOrganisms);
  readonly mutations = new Int32Array(SIM.maxOrganisms);
  /** Worm: segments the organism has (its plan and wiring follow this count). */
  readonly orgSegments = new Int16Array(SIM.maxOrganisms).fill(1);
  /** Growth tips: which tip advances next, and growth checks in a row with every active tip blocked. */
  private orgTipTurn = new Uint16Array(SIM.maxOrganisms);
  private orgTipStuck = new Uint8Array(SIM.maxOrganisms);
  /** Each organism's body rotation (from shape matching), the one before, and the tick it was measured. */
  private orgAngle = new Float32Array(SIM.maxOrganisms);
  private orgAnglePrev = new Float32Array(SIM.maxOrganisms);
  private orgAngleTick = new Int32Array(SIM.maxOrganisms).fill(-10);
  /** Spots (with their cell types) each organism has lost to eating or death, newest last: regrown first. */
  private lost = new Map<number, DesignCell[]>();
  /** Organisms splitting to reproduce (their new pieces are offspring and may mutate). */
  private reproducing = new Set<number>();
  orgCount = 0;
  private freeOrgs: number[] = [];
  readonly genomes: Genome[] = [];
  private genomeIds = new Map<string, number>();
  /** Organisms that lost a bond and may have come apart. */
  private dirtyOrgs = new Set<number>();

  // Scratch.
  private oldX = new Float32Array(SIM.maxCells);
  private oldY = new Float32Array(SIM.maxCells);
  /** Living cells grouped by organism (see groupOrganisms): orgList[orgStart[o] .. orgStart[o + 1]). */
  private orgStart = new Int32Array(SIM.maxOrganisms + 1);
  private orgList = new Int32Array(SIM.maxCells);
  private orgFill = new Int32Array(SIM.maxOrganisms);
  private contactFill = new Int32Array(0);
  /** Per-organism flags and sums, reused every tick. */
  private orgFlag = new Uint8Array(SIM.maxOrganisms);
  private orgSum = new Float32Array(SIM.maxOrganisms * 7);
  /** Connected-component labels for splitting (compared against splitStamp). */
  private compStamp = new Int32Array(SIM.maxCells);
  private splitStamp = 0;
  /** Wired sources this tick, built once per tick on demand. */
  private sourcesCache: Map<number, number> | null = null;
  private sourcesTick = -1;
  private hashCols: number;
  private hashRows: number;
  private hashHead: Int32Array;
  private hashNext = new Int32Array(SIM.maxCells);
  /** Contact solving: cells sorted by contact-grid bucket, with copies of their positions in that order. */
  private sortedIds = new Int32Array(SIM.maxCells);
  private sortedX = new Float32Array(SIM.maxCells);
  private sortedY = new Float32Array(SIM.maxCells);
  private sortedPinned = new Uint8Array(SIM.maxCells);
  private contactStart: Int32Array;
  private contactCols: number;
  private contactRows: number;
  /** Spatial hash cell size: covers contacts (2r) and every touching distance. */
  private bucket = CELL.radius * Math.max(2, MOUTH.touchDistance, DECOMPOSER.touchDistance);
  /** 1 for cells drained by a Mouth this tick (for the render cue). */
  readonly drained = new Uint8Array(SIM.maxCells);

  /** Snapshot buffer for nutrient flow. */
  private waterScratch: Uint32Array;
  /** Marine snow: per-tile drift of Dead cells toward deeper water (world units per second). */
  private sinkX: Float32Array;
  private sinkY: Float32Array;

  constructor(seed: number) {
    this.world = generateWorld(seed);
    this.rng = createRng(seed ^ 0x9e3779b9);
    this.waterScratch = new Uint32Array(this.world.nutrient.length);
    [this.sinkX, this.sinkY] = this.sinkField();
    this.hashCols = Math.ceil(this.worldWidth / this.bucket);
    this.hashRows = Math.ceil(this.worldHeight / this.bucket);
    this.hashHead = new Int32Array(this.hashCols * this.hashRows);
    this.contactCols = Math.ceil(this.worldWidth / (2 * CELL.radius));
    this.contactRows = Math.ceil(this.worldHeight / (2 * CELL.radius));
    this.contactStart = new Int32Array(this.contactCols * this.contactRows + 1);
  }

  /** Direction down the depth slope at each tile, scaled to DEAD.sinkSpeed (zero on flat ground). */
  private sinkField(): [Float32Array, Float32Array] {
    const { width: w, height: h, depth } = this.world;
    const sx = new Float32Array(w * h);
    const sy = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const gx = depth[y * w + Math.min(w - 1, x + 1)] - depth[y * w + Math.max(0, x - 1)];
        const gy = depth[Math.min(h - 1, y + 1) * w + x] - depth[Math.max(0, y - 1) * w + x];
        const len = Math.hypot(gx, gy);
        if (len < 1e-3) continue;
        sx[y * w + x] = (gx / len) * DEAD.sinkSpeed;
        sy[y * w + x] = (gy / len) * DEAD.sinkSpeed;
      }
    }
    return [sx, sy];
  }

  tileAt(x: number, y: number): number {
    const tx = Math.min(WORLD.width - 1, Math.max(0, Math.floor(x / WORLD.tileSize)));
    const ty = Math.min(WORLD.height - 1, Math.max(0, Math.floor(y / WORLD.tileSize)));
    return ty * WORLD.width + tx;
  }

  /** Compiles a design once; identical designs share a genome. */
  registerGenome(design: Design): number {
    const key = JSON.stringify(design);
    let id = this.genomeIds.get(key);
    if (id === undefined) {
      id = this.genomes.length;
      this.genomes.push(compileGenome(design));
      this.genomeIds.set(key, id);
    }
    return id;
  }

  /** The plan an organism grows (a Worm's depends on its segment count). */
  planOf(o: number): DesignCell[] {
    const g = this.genomes[this.genomeId[o]];
    return g.worm ? g.worm.plans[Math.min(g.worm.maxSegments, Math.max(1, this.orgSegments[o]))] : g.plan;
  }

  /** An organism's wiring by target plan slot (a Worm's depends on its segment count). */
  wiresOf(o: number): Map<number, SlotWire[]> {
    const g = this.genomes[this.genomeId[o]];
    return g.worm ? g.worm.wires[Math.min(g.worm.maxSegments, Math.max(1, this.orgSegments[o]))] : g.wires;
  }

  /**
   * Releases one organism: just its starter cell, which then grows the design.
   * The starter's body is built from nutrient in the water around the release
   * point (nearest tiles first). Fails, taking
   * nothing, if there isn't enough nutrient nearby. Never creates nutrient.
   * The first release of a design starts a lineage; later ones join it.
   */
  release(design: Design, owner: number, x: number, y: number): { ok: true; lineage: number } | { ok: false; reason: string } {
    const invalid = validateDesign(design);
    if (invalid) return { ok: false, reason: invalid };
    if (x < 0 || y < 0 || x >= this.worldWidth || y >= this.worldHeight) return { ok: false, reason: 'outside the world' };
    const g = this.registerGenome(design);
    const body = this.genomes[g].plan.slice(0, 1);
    if (this.freeCells.length + (SIM.maxCells - this.cellCount) < body.length) return { ok: false, reason: 'cell limit reached' };

    // Nearest water tiles first, until the body's nutrient is covered.
    const need = body.length * CELL.bodyNutrient;
    const tx = Math.floor(x / WORLD.tileSize);
    const ty = Math.floor(y / WORLD.tileSize);
    const R = RELEASE.gatherRadius;
    const tiles: [number, number][] = [];
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const qx = tx + dx;
        const qy = ty + dy;
        if (qx < 0 || qy < 0 || qx >= WORLD.width || qy >= WORLD.height || dx * dx + dy * dy > R * R) continue;
        tiles.push([qy * WORLD.width + qx, dx * dx + dy * dy]);
      }
    }
    tiles.sort((a, b) => a[1] - b[1]);
    const water = this.world.nutrient;
    let available = 0;
    for (const [t] of tiles) if ((available += water[t]) >= need) break;
    if (available < need) return { ok: false, reason: 'not enough nutrient in the water here' };

    const lineage = this.lineages.forRelease(owner, design.name, this.tick);
    if (lineage < 0) return { ok: false, reason: 'lineage limit reached' };
    const org = this.allocOrg();
    if (org < 0) return { ok: false, reason: 'organism limit reached' };
    let remaining = need;
    for (const [t] of tiles) {
      const take = Math.min(water[t], remaining);
      water[t] -= take;
      if ((remaining -= take) === 0) break;
    }
    this.owner[org] = owner;
    this.lineage[org] = lineage;
    this.genomeId[org] = g;
    this.orgCells[org] = body.length;
    this.generation[org] = 1;
    this.mutations[org] = 0;
    this.orgSegments[org] = 1;

    // Lay the body out in its hex shape around the release point, at a random orientation.
    const frame = this.rng() * Math.PI * 2;
    const c = Math.cos(frame);
    const sn = Math.sin(frame);
    const d = 2 * CELL.radius;
    const ids: number[] = [];
    for (const slot of body) {
      const [lx, ly] = hexToLocal(slot.q - body[0].q, slot.r - body[0].r);
      const id = this.allocCell();
      this.initCell(id, slot, x + (lx * c - ly * sn) * d, y + (lx * sn + ly * c) * d, frame, CELL.spawnEnergy, org, 0);
      ids.push(id);
    }
    for (let a = 0; a < body.length; a++) {
      for (let b = a + 1; b < body.length; b++) {
        if (hexDistance(body[a].q, body[a].r, body[b].q, body[b].r) === 1) this.addBond(ids[a], ids[b], d);
      }
    }
    return { ok: true, lineage };
  }

  step(dt: number): void {
    stepWorld(this.world, dt);
    this.tick++;
    this.updateEnergy(dt);
    this.absorb(dt);
    this.feed(dt);
    this.flow(dt);
    this.updateFacing();
    this.sense(dt);
    this.updateNeurons(dt);
    this.fireJets(dt);
    this.updateTips();
    this.killStarved();
    this.resolveSplits();
    if (this.tick % GROWTH.checkInterval === 0) this.growAndReproduce();
    this.decay();
    if (this.tick % NUTRIENT_FLOW.intervalTicks === 0) stepNutrientFlow(this.world, this.waterScratch, this.rng);
    this.physics(dt);
    if (this.tick % Math.round(LINEAGE.statsIntervalSec * SIM.tickHz) === 0) this.lineageReport = this.lineages.update(this, this.tick);
  }

  // ------------------------------------------------------------- energy and nutrient

  private metabolism(temperature: number): number {
    const t = (temperature - TEMPERATURE.edge) / (TEMPERATURE.center - TEMPERATURE.edge);
    const c = Math.min(1, Math.max(0, t));
    return METABOLISM.coldMultiplier + (METABOLISM.warmMultiplier - METABOLISM.coldMultiplier) * c;
  }

  /**
   * Leaves gain energy from light, Chemosynths from vents. Every living cell
   * pays upkeep: scaled by temperature, by its type (support cells cost less),
   * and by a colony discount for cells of bigger organisms.
   */
  private updateEnergy(dt: number): void {
    const { light, temperature, chem } = this.world;
    const colonySpan = Math.max(1, COLONY.fullSize - 1);
    for (let i = 0; i < this.cellCount; i++) {
      if (!this.alive[i]) continue;
      this.age[i]++;
      const t = this.type[i];
      const tile = this.tileAt(this.x[i], this.y[i]);
      const gain =
        t === CellType.Leaf ? LEAF.photosynthesis * light[tile] * dt : t === CellType.Chemosynth ? CHEMOSYNTH.rate * chem[tile] * dt : 0;
      if (gain > 0) this.lineages.creditLight(this.cellLineage[i], gain);
      const colony = 1 - COLONY.maxDiscount * Math.min(1, (this.orgCells[this.organism[i]] - 1) / colonySpan);
      const upkeep = METABOLISM.upkeep * TYPE_UPKEEP[t] * colony * this.metabolism(temperature[tile]) * dt;
      this.energy[i] = Math.min(energyCap(t), this.energy[i] + gain - upkeep);
    }
  }

  /**
   * Leaves and Roots move nutrient from the water at their position into their
   * store, up to their cap. Roots absorb faster. Rates are in units per second,
   * moved as whole units (fractions carry over as a chance per tick).
   */
  private absorb(dt: number): void {
    const water = this.world.nutrient;
    const cur = { x: 0, y: 0 };
    const field = this.currents();
    for (let i = 0; i < this.cellCount; i++) {
      if (!this.alive[i]) continue;
      const t = this.type[i];
      let rate = 0;
      if (t === CellType.Leaf) rate = LEAF.absorbRate;
      else if (t === CellType.Chemosynth) rate = CHEMOSYNTH.absorbRate;
      else if (t === CellType.Root) rate = ROOT.absorbRate;
      else if (t === CellType.Filter) {
        // Filters feed on water moving through them: the current relative to the cell.
        sampleCurrent(field, this.x[i], this.y[i], cur);
        const flow = Math.min(1, Math.hypot(cur.x - this.vx[i], cur.y - this.vy[i]) / FILTER.fullSpeed);
        const tile = this.tileAt(this.x[i], this.y[i]);
        const e = FILTER.energyRate * flow * Math.min(1, water[tile] / FILTER.fullNutrient) * dt;
        if (e > 0) {
          this.energy[i] = Math.min(energyCap(t), this.energy[i] + e);
          this.lineages.creditLight(this.cellLineage[i], e);
        }
        rate = FILTER.absorbRate * flow;
      }
      if (rate === 0) continue;
      const amount = rate * dt;
      let units = Math.floor(amount) + (this.rng() < amount % 1 ? 1 : 0);
      if (units <= 0) continue;
      // Roots reach the richest tile within their radius; others take from their own tile.
      const tile = t === CellType.Root ? this.richestTile(this.x[i], this.y[i], ROOT.absorbRadius) : this.tileAt(this.x[i], this.y[i]);
      units = Math.min(units, water[tile], storedCap(t) - this.storedNutrient[i]);
      if (units <= 0) continue;
      water[tile] -= units;
      this.storedNutrient[i] += units;
    }
  }

  /** The tile with the most water nutrient within `radius` tiles of a point. */
  private richestTile(px: number, py: number, radius: number): number {
    const water = this.world.nutrient;
    const tx = Math.min(WORLD.width - 1, Math.max(0, Math.floor(px / WORLD.tileSize)));
    const ty = Math.min(WORLD.height - 1, Math.max(0, Math.floor(py / WORLD.tileSize)));
    let best = ty * WORLD.width + tx;
    for (let dy = -radius; dy <= radius; dy++) {
      const y = ty + dy;
      if (y < 0 || y >= WORLD.height) continue;
      for (let dx = -radius; dx <= radius; dx++) {
        const x = tx + dx;
        if (x < 0 || x >= WORLD.width || dx * dx + dy * dy > radius * radius) continue;
        const t = y * WORLD.width + x;
        if (water[t] > water[best]) best = t;
      }
    }
    return best;
  }

  private currents(): CurrentField {
    const w = this.world;
    return { dir: w.currentDir, strength: w.currentStrength, vx: w.currentVx, vy: w.currentVy };
  }

  /**
   * Energy and stored nutrient flow across bonds.
   * - Energy evens out between bonded cells, except that Fat acts as a
   *   reservoir: it takes a neighbor's energy above FAT.keepNeighborsAt of the
   *   neighbor's cap and gives energy back when the neighbor drops below it.
   *   So Fat stores the organism's surplus without starving the rest.
   * - Stored nutrient moves toward equal fullness (amount relative to each
   *   cell's cap), so a Root's big store backs up the whole body. It moves one
   *   whole unit at a time.
   */
  private flow(dt: number): void {
    const k = Math.min(0.5, BONDS.energyFlowRate * dt);
    for (let b = 0; b < this.bondCount; b++) {
      const a = this.bondA[b];
      if (a < 0) continue;
      const c = this.bondB[b];
      const fatA = this.type[a] === CellType.Fat;
      const fatC = this.type[c] === CellType.Fat;
      if (fatA !== fatC) {
        const [fat, other] = fatA ? [a, c] : [c, a];
        const keep = FAT.keepNeighborsAt * energyCap(this.type[other]);
        // Positive: other -> fat (surplus); negative: fat -> other (topping up).
        let f = k * (this.energy[other] - keep);
        // Fat never gives away its own reserve (a new Fat cell would otherwise starve on the spot).
        f = f > 0 ? Math.min(f, FAT.maxEnergy - this.energy[fat]) : -Math.min(-f, Math.max(0, this.energy[fat] - FAT.reserve));
        // Below its reserve, Fat fills up from its neighbor like any cell, so it never starves for good.
        if (this.energy[fat] < FAT.reserve && this.energy[other] > this.energy[fat]) {
          f = Math.min(k * (this.energy[other] - this.energy[fat]), FAT.reserve - this.energy[fat]);
        }
        this.energy[other] -= f;
        this.energy[fat] += f;
      } else {
        const f = k * (this.energy[a] - this.energy[c]);
        this.energy[a] -= f;
        this.energy[c] += f;
      }
      if (this.rng() >= BONDS.nutrientFlowChance) continue;
      const sa = storedCap(this.type[a]);
      const sc = storedCap(this.type[c]);
      const na = this.storedNutrient[a];
      const nc = this.storedNutrient[c];
      // Move a unit only if it doesn't overshoot (the giver stays at least as full as the taker).
      if (na > 0 && (na - 1) / sa >= (nc + 1) / sc) {
        this.storedNutrient[a]--;
        this.storedNutrient[c]++;
      } else if (nc > 0 && (nc - 1) / sc >= (na + 1) / sa) {
        this.storedNutrient[c]--;
        this.storedNutrient[a]++;
      }
    }
  }

  /** Cells with a facing direction: Jets and sensors face outward from the cell they're attached to. */
  private faces(i: number): boolean {
    return this.type[i] === CellType.Tip || (this.jetPush[i] >= 0 && (this.type[i] === CellType.Jet || isSensorType(this.type[i])));
  }

  /**
   * Keeps each Jet's and sensor's `angle` as its world-space outward direction
   * (away from the cell it's attached to), measured from its current bonds.
   * Without a bond to measure from, it keeps its last direction.
   */
  private updateFacing(): void {
    for (let i = 0; i < this.cellCount; i++) {
      if (!this.alive[i] || !this.faces(i) || this.bondDeg[i] === 0) continue;
      const j = this.bondOther(this.cellBonds[i * BOND_SLOTS], i);
      const frame = Math.atan2(this.y[j] - this.y[i], this.x[j] - this.x[i]) - hexAngle(this.hexQ[j] - this.hexQ[i], this.hexR[j] - this.hexR[i]);
      if (this.type[i] === CellType.Tip) {
        // A tip's angle is the way it grows.
        const [dq, dr] = HEX_DIRS[this.tipDir[i]];
        this.angle[i] = frame + hexAngle(dq, dr);
        continue;
      }
      const [dq, dr] = HEX_DIRS[this.jetPush[i]];
      this.angle[i] = frame + hexAngle(dq, dr) + Math.PI;
    }
  }

  /** The cell at the other end of bond b from cell i. */
  private bondOther(b: number, i: number): number {
    return this.bondA[b] === i ? this.bondB[b] : this.bondA[b];
  }

  /**
   * Sensors face outward from the cell they're attached to (their `angle`).
   * - light, nutrient, temperature: read at SENSOR.readDistance ahead (0-1);
   * - touch: 1 if touching a living cell of another organism, else 0 (at its own position);
   * - proximity: how many living cells of other organisms (optionally of one
   *   type) are within range and within a cone ahead, normalized.
   * Change compares the level with its recent moving average: -1 falling to 1 rising.
   */
  private sense(dt: number): void {
    const { light, temperature, nutrient } = this.world;
    const tempRange = TEMPERATURE.center - TEMPERATURE.edge;
    const smooth = 1 - Math.exp(-dt / SENSOR.changeWindowSec);
    const cone = Math.cos((SENSOR.coneHalfAngle * Math.PI) / 180);
    const day = dayPhase(this.world.time);
    for (let i = 0; i < this.cellCount; i++) {
      if (!this.alive[i] || !(isSensorType(this.type[i]) || this.type[i] === CellType.Timer)) continue;
      const fx = Math.cos(this.angle[i]);
      const fy = Math.sin(this.angle[i]);
      const tile = this.tileAt(this.x[i] + fx * SENSOR.readDistance, this.y[i] + fy * SENSOR.readDistance);
      let level = 0;
      switch (this.type[i]) {
        case CellType.LightSensor:
          level = light[tile];
          break;
        case CellType.NutrientSensor:
          level = nutrient[tile] / SENSOR.nutrientFull;
          break;
        case CellType.TemperatureSensor:
          level = (temperature[tile] - TEMPERATURE.edge) / tempRange;
          break;
        case CellType.TouchSensor:
          this.contacts(i, SENSOR.touchDistance, (j) => {
            if (!this.alive[j] || this.organism[j] === this.organism[i]) return true;
            level = 1;
            return false;
          });
          break;
        case CellType.ProximitySensor: {
          let count = 0;
          const only = this.proxFilter[i];
          this.contacts(i, SENSOR.proximityRange, (j) => {
            if (only === CellType.Dead) {
              if (this.type[j] !== CellType.Dead) return;
            } else if (!this.alive[j] || this.organism[j] === this.organism[i] || (only !== 0 && this.type[j] !== only)) return;
            const dx = this.x[j] - this.x[i];
            const dy = this.y[j] - this.y[i];
            const d = Math.hypot(dx, dy) || 1;
            if ((dx * fx + dy * fy) / d >= cone) count++;
          });
          level = count / SENSOR.proximityFull;
          break;
        }
        case CellType.Timer:
          level = timerLevel(day, this.timerCycles[i], this.timerPhase[i], this.timerDuty[i]);
          break;
      }
      level = Math.min(1, Math.max(0, level));
      // A new sensor starts with no trend.
      if (this.age[i] <= 1) this.sensorAvg[i] = level;
      this.sensorAvg[i] += (level - this.sensorAvg[i]) * smooth;
      this.sensorLevel[i] = level;
      this.sensorChange[i] = Math.min(1, Math.max(-1, (level - this.sensorAvg[i]) / SENSOR.changeScale));
    }
  }

  /** Wired sources (sensors and neurons) by (organism, plan slot). Built once per tick. */
  private wiredSources(): Map<number, number> {
    if (this.sourcesCache && this.sourcesTick === this.tick) return this.sourcesCache;
    const map = (this.sourcesCache ??= new Map<number, number>());
    map.clear();
    this.sourcesTick = this.tick;
    for (let j = 0; j < this.cellCount; j++) {
      if (this.alive[j] && this.planSlot[j] >= 0 && (isSensorType(this.type[j]) || this.type[j] === CellType.Neuron || this.type[j] === CellType.Timer)) {
        map.set(this.organism[j] * 65536 + this.planSlot[j], j);
      }
    }
    return map;
  }

  /** A wire's input: a sensor's level or change, or a neuron's output (from `neuronOutputs`). */
  private wireInput(source: number, change: boolean, neuronOutputs: Float32Array): number {
    if (this.type[source] === CellType.Neuron) return neuronOutputs[source];
    return change ? this.sensorChange[source] : this.sensorLevel[source];
  }

  /**
   * Neurons: target = tanh(bias + sum of (weight × wired input) + sum of
   * (weight × internal input)); the output moves toward the target at the
   * neuron's speed. Every input uses the previous tick's neuron outputs, so
   * loops (even a neuron wired to itself) are well-defined.
   */
  private updateNeurons(dt: number): void {
    const n = this.cellCount;
    let any = false;
    for (let i = 0; i < n && !any; i++) any = this.alive[i] === 1 && this.type[i] === CellType.Neuron;
    if (!any) return;
    const prev = this.neuronPrev;
    prev.set(this.neuronOut.subarray(0, n));
    const sources = this.wiredSources();
    this.groupOrganisms();
    this.bodyReadings(dt);
    const R = this.orgSum;
    const K = NEURON_INPUT_KEYS.length;
    for (let i = 0; i < n; i++) {
      if (!this.alive[i] || this.type[i] !== CellType.Neuron) continue;
      const org = this.organism[i];
      let sum = this.neuronBias[i];
      for (const w of this.wiresOf(org).get(this.planSlot[i]) ?? []) {
        const src = sources.get(org * 65536 + w.source);
        if (src !== undefined) sum += w.weight * this.wireInput(src, w.change, prev);
      }
      // Internal inputs, in NEURON_INPUT_KEYS order: forward, sideways, turning, eaten, energy, nutrient, size, noise.
      const base = i * K;
      const o7 = org * 7;
      sum += this.neuronInputs[base] * R[o7] + this.neuronInputs[base + 1] * R[o7 + 1] + this.neuronInputs[base + 2] * R[o7 + 2];
      sum += this.neuronInputs[base + 3] * this.eatenNear(i, dt);
      sum += this.neuronInputs[base + 4] * R[o7 + 3] + this.neuronInputs[base + 5] * R[o7 + 4] + this.neuronInputs[base + 6] * R[o7 + 5];
      sum += this.neuronInputs[base + 7] * this.driftNoise(i, dt);
      const target = Math.tanh(sum);
      this.neuronOut[i] = prev[i] + (target - prev[i]) * (1 - Math.exp(-this.neuronSpeed[i] * NEURON.maxRate * dt));
    }
  }

  /** Slowly drifting random value in -1..1 for a neuron's noise input. */
  private driftNoise(i: number, dt: number): number {
    const u = Math.max(1e-9, this.rng());
    const gauss = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.rng());
    const v = this.neuronNoise[i] - NEURON_INPUTS.noisePull * this.neuronNoise[i] * dt + NEURON_INPUTS.noiseDrift * Math.sqrt(dt) * gauss;
    return (this.neuronNoise[i] = Math.min(1, Math.max(-1, v)));
  }

  /** Energy drained by Mouths and Spikes from the neuron's own cells within its range, per second, normalized. */
  private eatenNear(i: number, dt: number): number {
    const org = this.organism[i];
    const whole = this.neuronEatenRange[i] >= NEURON_INPUTS.eatenRangeMax;
    let drained = 0;
    for (let m = this.orgStart[org]; m < this.orgStart[org + 1]; m++) {
      const j = this.orgList[m];
      if (this.drainTaken[j] <= 0) continue;
      if (whole || hexDistance(this.hexQ[i], this.hexR[i], this.hexQ[j], this.hexR[j]) <= this.neuronEatenRange[i]) drained += this.drainTaken[j];
    }
    return Math.min(1, drained / dt / NEURON_INPUTS.eatenFull);
  }

  /**
   * Organism-level readings for neurons, written into orgSum (7 per organism):
   * velocity in the body frame (forward is the way its Jets push overall, or
   * +x of its layout), turning speed, stored energy and nutrient as fractions
   * of capacity, and size as a fraction of max cells. Only organisms with a
   * Neuron are measured. Needs groupOrganisms().
   */
  private bodyReadings(dt: number): void {
    const flag = this.orgFlag;
    flag.fill(0, 0, this.orgCount);
    for (let i = 0; i < this.cellCount; i++) if (this.alive[i] && this.type[i] === CellType.Neuron) flag[this.organism[i]] = 1;
    const clamp1 = (v: number) => Math.min(1, Math.max(-1, v));
    const R = this.orgSum;
    for (let o = 0; o < this.orgCount; o++) {
      if (!flag[o]) continue;
      let vx = 0;
      let vy = 0;
      let e = 0;
      let ec = 0;
      let st = 0;
      let sc = 0;
      const a = this.orgStart[o];
      const b = this.orgStart[o + 1];
      for (let m = a; m < b; m++) {
        const i = this.orgList[m];
        vx += this.vx[i];
        vy += this.vy[i];
        e += this.energy[i];
        ec += energyCap(this.type[i]);
        st += this.storedNutrient[i];
        sc += storedCap(this.type[i]);
      }
      const count = b - a;
      const g = this.genomes[this.genomeId[o]];
      const heading = this.orgAngle[o] + Math.atan2(g.forward[1], g.forward[0]);
      vx /= count;
      vy /= count;
      let turn = 0;
      if (this.orgAngleTick[o] === this.tick - 1) {
        const dA = this.orgAngle[o] - this.orgAnglePrev[o];
        turn = Math.atan2(Math.sin(dA), Math.cos(dA)) / dt;
      }
      const o7 = o * 7;
      R[o7] = clamp1((vx * Math.cos(heading) + vy * Math.sin(heading)) / NEURON_INPUTS.speedFull);
      R[o7 + 1] = clamp1((-vx * Math.sin(heading) + vy * Math.cos(heading)) / NEURON_INPUTS.speedFull);
      R[o7 + 2] = clamp1(turn / NEURON_INPUTS.turnFull);
      R[o7 + 3] = e / ec;
      R[o7 + 4] = sc > 0 ? st / sc : 0;
      R[o7 + 5] = Math.min(1, count / g.maxCells);
    }
  }

  /**
   * Jets fire constantly at their strength while they have the energy, pushing
   * their organism toward the cell they're attached to (exhaust points away,
   * along their `angle`). Strength = base + sum of (weight × wired input from
   * sensors and neurons), clamped to 0-1. A Jet whose exhaust hex holds a cell
   * of its own organism is blocked: no thrust, no energy spent.
   */
  private fireJets(dt: number): void {
    const n = this.cellCount;
    let sources: Map<number, number> | null = null;
    // Hex spots occupied by living cells of organisms that have Jets.
    let occupied: Set<number> | null = null;
    const spot = (org: number, q: number, r: number) => org * 4194304 + hexKey(q, r);
    this.firing.fill(0, 0, n);
    for (let i = 0; i < n; i++) {
      if (!this.alive[i] || this.type[i] !== CellType.Jet || this.jetPush[i] < 0) continue;
      if (!occupied) {
        occupied = new Set();
        const flag = this.orgFlag;
        flag.fill(0, 0, this.orgCount);
        for (let j = 0; j < n; j++) if (this.alive[j] && this.type[j] === CellType.Jet) flag[this.organism[j]] = 1;
        for (let j = 0; j < n; j++) if (this.alive[j] && flag[this.organism[j]]) occupied.add(spot(this.organism[j], this.hexQ[j], this.hexR[j]));
      }
      const [pq, pr] = HEX_DIRS[this.jetPush[i]];
      if (occupied.has(spot(this.organism[i], this.hexQ[i] - pq, this.hexR[i] - pr))) continue;
      let strength = this.jetStrength[i];
      const wires = this.wiresOf(this.organism[i]).get(this.planSlot[i]);
      if (wires) {
        sources ??= this.wiredSources();
        for (const w of wires) {
          const src = sources.get(this.organism[i] * 65536 + w.source);
          if (src !== undefined) strength += w.weight * this.wireInput(src, w.change, this.neuronOut);
        }
        strength = Math.min(1, Math.max(0, strength));
      }
      const cost = JET.energyPerSecond * strength * dt;
      if (strength < JET.minStrength || this.energy[i] <= cost) continue;
      this.energy[i] -= cost;
      const push = this.angle[i] + Math.PI;
      this.vx[i] += Math.cos(push) * JET.thrust * strength * dt;
      this.vy[i] += Math.sin(push) * JET.thrust * strength * dt;
      this.firing[i] = 1;
    }
  }

  /** Growth tips: each signal = its base + sum of (weight × wired input) on that channel, clamped to -1..1. */
  private updateTips(): void {
    let sources: Map<number, number> | null = null;
    for (let i = 0; i < this.cellCount; i++) {
      if (!this.alive[i] || this.type[i] !== CellType.Tip) continue;
      const sig = [this.tipBase[i * 3], this.tipBase[i * 3 + 1], this.tipBase[i * 3 + 2]];
      const wires = this.planSlot[i] >= 0 ? this.wiresOf(this.organism[i]).get(this.planSlot[i]) : undefined;
      if (wires) {
        sources ??= this.wiredSources();
        for (const w of wires) {
          const src = sources.get(this.organism[i] * 65536 + w.source);
          if (src !== undefined) sig[w.channel] += w.weight * this.wireInput(src, w.change, this.neuronOut);
        }
      }
      for (let c = 0; c < 3; c++) this.tipSignal[i * 3 + c] = Math.min(1, Math.max(-1, sig[c]));
    }
  }

  /** Living cell-to-cell wires (source, target, weight), for drawing. */
  wireList(): Float32Array {
    const out: number[] = [];
    const sources = this.wiredSources();
    for (let i = 0; i < this.cellCount; i++) {
      if (!this.alive[i] || this.planSlot[i] < 0) continue;
      const wires = this.wiresOf(this.organism[i]).get(this.planSlot[i]);
      for (const w of wires ?? []) {
        const src = sources.get(this.organism[i] * 65536 + w.source);
        if (src !== undefined) out.push(src, i, w.weight);
      }
    }
    return Float32Array.from(out);
  }

  private killStarved(): void {
    for (let i = 0; i < this.cellCount; i++) {
      if (this.alive[i] && this.energy[i] <= 0) this.kill(i);
    }
  }

  /** Living cell becomes Dead: its bonds break, it leaves its organism and keeps its nutrient. */
  private kill(i: number): void {
    // Starved, unless a Spike drained it just before: then that Spike's lineage gets the credit.
    const spiked = this.tick - this.spikedAt[i] <= LINEAGE.spikeKillCreditSec * SIM.tickHz;
    this.lineages.recordDeath(this.cellLineage[i], spiked ? this.spikedBy[i] : -1, this.tick);
    // Detach while it still has its living type, so the organism remembers what to regrow there.
    this.detach(i);
    this.alive[i] = 0;
    this.type[i] = CellType.Dead;
    this.energy[i] = 0;
    this.emit(CellEvent.Died, i);
  }

  /** Breaks all of a cell's bonds and removes it from its organism. */
  private detach(i: number): void {
    while (this.bondDeg[i] > 0) this.freeBond(this.cellBonds[i * BOND_SLOTS]);
    const org = this.organism[i];
    this.organism[i] = -1;
    this.orgCells[org]--;
    if (this.orgCells[org] === 0) {
      this.freeOrg(org);
      this.dirtyOrgs.delete(org);
    } else {
      this.dirtyOrgs.add(org);
      this.rememberLost(org, i);
    }
  }

  /** Remembers a lost cell's spot and type so the organism can regrow it. */
  private rememberLost(org: number, i: number): void {
    let list = this.lost.get(org);
    if (!list) this.lost.set(org, (list = []));
    list.push({
      q: this.hexQ[i],
      r: this.hexR[i],
      kind: TYPE_STYLE[this.type[i]] as CellKind,
      strength: this.jetStrength[i],
      push: this.jetPush[i],
      index: this.planSlot[i] >= 0 ? this.planSlot[i] : undefined,
      filter: this.proxFilter[i] ? (TYPE_STYLE[this.proxFilter[i]] as ProximityFilter) : undefined,
      ...(this.type[i] === CellType.Timer ? { cycles: this.timerCycles[i], phase: this.timerPhase[i], duty: this.timerDuty[i] } : {}),
      ...(this.type[i] === CellType.Tip ? this.tipSettings(i) : {}),
      ...(this.type[i] === CellType.Neuron
        ? {
            bias: this.neuronBias[i],
            speed: this.neuronSpeed[i],
            inputs: Object.fromEntries(NEURON_INPUT_KEYS.map((k, n) => [k, this.neuronInputs[i * NEURON_INPUT_KEYS.length + n]])),
            eatenRange: this.neuronEatenRange[i],
          }
        : {}),
    });
    if (list.length > GROWTH.lostMemory) list.shift();
  }

  // ------------------------------------------------------------- feeding

  /**
   * Contact rules, using the spatial grid. None of them touch the cell's own organism.
   * - Mouth drains energy at a fixed rate from every living cell it touches
   *   (any type, including other Mouths), keeping only a fraction. Prey
   *   drained to zero is eaten: its nutrient goes into the Mouth's store and
   *   it is removed.
   * - Spike drains energy from every living cell it touches and gains nothing.
   * - Decomposer takes nutrient from Dead cells it touches into its store (up
   *   to its cap), gaining a little energy per unit; a Dead cell with no
   *   nutrient left is removed. It ignores living cells.
   */
  private feed(dt: number): void {
    const n = this.cellCount;
    this.drained.fill(0, 0, n);
    this.drainTaken.fill(0, 0, n);
    this.buildHash();
    for (let i = 0; i < n; i++) {
      if (!this.alive[i]) continue;
      const t = this.type[i];
      if (t === CellType.Mouth) this.contacts(i, MOUTH.touchDistance, (j) => this.mouthBite(i, j, dt));
      else if (t === CellType.Decomposer) this.contacts(i, DECOMPOSER.touchDistance, (j) => this.decompose(i, j, dt));
    }
  }

  /** Calls `visit` for every other cell within `touch` cell radii of cell i. Stops early if `visit` returns false. */
  private contacts(i: number, touch: number, visit: (j: number) => boolean | void): void {
    const reach2 = (CELL.radius * touch) ** 2;
    const k = Math.ceil((CELL.radius * touch) / this.bucket);
    const [bx, by] = this.bucketOf(this.x[i], this.y[i]);
    for (let oy = -k; oy <= k; oy++) {
      const ry = by + oy;
      if (ry < 0 || ry >= this.hashRows) continue;
      for (let ox = -k; ox <= k; ox++) {
        const rx = bx + ox;
        if (rx < 0 || rx >= this.hashCols) continue;
        for (let j = this.hashHead[ry * this.hashCols + rx]; j >= 0; j = this.hashNext[j]) {
          if (j === i || this.type[j] === CellType.None) continue;
          if ((this.x[j] - this.x[i]) ** 2 + (this.y[j] - this.y[i]) ** 2 > reach2) continue;
          if (visit(j) === false) return;
        }
      }
    }
  }

  private mouthBite(i: number, j: number, dt: number): boolean {
    if (!this.alive[i]) return false;
    if (!this.alive[j] || this.organism[j] === this.organism[i]) return true;
    if (this.type[j] === CellType.Spike) {
      // Biting a Spike hurts: the Mouth loses more than it gains. A Mouth that
      // starves soon after counts as killed by the Spike's lineage.
      const hurt = SPIKE.retaliation * dt;
      this.energy[i] -= hurt;
      this.drainTaken[i] += hurt;
      this.drained[i] = 1;
      this.spikedBy[i] = this.cellLineage[j];
      this.spikedAt[i] = this.tick;
    }
    const rate = MOUTH.drainRate * (this.type[j] === CellType.Shell ? SHELL.mouthDrainFactor : 1);
    const take = Math.max(0, Math.min(this.energy[j], rate * dt));
    this.energy[j] -= take;
    this.drainTaken[j] += take;
    this.energy[i] = Math.min(energyCap(this.type[i]), this.energy[i] + take * MOUTH.efficiency);
    this.lineages.creditPrey(this.cellLineage[i], this.cellLineage[j], take * MOUTH.efficiency);
    this.drained[j] = 1;
    if (this.energy[j] <= 0) this.eat(i, j);
    return true;
  }

  private decompose(i: number, j: number, dt: number): void {
    if (this.type[j] !== CellType.Dead) return;
    const amount = DECOMPOSER.eatRate * dt;
    let units = Math.floor(amount) + (this.rng() < amount % 1 ? 1 : 0);
    // Always eats while touching; anything over its store cap goes into the water (like a Mouth).
    units = Math.min(units, this.bodyNutrient[j] + this.storedNutrient[j]);
    if (units > 0) {
      const fromStore = Math.min(units, this.storedNutrient[j]);
      this.storedNutrient[j] -= fromStore;
      this.bodyNutrient[j] -= units - fromStore;
      this.storedNutrient[i] += units;
      this.energy[i] = Math.min(energyCap(this.type[i]), this.energy[i] + units * DECOMPOSER.energyPerNutrient);
      // Dead cells keep their lineage: the Decomposer counts as eating it.
      this.lineages.creditPrey(this.cellLineage[i], this.cellLineage[j], units * DECOMPOSER.energyPerNutrient);
      this.drained[j] = 1;
      this.releaseExcess(i);
    }
    if (this.bodyNutrient[j] + this.storedNutrient[j] === 0) this.freeCell(j);
  }

  /** The Mouth takes all of the prey's nutrient into its store; the prey is removed, not left Dead. */
  private eat(mouth: number, prey: number): void {
    this.lineages.recordDeath(this.cellLineage[prey], this.cellLineage[mouth], this.tick);
    this.storedNutrient[mouth] += this.bodyNutrient[prey] + this.storedNutrient[prey];
    this.bodyNutrient[prey] = 0;
    this.storedNutrient[prey] = 0;
    this.detach(prey);
    this.freeCell(prey);
    this.releaseExcess(mouth);
  }

  /** Stored nutrient above the cap goes into the water at the cell's position. */
  private releaseExcess(i: number): void {
    const excess = this.storedNutrient[i] - storedCap(this.type[i]);
    if (excess <= 0) return;
    this.storedNutrient[i] -= excess;
    this.world.nutrient[this.tileAt(this.x[i], this.y[i])] += excess;
  }

  // ------------------------------------------------------------- organisms

  /** Each disconnected piece of an organism becomes its own organism with the same genome. */
  private resolveSplits(): void {
    if (this.dirtyOrgs.size > 0) {
      const members = new Map<number, number[]>();
      for (const org of this.dirtyOrgs) if (this.orgCells[org] > 0) members.set(org, []);
      if (members.size > 0) {
        for (let i = 0; i < this.cellCount; i++) if (this.organism[i] >= 0) members.get(this.organism[i])?.push(i);
        for (const [org, cells] of members) this.splitComponents(org, cells, this.reproducing.has(org));
      }
    }
    this.dirtyOrgs.clear();
    this.reproducing.clear();
  }

  /**
   * Gives each piece beyond the largest its own organism. When the split is
   * reproduction (Split/Fragment), those pieces are offspring: the next
   * generation, with a possibly mutated copy of the genome. Pieces left by a
   * death keep the genome unchanged.
   */
  private splitComponents(org: number, members: number[], offspring = false): void {
    // Connected pieces over the bond graph (breadth-first from each unlabeled cell).
    const stamp = ++this.splitStamp;
    const groups: number[][] = [];
    for (const start of members) {
      if (this.compStamp[start] === stamp) continue;
      this.compStamp[start] = stamp;
      const piece = [start];
      for (let h = 0; h < piece.length; h++) {
        const c = piece[h];
        for (let k = 0; k < this.bondDeg[c]; k++) {
          const nb = this.bondOther(this.cellBonds[c * BOND_SLOTS + k], c);
          if (this.organism[nb] !== org || this.compStamp[nb] === stamp) continue;
          this.compStamp[nb] = stamp;
          piece.push(nb);
        }
      }
      groups.push(piece);
    }
    if (groups.length <= 1) return;
    const parts = groups.sort((p, q) => q.length - p.length);
    for (let p = 1; p < parts.length; p++) {
      const child = this.allocOrg();
      if (child < 0) return;
      this.owner[child] = this.owner[org];
      this.lineage[child] = this.lineage[org];
      this.inherit(org, child, offspring);
      const cg = this.genomes[this.genomeId[child]];
      this.orgSegments[child] = Math.min(this.orgSegments[org], cg.worm?.maxSegments ?? 1);
      // Pieces that came apart keep the memory of lost spots near them.
      if (!offspring && this.lost.has(org)) this.lost.set(child, this.lost.get(org)!.map((l) => ({ ...l })));
      for (const i of parts[p]) this.organism[i] = child;
      this.orgCells[child] = parts[p].length;
      this.orgCells[org] -= parts[p].length;
      if (offspring) this.launch(org, parts[0], parts[p]);
    }
  }

  /**
   * Gives a new organism its parent's genome. Offspring get a copy with a
   * chance of mutations, one more generation, and the parent's mutation count
   * plus any new ones. Same lineage and owner either way (set by the caller).
   */
  private inherit(parent: number, child: number, offspring: boolean): void {
    this.generation[child] = this.generation[parent] + (offspring ? 1 : 0);
    this.mutations[child] = this.mutations[parent];
    this.genomeId[child] = this.genomeId[parent];
    if (!offspring) return;
    const { design, count } = mutate(this.genomes[this.genomeId[parent]].design, this.rng);
    if (count > 0) {
      this.genomeId[child] = this.registerGenome(design);
      this.mutations[child] += count;
    }
  }

  /** Launch: pushes a split-off piece away from the parent piece's center, at the design's launch strength. */
  private launch(org: number, parent: number[], piece: number[]): void {
    const speed = (this.genomes[this.genomeId[org]].design.launch ?? 0) * GROWTH.launchSpeed;
    if (speed <= 0) return;
    const center = (cells: number[]) => [
      cells.reduce((s, i) => s + this.x[i], 0) / cells.length,
      cells.reduce((s, i) => s + this.y[i], 0) / cells.length,
    ];
    const [ax, ay] = center(parent);
    const [bx, by] = center(piece);
    const len = Math.hypot(bx - ax, by - ay) || 1;
    for (const i of piece) {
      this.vx[i] += ((bx - ax) / len) * speed;
      this.vy[i] += ((by - ay) / len) * speed;
    }
  }

  /** Groups living cells by organism (counting sort) into orgStart / orgList. */
  private groupOrganisms(): void {
    const start = this.orgStart;
    const n = this.orgCount;
    start.fill(0, 0, n + 1);
    for (let i = 0; i < this.cellCount; i++) if (this.alive[i] && this.organism[i] >= 0) start[this.organism[i] + 1]++;
    for (let o = 0; o < n; o++) start[o + 1] += start[o];
    const fill = this.orgFill;
    fill.set(start.subarray(0, n));
    for (let i = 0; i < this.cellCount; i++) if (this.alive[i] && this.organism[i] >= 0) this.orgList[fill[this.organism[i]]++] = i;
  }

  /**
   * Organisms below their max size try to add one cell; at max size they
   * reproduce when they have enough stored energy and nutrient.
   */
  private growAndReproduce(): void {
    this.groupOrganisms();
    const start = this.orgStart;
    const list = this.orgList;
    const orgs = this.orgCount;
    for (let o = 0; o < orgs; o++) {
      const count = start[o + 1] - start[o];
      if (count === 0 || this.orgCells[o] !== count) continue;
      const cells = Array.from(list.subarray(start[o], start[o + 1]));
      const g = this.genomes[this.genomeId[o]];
      const occ = new Map<number, number>();
      for (const i of cells) occ.set(hexKey(this.hexQ[i], this.hexR[i]), i);
      if (count < g.maxCells) this.grow(o, g, cells, occ);
      else this.reproduce(o, g, cells, occ);
    }
    this.resolveSplits();
  }

  /** Energy a cell can give toward growth: all but what it keeps to live on (Fat keeps its reserve). */
  private spareEnergy(i: number): number {
    const keep = this.type[i] === CellType.Fat ? Math.max(FAT.reserve, GROWTH.keepEnergy) : GROWTH.keepEnergy;
    return Math.max(0, this.energy[i] - keep);
  }

  /** Whether the organism's cells together can pay this much energy and stored nutrient. */
  private poolCanPay(cells: number[], energy: number, nutrient: number): boolean {
    let e = 0;
    let n = 0;
    for (const c of cells) {
      e += this.spareEnergy(c);
      n += this.storedNutrient[c];
    }
    return e >= energy && n >= nutrient;
  }

  /**
   * Takes energy and stored nutrient from the organism's cells: `first` pays
   * first, then the cells with the most to spare. Nutrient moves in whole
   * units. Call poolCanPay first.
   */
  private poolPay(cells: number[], first: number, energy: number, nutrient: number): void {
    if (energy > 0) {
      const order = cells.filter((c) => c !== first).sort((a, b) => this.spareEnergy(b) - this.spareEnergy(a));
      for (const c of [first, ...order]) {
        const take = Math.min(energy, this.spareEnergy(c));
        this.energy[c] -= take;
        if ((energy -= take) <= 1e-9) break;
      }
    }
    if (nutrient > 0) {
      const order = cells.filter((c) => c !== first).sort((a, b) => this.storedNutrient[b] - this.storedNutrient[a]);
      for (const c of [first, ...order]) {
        const take = Math.min(nutrient, this.storedNutrient[c]);
        this.storedNutrient[c] -= take;
        if ((nutrient -= take) === 0) break;
      }
    }
  }

  /** Orientation of the organism's hex frame at cell i, measured from a neighbor when possible. */
  private frameAngle(i: number, occ: Map<number, number>): number {
    for (const [dq, dr] of HEX_DIRS) {
      const n = occ.get(hexKey(this.hexQ[i] + dq, this.hexR[i] + dr));
      if (n === undefined) continue;
      const [lx, ly] = hexToLocal(dq, dr);
      return Math.atan2(this.y[n] - this.y[i], this.x[n] - this.x[i]) - Math.atan2(ly, lx);
    }
    if (this.jetPush[i] >= 0) {
      const [px, py] = hexToLocal(...HEX_DIRS[this.jetPush[i]]);
      return this.angle[i] - Math.PI - Math.atan2(py, px);
    }
    return this.angle[i];
  }

  /** World position of hex (q, r) placed next to cell `from`. */
  private placeNear(from: number, q: number, r: number, frame: number): [number, number] {
    const [lx, ly] = hexToLocal(q - this.hexQ[from], r - this.hexR[from]);
    const d = 2 * CELL.radius;
    const c = Math.cos(frame);
    const s = Math.sin(frame);
    return [this.x[from] + (lx * c - ly * s) * d, this.y[from] + (lx * s + ly * c) * d];
  }

  private spotFree(px: number, py: number): boolean {
    const r = CELL.radius;
    if (px < r || py < r || px > this.worldWidth - r || py > this.worldHeight - r) return false;
    const min2 = (1.2 * r) ** 2;
    const [bx, by] = this.bucketOf(px, py);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const rx = bx + ox;
        const ry = by + oy;
        if (rx < 0 || ry < 0 || rx >= this.hashCols || ry >= this.hashRows) continue;
        for (let j = this.hashHead[ry * this.hashCols + rx]; j >= 0; j = this.hashNext[j]) {
          if (this.type[j] !== CellType.None && (this.x[j] - px) ** 2 + (this.y[j] - py) ** 2 < min2) return false;
        }
      }
    }
    return true;
  }

  /**
   * Adds one cell (or a Worm segment). Order: free plan slots touching the
   * body (the earliest, or with growth tips the one nearest an active tip),
   * then lost spots, then a Worm's next segment or a Blob's tips and random
   * edge spots. With growth tips, nothing grows while every tip is inactive.
   */
  private grow(o: number, g: Genome, cells: number[], occ: Map<number, number>): void {
    const tips = cells.filter((i) => this.type[i] === CellType.Tip);
    const active = tips.filter((i) => this.tipSignal[i * 3] > TIP.growThreshold);
    if (tips.length > 0 && active.length === 0) return;
    let slot: DesignCell | null = null;
    let parents: number[] = [];
    let best = Infinity;
    for (const s of this.planOf(o)) {
      if (occ.has(hexKey(s.q, s.r))) continue;
      const adj = this.adjacent(s.q, s.r, occ);
      if (!adj.length) continue;
      // Without tips the earliest slot wins; with tips, the one nearest an active tip.
      let score = 0;
      if (active.length) {
        score = Infinity;
        for (const t of active) score = Math.min(score, hexDistance(s.q, s.r, this.hexQ[t], this.hexR[t]));
      }
      if (score < best) {
        best = score;
        slot = s;
        parents = adj;
        if (!active.length) break;
      }
    }
    // Then spots it lost (eaten or died), newest first, as they were.
    if (!slot) {
      const list = this.lost.get(o);
      for (let k = (list?.length ?? 0) - 1; k >= 0 && !slot; k--) {
        const s = list![k];
        if (occ.has(hexKey(s.q, s.r))) {
          list!.splice(k, 1);
          continue;
        }
        parents = this.adjacent(s.q, s.r, occ);
        if (parents.length) slot = s;
      }
    }
    if (!slot && g.worm) {
      this.insertSegment(o, g, cells, occ);
      return;
    }
    if (!slot && g.design.growth === 'blob') {
      if (active.length) {
        if (this.advanceTips(o, g, cells, occ, active)) {
          this.orgTipStuck[o] = 0;
          return;
        }
        // Every active tip is blocked: after a while, grow one random edge cell instead.
        if (++this.orgTipStuck[o] < TIP.stuckChecks) return;
        this.orgTipStuck[o] = 0;
      }
      // Random free spots on its edge, with types from the cell mix.
      for (let attempt = 0; attempt < 6 && !slot; attempt++) {
        const c = cells[Math.floor(this.rng() * cells.length)];
        const [dq, dr] = HEX_DIRS[Math.floor(this.rng() * 6)];
        const q = this.hexQ[c] + dq;
        const r = this.hexR[c] + dr;
        if (occ.has(hexKey(q, r))) continue;
        // Attached to the cell it grows from: a Jet here pushes toward it.
        const push = HEX_DIRS.findIndex(([a, b]) => a === -dq && b === -dr);
        slot = { q, r, kind: this.pickBlobKind(g), push, strength: blobJetStrength(g.design) };
        parents = [c, ...this.adjacent(q, r, occ).filter((p) => p !== c)];
      }
    }
    if (!slot || !this.poolCanPay(cells, g.design.growEnergy, g.design.growNutrient)) return;
    const parent = parents[0];
    const frame = this.frameAngle(parent, occ);
    const [px, py] = this.placeNear(parent, slot.q, slot.r, frame);
    if (!this.spotFree(px, py)) return;
    const id = this.addCell(cells, parent, g, slot, px, py, frame, o);
    if (id < 0) return;
    // Bond to every neighbor in the layout: filled shapes hold, chains flex.
    for (const n of this.adjacent(slot.q, slot.r, occ)) this.addBond(n, id, 2 * CELL.radius);
    occ.set(hexKey(slot.q, slot.r), id);
    cells.push(id);
    const list = this.lost.get(o);
    if (list) this.lost.set(o, list.filter((l) => l.q !== slot!.q || l.r !== slot!.r));
  }

  /** A tip's settings as a design cell (for regrowing it, or for a tip it branches off). */
  private tipSettings(i: number): Partial<DesignCell> {
    const deposit: CellKind[] = [];
    for (let n = 0; n < this.tipDepositLen[i]; n++) deposit.push(TYPE_STYLE[this.tipDeposit[i * TIP.maxDeposit + n]] as CellKind);
    return { deposit, grow: this.tipBase[i * 3], turn: this.tipBase[i * 3 + 1], branch: this.tipBase[i * 3 + 2] };
  }

  /**
   * Blob growth through tips: the next active tip (round-robin) turns if its
   * Turn signal says so, grows the spot it faces and moves onto it, leaving the
   * next cell type of its deposit cycle behind. With a strong Branch signal it
   * also starts a new tip at its side. False if every active tip is blocked.
   */
  private advanceTips(o: number, g: Genome, cells: number[], occ: Map<number, number>, active: number[]): boolean {
    const start = this.orgTipTurn[o] % active.length;
    for (let k = 0; k < active.length; k++) {
      const tip = active[(start + k) % active.length];
      if (this.advanceTip(o, g, cells, occ, tip)) {
        this.orgTipTurn[o] = (start + k + 1) % active.length;
        return true;
      }
    }
    return false;
  }

  private advanceTip(o: number, g: Genome, cells: number[], occ: Map<number, number>, tip: number): boolean {
    const { growEnergy, growNutrient } = g.design;
    if (cells.length >= g.maxCells || !this.poolCanPay(cells, growEnergy, growNutrient)) return false;
    const turn = this.tipSignal[tip * 3 + 1];
    // HEX_DIRS run counterclockwise on screen, so +1 turns left and +5 (−1) turns right.
    if (turn > TIP.turnThreshold) this.tipDir[tip] = (this.tipDir[tip] + 5) % 6;
    else if (turn < -TIP.turnThreshold) this.tipDir[tip] = (this.tipDir[tip] + 1) % 6;
    const dir = this.tipDir[tip];
    const oq = this.hexQ[tip];
    const or = this.hexR[tip];
    const fq = oq + HEX_DIRS[dir][0];
    const fr = or + HEX_DIRS[dir][1];
    if (occ.has(hexKey(fq, fr))) return false;
    const frame = this.frameAngle(tip, occ);
    const [fx, fy] = this.placeNear(tip, fq, fr, frame);
    if (!this.spotFree(fx, fy)) return false;
    const ox = this.x[tip];
    const oy = this.y[tip];
    // Move the tip forward (its bonds are rebuilt below; nothing is lost).
    while (this.bondDeg[tip] > 0) this.freeBond(this.cellBonds[tip * BOND_SLOTS]);
    occ.delete(hexKey(oq, or));
    this.setHex(tip, fq, fr);
    this.x[tip] = fx;
    this.y[tip] = fy;
    occ.set(hexKey(fq, fr), tip);
    // Leave the next deposit type behind, attached to the body behind it.
    const len = Math.max(1, this.tipDepositLen[tip]);
    const kind = TYPE_STYLE[this.tipDeposit[tip * TIP.maxDeposit + (this.tipCounter[tip] % len)] || CellType.Leaf] as CellKind;
    this.tipCounter[tip]++;
    const left: DesignCell = { q: oq, r: or, kind, push: (dir + 3) % 6, strength: blobJetStrength(g.design) };
    const id = this.addCell(cells, tip, g, left, ox, oy, frame, o);
    if (id >= 0) {
      for (const n of this.adjacent(oq, or, occ)) this.addBond(n, id, 2 * CELL.radius);
      occ.set(hexKey(oq, or), id);
      cells.push(id);
    }
    for (const n of this.adjacent(fq, fr, occ)) if (n !== id) this.addBond(n, tip, 2 * CELL.radius);
    // If anything failed to attach, the split check sorts out the pieces.
    this.dirtyOrgs.add(o);
    // Branch: a new tip beside the cell just left behind, facing out to that side (alternating sides).
    this.tipSinceBranch[tip]++;
    if (
      id >= 0 &&
      this.tipSignal[tip * 3 + 2] > TIP.branchThreshold &&
      this.tipSinceBranch[tip] >= TIP.branchCooldown &&
      cells.length < g.maxCells &&
      this.poolCanPay(cells, growEnergy, growNutrient)
    ) {
      const side = (dir + (this.tipCounter[tip] % 2 ? 1 : 5)) % 6;
      const bq = oq + HEX_DIRS[side][0];
      const br = or + HEX_DIRS[side][1];
      const [bx, by] = this.placeNear(id, bq, br, frame);
      if (!occ.has(hexKey(bq, br)) && this.spotFree(bx, by)) {
        const branch: DesignCell = { q: bq, r: br, kind: 'tip', ...this.tipSettings(tip), index: this.planSlot[tip] >= 0 ? this.planSlot[tip] : undefined };
        const b = this.addCell(cells, id, g, branch, bx, by, frame, o);
        if (b >= 0) {
          this.tipDir[b] = side;
          for (const n of this.adjacent(bq, br, occ)) this.addBond(n, b, 2 * CELL.radius);
          occ.set(hexKey(bq, br), b);
          cells.push(b);
          this.tipSinceBranch[tip] = 0;
        }
      }
    }
    return true;
  }

  /**
   * Worm: once its body is complete, adds a whole segment between the last
   * segment and the tail in one step. The tail moves back by one segment
   * (layout and position), its bonds to the body are rebuilt, and the new
   * segment's cells fill the gap. Paid from the whole organism.
   */
  private insertSegment(o: number, g: Genome, cells: number[], occ: Map<number, number>): void {
    const worm = g.worm!;
    const k = this.orgSegments[o];
    if (k >= worm.maxSegments) return;
    const { growEnergy, growNutrient } = g.design;
    const size = worm.segmentSize;
    if (cells.length + size > g.maxCells || !this.poolCanPay(cells, growEnergy * size, growNutrient * size)) return;
    const next = worm.plans[k + 1];
    const current = new Set(this.planOf(o).map((c) => c.index));
    const tail = cells.filter((i) => worm.tail.has(this.planSlot[i]));
    const anchor = cells.find((i) => !worm.tail.has(this.planSlot[i]));
    if (anchor === undefined) return;
    const frame = this.frameAngle(anchor, occ);
    // Move the tail to its spot in the longer body.
    for (const i of tail) {
      while (this.bondDeg[i] > 0) this.freeBond(this.cellBonds[i * BOND_SLOTS]);
      occ.delete(hexKey(this.hexQ[i], this.hexR[i]));
    }
    const bySlot = new Map(next.map((c) => [c.index, c]));
    for (const i of tail) {
      const spot = bySlot.get(this.planSlot[i]);
      if (!spot) continue;
      const [px, py] = this.placeNear(anchor, spot.q, spot.r, frame);
      this.setHex(i, spot.q, spot.r);
      this.x[i] = px;
      this.y[i] = py;
    }
    for (const i of tail) occ.set(hexKey(this.hexQ[i], this.hexR[i]), i);
    this.orgSegments[o] = k + 1;
    // The new segment's cells.
    for (const spot of next) {
      if (current.has(spot.index) || occ.has(hexKey(spot.q, spot.r))) continue;
      const [px, py] = this.placeNear(anchor, spot.q, spot.r, frame);
      const id = this.addCell(cells, anchor, g, spot, px, py, frame, o);
      if (id < 0) break;
      occ.set(hexKey(spot.q, spot.r), id);
      cells.push(id);
      for (const n of this.adjacent(spot.q, spot.r, occ)) if (n !== id) this.addBond(n, id, 2 * CELL.radius);
    }
    this.dirtyOrgs.add(o);
    // Rebond the tail to whatever now neighbors it.
    for (const i of tail) {
      for (const n of this.adjacent(this.hexQ[i], this.hexR[i], occ)) {
        if (n === i || this.bonded(i, n)) continue;
        this.addBond(n, i, 2 * CELL.radius);
      }
    }
  }

  /** Whether two cells share a bond. */
  private bonded(a: number, b: number): boolean {
    for (let k = 0; k < this.bondDeg[a]; k++) if (this.bondOther(this.cellBonds[a * BOND_SLOTS + k], a) === b) return true;
    return false;
  }

  /** A cell kind for Blob growth, in proportion to the kinds in the body. */
  private pickBlobKind(g: Genome): CellKind {
    const mix = bodyMix(g.design);
    let roll = this.rng() * CELL_KINDS.reduce((sum, k) => sum + mix[k], 0);
    for (const k of CELL_KINDS) {
      roll -= mix[k];
      if (roll < 0) return k;
    }
    return g.design.cells[0].kind;
  }

  private adjacent(q: number, r: number, occ: Map<number, number>): number[] {
    const out: number[] = [];
    for (const [dq, dr] of HEX_DIRS) {
      const n = occ.get(hexKey(q + dq, r + dr));
      if (n !== undefined) out.push(n);
    }
    return out;
  }

  /**
   * Spends the organism's stored energy and nutrient on a new cell (`parent`
   * pays first, then the rest of `payers`). The nutrient becomes the new body
   * (surplus goes to its store); part of the energy is lost and the rest
   * becomes the new cell's energy.
   */
  private addCell(payers: number[], parent: number, g: Genome, slot: DesignCell, px: number, py: number, frame: number, org: number): number {
    const id = this.allocCell();
    if (id < 0) return -1;
    const { growEnergy, growNutrient } = g.design;
    this.poolPay(payers, parent, growEnergy, growNutrient);
    if (this.organism[parent] === org) this.orgCells[org]++;
    const stored = growNutrient - CELL.bodyNutrient;
    this.initCell(id, slot, px, py, frame, growEnergy * (1 - GROWTH.energyLoss), org, stored);
    return id;
  }

  private reproduce(o: number, g: Genome, cells: number[], occ: Map<number, number>): void {
    let energy = 0;
    let stored = 0;
    for (const i of cells) {
      energy += this.energy[i];
      stored += this.storedNutrient[i];
    }
    if (energy < g.design.growEnergy || stored < g.design.growNutrient) return;
    const type = g.design.reproduction;
    if (type === 'bud') this.bud(o, g, cells, occ);
    else this.partition(o, cells, type === 'split' ? 2 : DESIGN.fragmentPieces);
  }

  /** Bud: a cell that can pay releases one unbonded starter cell that grows the full design from scratch. */
  private bud(o: number, g: Genome, cells: number[], occ: Map<number, number>): void {
    if (!this.poolCanPay(cells, g.design.growEnergy, g.design.growNutrient)) return;
    // Bud from a random cell with a free spot next to it.
    const startAt = Math.floor(this.rng() * cells.length);
    for (let c = 0; c < cells.length; c++) {
      const source = cells[(startAt + c) % cells.length];
      if (this.budFrom(o, g, cells, occ, source)) return;
    }
  }

  /** Tries to bud from one cell; true if a bud was released. */
  private budFrom(o: number, g: Genome, cells: number[], occ: Map<number, number>, source: number): boolean {
    const frame = this.frameAngle(source, occ);
    const offset = Math.floor(this.rng() * 6);
    for (let k = 0; k < 6; k++) {
      const [dq, dr] = HEX_DIRS[(offset + k) % 6];
      const q = this.hexQ[source] + dq;
      const r = this.hexR[source] + dr;
      if (occ.has(hexKey(q, r))) continue;
      const [px, py] = this.placeNear(source, q, r, frame);
      if (!this.spotFree(px, py)) continue;
      const child = this.allocOrg();
      if (child < 0) return true;
      this.owner[child] = this.owner[o];
      this.lineage[child] = this.lineage[o];
      this.inherit(o, child, true);
      this.orgCells[child] = 1;
      this.orgSegments[child] = 1;
      // The bud grows its own (possibly mutated) design from that design's starter.
      const starter = this.genomes[this.genomeId[child]].plan[0];
      const id = this.addCell(cells, source, g, starter, px, py, this.rng() * Math.PI * 2, child);
      if (id < 0) {
        this.freeOrg(child);
        return true;
      }
      this.provision(cells, source, id);
      // Launch: shoot the bud away from the cell it budded from.
      const speed = (g.design.launch ?? 0) * GROWTH.launchSpeed;
      if (speed > 0) {
        const len = Math.hypot(px - this.x[source], py - this.y[source]) || 1;
        this.vx[id] = ((px - this.x[source]) / len) * speed;
        this.vy[id] = ((py - this.y[source]) / len) * speed;
      }
      return true;
    }
    return false;
  }

  /** A new bud also gets a share of the parent organism's spare energy and stored nutrient, up to its caps. */
  private provision(cells: number[], source: number, bud: number): void {
    let spareE = 0;
    let stored = 0;
    for (const c of cells) {
      spareE += this.spareEnergy(c);
      stored += this.storedNutrient[c];
    }
    const e = Math.min(spareE * GROWTH.budShare, energyCap(this.type[bud]) - this.energy[bud]);
    const n = Math.min(Math.floor(stored * GROWTH.budShare), storedCap(this.type[bud]) - this.storedNutrient[bud]);
    this.poolPay(cells, source, Math.max(0, e), Math.max(0, n));
    this.energy[bud] += Math.max(0, e);
    this.storedNutrient[bud] += Math.max(0, n);
  }

  /**
   * Split (2 pieces) / Fragment (several): grows regions over the bond graph from
   * seeds spread far apart, then breaks the bonds between regions. Each piece
   * becomes its own organism and keeps growing.
   */
  private partition(o: number, cells: number[], pieces: number): void {
    if (cells.length < pieces) return;
    const seeds = [cells[Math.floor(this.rng() * cells.length)]];
    while (seeds.length < pieces) {
      let best = -1;
      let bestD = -1;
      for (const i of cells) {
        const d = Math.min(...seeds.map((s) => hexDistance(this.hexQ[i], this.hexR[i], this.hexQ[s], this.hexR[s])));
        if (d > bestD) {
          bestD = d;
          best = i;
        }
      }
      seeds.push(best);
    }
    const region = new Map<number, number>();
    const queue: number[] = [];
    seeds.forEach((s, k) => {
      region.set(s, k);
      queue.push(s);
    });
    for (let h = 0; h < queue.length; h++) {
      const i = queue[h];
      for (let k = 0; k < this.bondDeg[i]; k++) {
        const n = this.bondOther(this.cellBonds[i * BOND_SLOTS + k], i);
        if (this.organism[n] !== o || region.has(n)) continue;
        region.set(n, region.get(i)!);
        queue.push(n);
      }
    }
    const cut: number[] = [];
    for (const i of cells) {
      for (let k = 0; k < this.bondDeg[i]; k++) {
        const b = this.cellBonds[i * BOND_SLOTS + k];
        if (this.bondA[b] === i && region.get(this.bondA[b]) !== region.get(this.bondB[b])) cut.push(b);
      }
    }
    for (const b of cut) this.freeBond(b);
    this.dirtyOrgs.add(o);
    this.reproducing.add(o);
  }

  // ------------------------------------------------------------- decay

  /** Dead cells slowly return their nutrient to the water: stored first, then body. */
  private decay(): void {
    const water = this.world.nutrient;
    for (let i = 0; i < this.cellCount; i++) {
      if (this.type[i] !== CellType.Dead) continue;
      if (this.bodyNutrient[i] + this.storedNutrient[i] > 0 && this.rng() < DEAD.decayChance) {
        if (this.storedNutrient[i] > 0) this.storedNutrient[i]--;
        else this.bodyNutrient[i]--;
        water[this.tileAt(this.x[i], this.y[i])]++;
      }
      if (this.bodyNutrient[i] + this.storedNutrient[i] === 0) this.freeCell(i);
    }
  }

  // ------------------------------------------------------------- physics

  /** An organism with a living Root cell is anchored: none of its cells move. */
  private updatePinned(): void {
    const n = this.cellCount;
    const anchored = new Uint8Array(this.orgCount);
    for (let i = 0; i < n; i++) if (this.alive[i] && this.type[i] === CellType.Root) anchored[this.organism[i]] = 1;
    for (let i = 0; i < n; i++) this.pinned[i] = this.alive[i] && anchored[this.organism[i]] ? 1 : 0;
  }

  /**
   * Cells relax toward the local current (water drag); then bonds (stiff but
   * not rigid, so bodies can flex) and contacts are solved. Anchored cells
   * don't move at all; whatever they touch moves the full correction instead.
   */
  private physics(dt: number): void {
    const n = this.cellCount;
    const { x, y, vx, vy, oldX, oldY, type, pinned } = this;
    this.updatePinned();
    const cur = { x: 0, y: 0 };
    const field = this.currents();
    for (let i = 0; i < n; i++) {
      if (type[i] === CellType.None) continue;
      oldX[i] = x[i];
      oldY[i] = y[i];
      if (pinned[i]) {
        vx[i] = 0;
        vy[i] = 0;
        continue;
      }
      sampleCurrent(field, x[i], y[i], cur);
      if (type[i] === CellType.Dead) {
        // Marine snow: dead cells drift toward deeper water.
        const tile = this.tileAt(x[i], y[i]);
        cur.x += this.sinkX[tile];
        cur.y += this.sinkY[tile];
      }
      vx[i] = vx[i] * PHYSICS.drag + cur.x * (1 - PHYSICS.drag);
      vy[i] = vy[i] * PHYSICS.drag + cur.y * (1 - PHYSICS.drag);
      x[i] += vx[i] * dt;
      y[i] += vy[i] * dt;
    }

    this.buildHash();
    this.groupOrganisms();
    const r = CELL.radius;
    for (let it = 0; it < PHYSICS.iterations; it++) {
      for (let b = 0; b < this.bondCount; b++) {
        const a = this.bondA[b];
        if (a < 0) continue;
        const c = this.bondB[b];
        const pa = pinned[a];
        const pc = pinned[c];
        if (pa && pc) continue;
        const wa = pa ? 0 : pc ? 1 : 0.5;
        const wc = pc ? 0 : pa ? 1 : 0.5;
        const dx = x[c] - x[a];
        const dy = y[c] - y[a];
        const d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
        const k = ((d - this.bondRest[b]) / d) * BONDS.stiffness;
        x[a] += dx * k * wa;
        y[a] += dy * k * wa;
        x[c] -= dx * k * wc;
        y[c] -= dy * k * wc;
      }
      this.matchShapes();
      this.solveContacts(2 * r, it === 0);
    }
    for (let i = 0; i < n; i++) {
      if (type[i] === CellType.None || pinned[i]) continue;
      x[i] = Math.min(this.worldWidth - r, Math.max(r, x[i]));
      y[i] = Math.min(this.worldHeight - r, Math.max(r, y[i]));
    }

    for (let i = 0; i < n; i++) {
      if (type[i] === CellType.None || pinned[i]) continue;
      vx[i] = (x[i] - oldX[i]) / dt;
      vy[i] = (y[i] - oldY[i]) / dt;
    }
  }

  /**
   * Keeps bodies close to their designed shape: each organism's best-fit
   * rotation and position of its hex layout is found, and every cell is pulled
   * part of the way toward its spot in it. Bodies hold their orientation and
   * spring back after bending, with some give. Anchored cells don't move.
   */
  private matchShapes(): void {
    const k = BONDS.shapeStiffness;
    if (k <= 0) return;
    const start = this.orgStart;
    const list = this.orgList;
    const { x, y, pinned, restX, restY } = this;
    for (let o = 0; o < this.orgCount; o++) {
      const a = start[o];
      const b = start[o + 1];
      if (b - a < 2) {
        // A lone cell's body rotation is its own orientation.
        if (b - a === 1) this.recordAngle(o, this.angle[list[a]]);
        continue;
      }
      // Rest (designed) and current centroids.
      let rx = 0;
      let ry = 0;
      let cx = 0;
      let cy = 0;
      for (let n = a; n < b; n++) {
        const i = list[n];
        rx += restX[i];
        ry += restY[i];
        cx += x[i];
        cy += y[i];
      }
      const count = b - a;
      rx /= count;
      ry /= count;
      cx /= count;
      cy /= count;
      // Best-fit rotation (2D Procrustes).
      let dot = 0;
      let cross = 0;
      for (let n = a; n < b; n++) {
        const i = list[n];
        const px = restX[i] - rx;
        const py = restY[i] - ry;
        const qx = x[i] - cx;
        const qy = y[i] - cy;
        dot += px * qx + py * qy;
        cross += px * qy - py * qx;
      }
      const angle = Math.atan2(cross, dot);
      this.recordAngle(o, angle);
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      for (let n = a; n < b; n++) {
        const i = list[n];
        if (pinned[i]) continue;
        const px = restX[i] - rx;
        const py = restY[i] - ry;
        x[i] += (cx + px * c - py * s - x[i]) * k;
        y[i] += (cy + px * s + py * c - y[i]) * k;
      }
    }
  }

  /** Records an organism's body rotation for this tick, keeping the previous tick's for turning speed. */
  private recordAngle(o: number, angle: number): void {
    if (this.orgAngleTick[o] !== this.tick) {
      this.orgAnglePrev[o] = this.orgAngleTick[o] === this.tick - 1 ? this.orgAngle[o] : angle;
      this.orgAngleTick[o] = this.tick;
    }
    this.orgAngle[o] = angle;
  }

  private bucketOf(px: number, py: number): [number, number] {
    const size = this.bucket;
    return [
      Math.min(this.hashCols - 1, Math.max(0, Math.floor(px / size))),
      Math.min(this.hashRows - 1, Math.max(0, Math.floor(py / size))),
    ];
  }

  private buildHash(): void {
    this.hashHead.fill(-1);
    const size = this.bucket;
    const cols = this.hashCols;
    const rows = this.hashRows;
    for (let i = 0; i < this.cellCount; i++) {
      if (this.type[i] === CellType.None) continue;
      const bx = Math.min(cols - 1, Math.max(0, Math.floor(this.x[i] / size)));
      const by = Math.min(rows - 1, Math.max(0, Math.floor(this.y[i] / size)));
      const h = by * cols + bx;
      this.hashNext[i] = this.hashHead[h];
      this.hashHead[h] = i;
    }
  }

  /**
   * Pushes overlapping cells apart. Cells are sorted by a grid of contact-size
   * buckets (once per tick, on the first pass) and solved on copies of their
   * positions in that order, so neighbors sit close in memory. Each pair is
   * visited once: within a bucket, and against the four buckets ahead of it.
   * The correction is split evenly, or taken entirely by the free cell when
   * the other is anchored.
   */
  private solveContacts(minDist: number, sort: boolean): void {
    const { x, y, type, pinned } = this;
    const ids = this.sortedIds;
    const sx = this.sortedX;
    const sy = this.sortedY;
    const sp = this.sortedPinned;
    const start = this.contactStart;
    const cols = this.contactCols;
    const rows = this.contactRows;
    const buckets = cols * rows;
    if (sort) {
      // Counting sort of cells by bucket.
      start.fill(0);
      for (let i = 0; i < this.cellCount; i++) {
        if (type[i] === CellType.None) continue;
        start[this.contactBucket(x[i], y[i]) + 1]++;
      }
      for (let b = 0; b < buckets; b++) start[b + 1] += start[b];
      if (this.contactFill.length < buckets) this.contactFill = new Int32Array(buckets);
      const fill = this.contactFill;
      fill.set(start.subarray(0, buckets));
      for (let i = 0; i < this.cellCount; i++) {
        if (type[i] === CellType.None) continue;
        ids[fill[this.contactBucket(x[i], y[i])]++] = i;
      }
    }
    const n = start[buckets];
    for (let k = 0; k < n; k++) {
      const i = ids[k];
      sx[k] = x[i];
      sy[k] = y[i];
      sp[k] = pinned[i];
    }
    const min2 = minDist * minDist;
    const pair = (a: number, b: number) => {
      const dx = sx[b] - sx[a];
      const dy = sy[b] - sy[a];
      const d2 = dx * dx + dy * dy;
      if (d2 >= min2) return;
      const pa = sp[a];
      const pb = sp[b];
      if (pa && pb) return;
      const wa = pa ? 0 : pb ? 1 : 0.5;
      const wb = pb ? 0 : pa ? 1 : 0.5;
      const d = Math.sqrt(d2);
      // Exactly overlapping cells get pushed apart along an arbitrary axis.
      const ux = d > 1e-6 ? dx / d : 1;
      const uy = d > 1e-6 ? dy / d : 0;
      const push = minDist - d;
      sx[a] -= ux * push * wa;
      sy[a] -= uy * push * wa;
      sx[b] += ux * push * wb;
      sy[b] += uy * push * wb;
    };
    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < cols; bx++) {
        const b = by * cols + bx;
        const a0 = start[b];
        const a1 = start[b + 1];
        if (a0 === a1) continue;
        for (let a = a0; a < a1; a++) {
          for (let c = a + 1; c < a1; c++) pair(a, c);
        }
        // Forward neighbors: right, and the three buckets in the row below.
        const right = bx + 1 < cols;
        const down = by + 1 < rows;
        if (right) for (let a = a0; a < a1; a++) for (let c = start[b + 1]; c < start[b + 2]; c++) pair(a, c);
        if (down) {
          const lo = b + cols + (bx > 0 ? -1 : 0);
          const hi = b + cols + (right ? 1 : 0);
          for (let a = a0; a < a1; a++) for (let c = start[lo]; c < start[hi + 1]; c++) pair(a, c);
        }
      }
    }
    for (let k = 0; k < n; k++) {
      const i = ids[k];
      x[i] = sx[k];
      y[i] = sy[k];
    }
  }

  private contactBucket(px: number, py: number): number {
    const size = 2 * CELL.radius;
    const bx = Math.min(this.contactCols - 1, Math.max(0, Math.floor(px / size)));
    const by = Math.min(this.contactRows - 1, Math.max(0, Math.floor(py / size)));
    return by * this.contactCols + bx;
  }

  // ------------------------------------------------------------- allocation

  /** Creates a living cell from a plan slot. `frame` is the organism's hex frame orientation there. */
  private initCell(id: number, slot: DesignCell, x: number, y: number, frame: number, energy: number, org: number, stored: number): void {
    const type = KIND_TYPE[slot.kind];
    const { q, r } = slot;
    this.alive[id] = 1;
    this.type[id] = type;
    this.x[id] = x;
    this.y[id] = y;
    this.vx[id] = 0;
    this.vy[id] = 0;
    // Jets and sensors face outward from the cell they're attached to.
    this.jetPush[id] = type === CellType.Jet || isSensorType(type) ? (slot.push ?? -1) : -1;
    this.jetStrength[id] = type === CellType.Jet ? jetStrength(slot) : 0;
    this.planSlot[id] = slot.index ?? -1;
    this.proxFilter[id] =
      type === CellType.ProximitySensor && slot.filter ? (slot.filter === 'dead' ? CellType.Dead : KIND_TYPE[slot.filter]) : 0;
    if (type === CellType.Tip) {
      // Grows outward from the cell it's attached to, unless the slot says otherwise.
      this.tipDir[id] = slot.push !== undefined && slot.push >= 0 ? (slot.push + 3) % 6 : 0;
      this.tipBase[id * 3] = tipGrow(slot);
      this.tipBase[id * 3 + 1] = slot.turn ?? 0;
      this.tipBase[id * 3 + 2] = slot.branch ?? 0;
      for (let c = 0; c < 3; c++) this.tipSignal[id * 3 + c] = this.tipBase[id * 3 + c];
      const dep = tipDeposit(slot).slice(0, TIP.maxDeposit);
      dep.forEach((k, n) => (this.tipDeposit[id * TIP.maxDeposit + n] = KIND_TYPE[k]));
      this.tipDepositLen[id] = dep.length;
      this.tipCounter[id] = 0;
      this.tipSinceBranch[id] = 0;
    }
    if (type === CellType.Timer) {
      this.timerCycles[id] = timerCycles(slot);
      this.timerPhase[id] = timerPhase(slot);
      this.timerDuty[id] = timerDuty(slot);
    }
    this.neuronOut[id] = this.neuronPrev[id] = this.neuronNoise[id] = 0;
    if (type === CellType.Neuron) {
      this.neuronBias[id] = neuronBias(slot);
      this.neuronSpeed[id] = neuronSpeed(slot);
      NEURON_INPUT_KEYS.forEach((k, n) => (this.neuronInputs[id * NEURON_INPUT_KEYS.length + n] = slot.inputs?.[k] ?? 0));
      this.neuronEatenRange[id] = slot.eatenRange ?? NEURON_INPUTS.eatenRangeMax;
    }
    this.sensorLevel[id] = this.sensorAvg[id] = this.sensorChange[id] = 0;
    this.firing[id] = 0;
    // A Jet's angle is its exhaust direction; other cells keep their frame orientation.
    if (this.jetPush[id] >= 0) {
      const [px, py] = hexToLocal(...HEX_DIRS[this.jetPush[id]]);
      this.angle[id] = frame + Math.atan2(py, px) + Math.PI;
    } else {
      this.angle[id] = frame;
    }
    this.energy[id] = energy;
    this.bodyNutrient[id] = CELL.bodyNutrient;
    this.storedNutrient[id] = stored;
    this.drained[id] = 0;
    this.age[id] = 0;
    this.organism[id] = org;
    this.cellLineage[id] = this.lineage[org];
    this.spikedAt[id] = -1e9;
    this.setHex(id, q, r);
    this.bondDeg[id] = 0;
    this.emit(CellEvent.Born, id);
  }

  private allocCell(): number {
    if (this.freeCells.length > 0) return this.freeCells.pop()!;
    return this.cellCount < SIM.maxCells ? this.cellCount++ : -1;
  }

  private freeCell(i: number): void {
    this.alive[i] = 0;
    this.type[i] = CellType.None;
    this.organism[i] = -1;
    this.freeCells.push(i);
    this.emit(CellEvent.Removed, i);
  }

  private addBond(a: number, b: number, rest: number): void {
    if (this.bondDeg[a] >= BOND_SLOTS || this.bondDeg[b] >= BOND_SLOTS) return;
    const id = this.freeBonds.length > 0 ? this.freeBonds.pop()! : this.bondCount < SIM.maxBonds ? this.bondCount++ : -1;
    if (id < 0) return;
    this.bondA[id] = a;
    this.bondB[id] = b;
    this.bondRest[id] = rest;
    this.cellBonds[a * BOND_SLOTS + this.bondDeg[a]++] = id;
    this.cellBonds[b * BOND_SLOTS + this.bondDeg[b]++] = id;
    this.events.push(CellEvent.BondAdded, a, b, 0, 0, 0, 0, 0, 0, 0, 0);
  }

  private freeBond(b: number): void {
    const a = this.bondA[b];
    const c = this.bondB[b];
    this.events.push(CellEvent.BondRemoved, a, c, 0, 0, 0, 0, 0, 0, 0, 0);
    this.unlinkBond(a, b);
    this.unlinkBond(c, b);
    this.bondA[b] = -1;
    this.bondB[b] = -1;
    this.freeBonds.push(b);
  }

  /** Removes bond b from cell i's bond list. */
  private unlinkBond(i: number, b: number): void {
    const base = i * BOND_SLOTS;
    const last = --this.bondDeg[i];
    for (let k = 0; k <= last; k++) {
      if (this.cellBonds[base + k] === b) {
        this.cellBonds[base + k] = this.cellBonds[base + last];
        return;
      }
    }
  }

  /** Sets a cell's spot in its organism's hex layout (and its cached rest offset). */
  private setHex(i: number, q: number, r: number): void {
    this.hexQ[i] = q;
    this.hexR[i] = r;
    const d = 2 * CELL.radius;
    this.restX[i] = (q + r / 2) * d;
    this.restY[i] = r * SQRT3_2 * d;
  }

  private emit(kind: number, i: number): void {
    const l = this.cellLineage[i];
    this.events.push(kind, i, this.type[i], this.x[i], this.y[i], this.angle[i], this.energy[i], this.bodyNutrient[i], this.organism[i], this.lineages.owner[l], l);
  }

  /** Returns and clears the recorded events. */
  drainEvents(): Float32Array {
    const out = Float32Array.from(this.events);
    this.events.length = 0;
    return out;
  }

  private allocOrg(): number {
    const o = this.freeOrgs.length > 0 ? this.freeOrgs.pop()! : this.orgCount < SIM.maxOrganisms ? this.orgCount++ : -1;
    if (o >= 0) {
      this.orgAngleTick[o] = -10;
      this.orgSegments[o] = 1;
      this.orgTipTurn[o] = 0;
      this.orgTipStuck[o] = 0;
    }
    return o;
  }

  private freeOrg(o: number): void {
    this.orgCells[o] = 0;
    this.lost.delete(o);
    this.freeOrgs.push(o);
  }
}
