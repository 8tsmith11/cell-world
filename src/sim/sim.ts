import {
  BONDS,
  CELL,
  DEAD,
  DECOMPOSER,
  DESIGN,
  FAT,
  GROWTH,
  JET,
  LEAF,
  METABOLISM,
  MOUTH,
  LINEAGE,
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
  bodyMix,
  CELL_KINDS,
  type CellKind,
} from './genome';
import { type ExtinctionEvent, type LineageStats, Lineages } from './lineages';
import { mutate } from './mutation';
import { createRng } from './rng';
import { generateWorld, stepWorld, type World } from './world';

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
] as const;

/** Energy a cell of this type can hold. Fat holds much more. */
export const energyCap = (type: number) => (type === CellType.Fat ? FAT.maxEnergy : CELL.maxEnergy);
/** Stored nutrient a cell of this type can hold. Root holds much more. */
export const storedCap = (type: number) => (type === CellType.Root ? ROOT.storedNutrientCap : CELL.storedNutrientCap);

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
  /** Proximity sensors: the cell type they count (CellType), or 0 for any cell. */
  readonly proxFilter = new Uint8Array(SIM.maxCells);
  /** Sensors: current level (0 to 1), its recent moving average, and change (-1 to 1). */
  readonly sensorLevel = new Float32Array(SIM.maxCells);
  private sensorAvg = new Float32Array(SIM.maxCells);
  readonly sensorChange = new Float32Array(SIM.maxCells);
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
  private uf = new Int32Array(SIM.maxCells);
  private hashCols: number;
  private hashRows: number;
  private hashHead: Int32Array;
  private hashNext = new Int32Array(SIM.maxCells);
  /** Spatial hash cell size: covers contacts (2r) and every touching distance. */
  private bucket = CELL.radius * Math.max(2, MOUTH.touchDistance, SPIKE.touchDistance, DECOMPOSER.touchDistance);
  private jetFrame = new Float32Array(SIM.maxCells);
  /** 1 for cells drained by a Mouth this tick (for the render cue). */
  readonly drained = new Uint8Array(SIM.maxCells);

  constructor(seed: number) {
    this.world = generateWorld(seed);
    this.rng = createRng(seed ^ 0x9e3779b9);
    this.hashCols = Math.ceil(this.worldWidth / this.bucket);
    this.hashRows = Math.ceil(this.worldHeight / this.bucket);
    this.hashHead = new Int32Array(this.hashCols * this.hashRows);
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
    this.sense(dt);
    this.fireJets(dt);
    this.killStarved();
    this.resolveSplits();
    if (this.tick % GROWTH.checkInterval === 0) this.growAndReproduce();
    this.decay();
    this.physics(dt);
    if (this.tick % Math.round(LINEAGE.statsIntervalSec * SIM.tickHz) === 0) this.lineageReport = this.lineages.update(this, this.tick);
  }

  // ------------------------------------------------------------- energy and nutrient

  private metabolism(temperature: number): number {
    const t = (temperature - TEMPERATURE.edge) / (TEMPERATURE.center - TEMPERATURE.edge);
    const c = Math.min(1, Math.max(0, t));
    return METABOLISM.coldMultiplier + (METABOLISM.warmMultiplier - METABOLISM.coldMultiplier) * c;
  }

  private updateEnergy(dt: number): void {
    const { light, temperature } = this.world;
    for (let i = 0; i < this.cellCount; i++) {
      if (!this.alive[i]) continue;
      this.age[i]++;
      const tile = this.tileAt(this.x[i], this.y[i]);
      const gain = this.type[i] === CellType.Leaf ? LEAF.photosynthesis * light[tile] * dt : 0;
      if (gain > 0) this.lineages.creditLight(this.cellLineage[i], gain);
      const upkeep = METABOLISM.upkeep * this.metabolism(temperature[tile]) * dt;
      this.energy[i] = Math.min(energyCap(this.type[i]), this.energy[i] + gain - upkeep);
    }
  }

  /**
   * Leaves and Roots move nutrient from the water at their position into their
   * store, up to their cap. Roots absorb faster. Rates are in units per second,
   * moved as whole units (fractions carry over as a chance per tick).
   */
  private absorb(dt: number): void {
    const water = this.world.nutrient;
    for (let i = 0; i < this.cellCount; i++) {
      if (!this.alive[i]) continue;
      const t = this.type[i];
      const rate = t === CellType.Leaf ? LEAF.absorbRate : t === CellType.Root ? ROOT.absorbRate : 0;
      if (rate === 0) continue;
      const amount = rate * dt;
      let units = Math.floor(amount) + (this.rng() < amount % 1 ? 1 : 0);
      const tile = this.tileAt(this.x[i], this.y[i]);
      units = Math.min(units, water[tile], storedCap(t) - this.storedNutrient[i]);
      if (units <= 0) continue;
      water[tile] -= units;
      this.storedNutrient[i] += units;
    }
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
        f = f > 0 ? Math.min(f, FAT.maxEnergy - this.energy[fat]) : -Math.min(-f, this.energy[fat]);
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

  /**
   * Each sensor reads only at its own position:
   * - light: light level; nutrient: water nutrient; temperature: temperature
   *   (all normalized to 0-1);
   * - touch: 1 if touching a living cell of another organism, else 0;
   * - proximity: how many living cells of other organisms are within a short
   *   range (not what they are), normalized.
   * Change compares the level with its recent moving average: -1 falling to 1 rising.
   */
  private sense(dt: number): void {
    const { light, temperature, nutrient } = this.world;
    const tempRange = TEMPERATURE.center - TEMPERATURE.edge;
    const smooth = 1 - Math.exp(-dt / SENSOR.changeWindowSec);
    for (let i = 0; i < this.cellCount; i++) {
      if (!this.alive[i] || !isSensorType(this.type[i])) continue;
      const tile = this.tileAt(this.x[i], this.y[i]);
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
            if (this.alive[j] && this.organism[j] !== this.organism[i] && (only === 0 || this.type[j] === only)) count++;
          });
          level = count / SENSOR.proximityFull;
          break;
        }
      }
      level = Math.min(1, Math.max(0, level));
      // A new sensor starts with no trend.
      if (this.age[i] <= 1) this.sensorAvg[i] = level;
      this.sensorAvg[i] += (level - this.sensorAvg[i]) * smooth;
      this.sensorLevel[i] = level;
      this.sensorChange[i] = Math.min(1, Math.max(-1, (level - this.sensorAvg[i]) / SENSOR.changeScale));
    }
  }

  /**
   * Jets fire constantly at their strength while they have the energy, pushing
   * their organism toward the cell they're attached to (exhaust points away).
   * A Jet whose exhaust hex holds a cell of its own organism is blocked: no
   * thrust, no energy spent. A Jet's `angle` is kept as its world-space exhaust direction.
   */
  private fireJets(dt: number): void {
    const n = this.cellCount;
    const frame = this.jetFrame;
    frame.fill(NaN, 0, n);
    // Current orientation of each Jet's hex frame, measured along any bond.
    for (let b = 0; b < this.bondCount; b++) {
      const a = this.bondA[b];
      if (a < 0) continue;
      const c = this.bondB[b];
      for (const [i, j] of [
        [a, c],
        [c, a],
      ]) {
        if (this.type[i] !== CellType.Jet || !Number.isNaN(frame[i])) continue;
        const [lx, ly] = hexToLocal(this.hexQ[j] - this.hexQ[i], this.hexR[j] - this.hexR[i]);
        frame[i] = Math.atan2(this.y[j] - this.y[i], this.x[j] - this.x[i]) - Math.atan2(ly, lx);
      }
    }
    // Wired sensors by (organism, plan slot), for Jets driven by behavior wiring.
    let sensors: Map<number, number> | null = null;
    // Hex spots occupied by living cells, per organism (only needed when there are Jets).
    let occupied: Set<number> | null = null;
    const spot = (org: number, q: number, r: number) => org * 4194304 + hexKey(q, r);
    for (let i = 0; i < n; i++) {
      this.firing[i] = 0;
      if (!this.alive[i] || this.type[i] !== CellType.Jet || this.jetPush[i] < 0) continue;
      if (!occupied) {
        occupied = new Set();
        for (let j = 0; j < n; j++) if (this.alive[j]) occupied.add(spot(this.organism[j], this.hexQ[j], this.hexR[j]));
      }
      const [pq, pr] = HEX_DIRS[this.jetPush[i]];
      if (occupied.has(spot(this.organism[i], this.hexQ[i] - pq, this.hexR[i] - pr))) continue;
      // Firing strength = base strength + sum of (weight × sensor input), clamped to 0-1.
      let strength = this.jetStrength[i];
      const wires = this.genomes[this.genomeId[this.organism[i]]].wires.get(this.planSlot[i]);
      if (wires) {
        if (!sensors) {
          sensors = new Map();
          for (let j = 0; j < n; j++) {
            if (this.alive[j] && isSensorType(this.type[j]) && this.planSlot[j] >= 0) sensors.set(this.organism[j] * 65536 + this.planSlot[j], j);
          }
        }
        for (const w of wires) {
          const sensor = sensors.get(this.organism[i] * 65536 + w.sensor);
          if (sensor !== undefined) strength += w.weight * (w.change ? this.sensorChange[sensor] : this.sensorLevel[sensor]);
        }
        strength = Math.min(1, Math.max(0, strength));
      }
      const cost = JET.energyPerSecond * strength * dt;
      if (strength < JET.minStrength || this.energy[i] <= cost) continue;
      this.energy[i] -= cost;
      // Without a bond to measure from, keep the last exhaust direction.
      if (!Number.isNaN(frame[i])) {
        const [px, py] = hexToLocal(...HEX_DIRS[this.jetPush[i]]);
        this.angle[i] = frame[i] + Math.atan2(py, px) + Math.PI;
      }
      const push = this.angle[i] + Math.PI;
      this.vx[i] += Math.cos(push) * JET.thrust * strength * dt;
      this.vy[i] += Math.sin(push) * JET.thrust * strength * dt;
      this.firing[i] = 1;
    }
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
    for (let b = 0; b < this.bondCount; b++) {
      if (this.bondA[b] === i || this.bondB[b] === i) this.freeBond(b);
    }
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
      filter: this.proxFilter[i] ? (TYPE_STYLE[this.proxFilter[i]] as CellKind) : undefined,
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
    this.buildHash();
    for (let i = 0; i < n; i++) {
      if (!this.alive[i]) continue;
      const t = this.type[i];
      if (t === CellType.Mouth) this.contacts(i, MOUTH.touchDistance, (j) => this.mouthBite(i, j, dt));
      else if (t === CellType.Spike) this.contacts(i, SPIKE.touchDistance, (j) => this.spikeDrain(i, j, dt));
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
    const take = Math.max(0, Math.min(this.energy[j], MOUTH.drainRate * dt));
    this.energy[j] -= take;
    this.energy[i] = Math.min(energyCap(this.type[i]), this.energy[i] + take * MOUTH.efficiency);
    this.lineages.creditPrey(this.cellLineage[i], this.cellLineage[j], take * MOUTH.efficiency);
    this.drained[j] = 1;
    if (this.energy[j] <= 0) this.eat(i, j);
    return true;
  }

  private spikeDrain(i: number, j: number, dt: number): void {
    if (!this.alive[j] || this.organism[j] === this.organism[i]) return;
    this.energy[j] = Math.max(0, this.energy[j] - SPIKE.drainRate * dt);
    this.drained[j] = 1;
    this.spikedBy[j] = this.cellLineage[i];
    this.spikedAt[j] = this.tick;
  }

  private decompose(i: number, j: number, dt: number): void {
    if (this.type[j] !== CellType.Dead) return;
    const amount = DECOMPOSER.eatRate * dt;
    let units = Math.floor(amount) + (this.rng() < amount % 1 ? 1 : 0);
    units = Math.min(units, this.bodyNutrient[j] + this.storedNutrient[j], storedCap(this.type[i]) - this.storedNutrient[i]);
    if (units > 0) {
      const fromStore = Math.min(units, this.storedNutrient[j]);
      this.storedNutrient[j] -= fromStore;
      this.bodyNutrient[j] -= units - fromStore;
      this.storedNutrient[i] += units;
      this.energy[i] = Math.min(energyCap(this.type[i]), this.energy[i] + units * DECOMPOSER.energyPerNutrient);
      // Dead cells keep their lineage: the Decomposer counts as eating it.
      this.lineages.creditPrey(this.cellLineage[i], this.cellLineage[j], units * DECOMPOSER.energyPerNutrient);
      this.drained[j] = 1;
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
    for (const org of this.dirtyOrgs) if (this.orgCells[org] > 0) this.splitComponents(org, this.reproducing.has(org));
    this.dirtyOrgs.clear();
    this.reproducing.clear();
  }

  /**
   * Gives each piece beyond the largest its own organism. When the split is
   * reproduction (Split/Fragment), those pieces are offspring: the next
   * generation, with a possibly mutated copy of the genome. Pieces left by a
   * death keep the genome unchanged.
   */
  private splitComponents(org: number, offspring = false): void {
    const uf = this.uf;
    const find = (i: number): number => {
      while (uf[i] !== i) {
        uf[i] = uf[uf[i]];
        i = uf[i];
      }
      return i;
    };
    const members: number[] = [];
    for (let i = 0; i < this.cellCount; i++) {
      if (this.organism[i] === org) {
        uf[i] = i;
        members.push(i);
      }
    }
    for (let b = 0; b < this.bondCount; b++) {
      const a = this.bondA[b];
      if (a < 0 || this.organism[a] !== org) continue;
      const ra = find(a);
      const rb = find(this.bondB[b]);
      if (ra !== rb) uf[ra] = rb;
    }
    const groups = new Map<number, number[]>();
    for (const i of members) {
      const root = find(i);
      let g = groups.get(root);
      if (!g) groups.set(root, (g = []));
      g.push(i);
    }
    if (groups.size <= 1) return;
    const parts = [...groups.values()].sort((p, q) => q.length - p.length);
    for (let p = 1; p < parts.length; p++) {
      const child = this.allocOrg();
      if (child < 0) return;
      this.owner[child] = this.owner[org];
      this.lineage[child] = this.lineage[org];
      this.inherit(org, child, offspring);
      // Pieces that came apart keep the memory of lost spots near them.
      if (!offspring && this.lost.has(org)) this.lost.set(child, this.lost.get(org)!.map((l) => ({ ...l })));
      for (const i of parts[p]) this.organism[i] = child;
      this.orgCells[child] = parts[p].length;
      this.orgCells[org] -= parts[p].length;
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

  /** Groups living cells by organism (counting sort) for the growth pass. */
  private cellsByOrganism(): { start: Int32Array; list: Int32Array } {
    const start = new Int32Array(this.orgCount + 1);
    for (let i = 0; i < this.cellCount; i++) if (this.alive[i] && this.organism[i] >= 0) start[this.organism[i] + 1]++;
    for (let o = 0; o < this.orgCount; o++) start[o + 1] += start[o];
    const fill = start.slice(0, this.orgCount);
    const list = new Int32Array(start[this.orgCount]);
    for (let i = 0; i < this.cellCount; i++) if (this.alive[i] && this.organism[i] >= 0) list[fill[this.organism[i]]++] = i;
    return { start, list };
  }

  /**
   * Organisms below their max size try to add one cell; at max size they
   * reproduce when they have enough stored energy and nutrient.
   */
  private growAndReproduce(): void {
    const { start, list } = this.cellsByOrganism();
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

  /** Whether a cell can pay for one new cell (and keep some energy to live on). */
  private canPay(i: number, g: Genome): boolean {
    return this.energy[i] > g.design.growEnergy && this.storedNutrient[i] >= g.design.growNutrient;
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

  private grow(o: number, g: Genome, cells: number[], occ: Map<number, number>): void {
    // Form, Pattern, and a Blob's seed body: the earliest free plan slot touching the body.
    let slot: DesignCell | null = null;
    let parents: number[] = [];
    for (const s of g.plan) {
      if (occ.has(hexKey(s.q, s.r))) continue;
      parents = this.adjacent(s.q, s.r, occ);
      if (parents.length) {
        slot = s;
        break;
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
    // Blob: then random free spots on its edge, with types from the cell mix.
    if (!slot && g.design.growth === 'blob') {
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
    if (!slot) return;
    const parent = parents.find((p) => this.canPay(p, g));
    if (parent === undefined) return;
    const frame = this.frameAngle(parent, occ);
    const [px, py] = this.placeNear(parent, slot.q, slot.r, frame);
    if (!this.spotFree(px, py)) return;
    const id = this.addCell(parent, g, slot, px, py, frame, o);
    if (id < 0) return;
    // Bond to every neighbor in the layout: filled shapes hold, chains flex.
    for (const n of this.adjacent(slot.q, slot.r, occ)) this.addBond(n, id, 2 * CELL.radius);
    occ.set(hexKey(slot.q, slot.r), id);
    const list = this.lost.get(o);
    if (list) this.lost.set(o, list.filter((l) => l.q !== slot!.q || l.r !== slot!.r));
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
   * Spends the parent's stored energy and nutrient on a new cell. The nutrient
   * becomes the new body (surplus goes to its store); part of the energy is
   * lost and the rest becomes the new cell's energy.
   */
  private addCell(parent: number, g: Genome, slot: DesignCell, px: number, py: number, frame: number, org: number): number {
    const id = this.allocCell();
    if (id < 0) return -1;
    const { growEnergy, growNutrient } = g.design;
    this.energy[parent] -= growEnergy;
    this.storedNutrient[parent] -= growNutrient;
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
    const source = cells.find((i) => this.canPay(i, g));
    if (source === undefined) return;
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
      if (child < 0) return;
      this.owner[child] = this.owner[o];
      this.lineage[child] = this.lineage[o];
      this.inherit(o, child, true);
      this.orgCells[child] = 1;
      // The bud grows its own (possibly mutated) design from that design's starter.
      const starter = this.genomes[this.genomeId[child]].plan[0];
      const id = this.addCell(source, g, starter, px, py, this.rng() * Math.PI * 2, child);
      if (id < 0) {
        this.freeOrg(child);
        return;
      }
      return;
    }
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
    const adj = new Map<number, number[]>();
    const orgBonds: number[] = [];
    for (let b = 0; b < this.bondCount; b++) {
      const a = this.bondA[b];
      if (a < 0 || this.organism[a] !== o) continue;
      const c = this.bondB[b];
      orgBonds.push(b);
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(c)) adj.set(c, []);
      adj.get(a)!.push(c);
      adj.get(c)!.push(a);
    }
    const region = new Map<number, number>();
    const queue: number[] = [];
    seeds.forEach((s, k) => {
      region.set(s, k);
      queue.push(s);
    });
    for (let h = 0; h < queue.length; h++) {
      const i = queue[h];
      for (const n of adj.get(i) ?? []) {
        if (region.has(n)) continue;
        region.set(n, region.get(i)!);
        queue.push(n);
      }
    }
    for (const b of orgBonds) {
      if (region.get(this.bondA[b]) !== region.get(this.bondB[b])) this.freeBond(b);
    }
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
    const field: CurrentField = { dir: this.world.currentDir, strength: this.world.currentStrength };
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
      vx[i] = vx[i] * PHYSICS.drag + cur.x * (1 - PHYSICS.drag);
      vy[i] = vy[i] * PHYSICS.drag + cur.y * (1 - PHYSICS.drag);
      x[i] += vx[i] * dt;
      y[i] += vy[i] * dt;
    }

    this.buildHash();
    const r = CELL.radius;
    for (let it = 0; it < PHYSICS.iterations; it++) {
      for (let b = 0; b < this.bondCount; b++) {
        const a = this.bondA[b];
        if (a < 0) continue;
        const c = this.bondB[b];
        const dx = x[c] - x[a];
        const dy = y[c] - y[a];
        const d = Math.hypot(dx, dy) || 1e-6;
        const [wa, wc] = this.weights(a, c);
        if (wa + wc === 0) continue;
        const k = ((d - this.bondRest[b]) / d) * BONDS.stiffness;
        x[a] += dx * k * wa;
        y[a] += dy * k * wa;
        x[c] -= dx * k * wc;
        y[c] -= dy * k * wc;
      }
      this.solveContacts(2 * r);
      for (let i = 0; i < n; i++) {
        if (type[i] === CellType.None || pinned[i]) continue;
        x[i] = Math.min(this.worldWidth - r, Math.max(r, x[i]));
        y[i] = Math.min(this.worldHeight - r, Math.max(r, y[i]));
      }
    }

    for (let i = 0; i < n; i++) {
      if (type[i] === CellType.None || pinned[i]) continue;
      vx[i] = (x[i] - oldX[i]) / dt;
      vy[i] = (y[i] - oldY[i]) / dt;
    }
  }

  /** Share of a correction each cell takes: half each, or all of it for the free one when the other is anchored. */
  private weights(a: number, b: number): [number, number] {
    const pa = this.pinned[a];
    const pb = this.pinned[b];
    if (pa && pb) return [0, 0];
    if (pa) return [0, 1];
    if (pb) return [1, 0];
    return [0.5, 0.5];
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
    for (let i = 0; i < this.cellCount; i++) {
      if (this.type[i] === CellType.None) continue;
      const [bx, by] = this.bucketOf(this.x[i], this.y[i]);
      const h = by * this.hashCols + bx;
      this.hashNext[i] = this.hashHead[h];
      this.hashHead[h] = i;
    }
  }

  private solveContacts(minDist: number): void {
    const { x, y } = this;
    const min2 = minDist * minDist;
    for (let i = 0; i < this.cellCount; i++) {
      if (this.type[i] === CellType.None) continue;
      const [bx, by] = this.bucketOf(x[i], y[i]);
      for (let oy = -1; oy <= 1; oy++) {
        const ry = by + oy;
        if (ry < 0 || ry >= this.hashRows) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const rx = bx + ox;
          if (rx < 0 || rx >= this.hashCols) continue;
          for (let j = this.hashHead[ry * this.hashCols + rx]; j >= 0; j = this.hashNext[j]) {
            if (j <= i) continue;
            const dx = x[j] - x[i];
            const dy = y[j] - y[i];
            const d2 = dx * dx + dy * dy;
            if (d2 >= min2) continue;
            const d = Math.sqrt(d2);
            // Exactly overlapping cells get pushed apart along an arbitrary axis.
            const ux = d > 1e-6 ? dx / d : 1;
            const uy = d > 1e-6 ? dy / d : 0;
            const [wi, wj] = this.weights(i, j);
            const push = minDist - d;
            x[i] -= ux * push * wi;
            y[i] -= uy * push * wi;
            x[j] += ux * push * wj;
            y[j] += uy * push * wj;
          }
        }
      }
    }
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
    this.jetPush[id] = type === CellType.Jet ? (slot.push ?? -1) : -1;
    this.jetStrength[id] = type === CellType.Jet ? jetStrength(slot) : 0;
    this.planSlot[id] = slot.index ?? -1;
    this.proxFilter[id] = type === CellType.ProximitySensor && slot.filter ? KIND_TYPE[slot.filter] : 0;
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
    this.hexQ[id] = q;
    this.hexR[id] = r;
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
    const id = this.freeBonds.length > 0 ? this.freeBonds.pop()! : this.bondCount < SIM.maxBonds ? this.bondCount++ : -1;
    if (id < 0) return;
    this.bondA[id] = a;
    this.bondB[id] = b;
    this.bondRest[id] = rest;
    this.events.push(CellEvent.BondAdded, a, b, 0, 0, 0, 0, 0, 0, 0, 0);
  }

  private freeBond(b: number): void {
    this.events.push(CellEvent.BondRemoved, this.bondA[b], this.bondB[b], 0, 0, 0, 0, 0, 0, 0, 0);
    this.bondA[b] = -1;
    this.bondB[b] = -1;
    this.freeBonds.push(b);
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
    if (this.freeOrgs.length > 0) return this.freeOrgs.pop()!;
    return this.orgCount < SIM.maxOrganisms ? this.orgCount++ : -1;
  }

  private freeOrg(o: number): void {
    this.orgCells[o] = 0;
    this.lost.delete(o);
    this.freeOrgs.push(o);
  }
}
