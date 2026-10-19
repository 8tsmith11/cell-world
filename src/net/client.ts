import { FEED, NETWORK, SIM } from '../config';
import type { BoardEntry, FeedItem, GameSource, RenderCells, SpawnChoice, SpeciesInfo, StaticWorld, ViewRect } from '../game-source';
import type { Design } from '../sim/genome';
import type { CellInfo } from '../sim/protocol';
import { CellEvent, CellType, EVENT_STRIDE, energyCap } from '../sim/sim';
import { generateWorld } from '../sim/world';
import { decodeEvents, decodeNutrient, decodePositions, decodeSnapshot, Tag, tagOf } from './codec';
import { applyConfig } from './config-sync';
import type { HostMsg, Player, RelayConnection, RelayMsg } from './relay';

/** Replicated cell state with interpolation between position updates. */
class ReplicatedCells implements RenderCells {
  cellCount = 0;
  readonly cellType = new Uint8Array(SIM.maxCells);
  readonly cellX = new Float32Array(SIM.maxCells);
  readonly cellY = new Float32Array(SIM.maxCells);
  readonly cellAngle = new Float32Array(SIM.maxCells);
  readonly cellEnergy = new Float32Array(SIM.maxCells);
  readonly cellNutrient = new Uint32Array(SIM.maxCells);
  readonly cellDrained = new Uint8Array(SIM.maxCells);
  readonly cellFiring = new Uint8Array(SIM.maxCells);
  readonly cellOwner = new Int32Array(SIM.maxCells);
  readonly cellSignal = new Float32Array(SIM.maxCells);
  /** Wires among the cells in the latest position update. */
  wires = new Float32Array(0);
  readonly organism = new Int32Array(SIM.maxCells);
  private fromX = new Float32Array(SIM.maxCells);
  private fromY = new Float32Array(SIM.maxCells);
  private toX = new Float32Array(SIM.maxCells);
  private toY = new Float32Array(SIM.maxCells);
  private at = new Float64Array(SIM.maxCells);
  private interval = 1000 / NETWORK.positionHz;
  private bondSet = new Map<number, [number, number]>();
  private bondsDirty = false;
  private bondArray = new Int32Array(0);

  get bonds(): Int32Array {
    if (this.bondsDirty) {
      this.bondArray = Int32Array.from([...this.bondSet.values()].flat());
      this.bondsDirty = false;
    }
    return this.bondArray;
  }

  /** Applies records in the event layout (also used by snapshots). */
  applyEvents(ev: Float32Array, now: number): void {
    for (let k = 0; k + EVENT_STRIDE <= ev.length; k += EVENT_STRIDE) {
      const kind = ev[k];
      const id = ev[k + 1];
      if (kind === CellEvent.BondAdded || kind === CellEvent.BondRemoved) {
        const a = ev[k + 1];
        const b = ev[k + 2];
        const key = Math.min(a, b) * 65536 + Math.max(a, b);
        if (kind === CellEvent.BondAdded) this.bondSet.set(key, [a, b]);
        else this.bondSet.delete(key);
        this.bondsDirty = true;
        continue;
      }
      if (kind === CellEvent.Removed) {
        this.cellType[id] = CellType.None;
        continue;
      }
      this.cellType[id] = ev[k + 2];
      this.cellAngle[id] = ev[k + 5];
      this.cellEnergy[id] = ev[k + 6];
      this.cellNutrient[id] = ev[k + 7];
      if (kind === CellEvent.Born) this.cellDrained[id] = this.cellFiring[id] = 0;
      this.cellOwner[id] = ev[k + 9];
      this.organism[id] = ev[k + 8];
      if (kind === CellEvent.Born) {
        // A new cell appears where it was born, without sliding in from an old position.
        this.fromX[id] = this.toX[id] = this.cellX[id] = ev[k + 3];
        this.fromY[id] = this.toY[id] = this.cellY[id] = ev[k + 4];
        this.at[id] = now;
      } else {
        this.moveTo(id, ev[k + 3], ev[k + 4], now);
      }
      if (id >= this.cellCount) this.cellCount = id + 1;
    }
  }

  moveTo(id: number, x: number, y: number, now: number): void {
    this.fromX[id] = this.cellX[id];
    this.fromY[id] = this.cellY[id];
    this.toX[id] = x;
    this.toY[id] = y;
    this.at[id] = now;
  }

  /** Interpolates positions toward the latest update. */
  update(now: number): void {
    for (let i = 0; i < this.cellCount; i++) {
      if (this.cellType[i] === CellType.None) continue;
      const t = Math.min(1, (now - this.at[i]) / this.interval);
      this.cellX[i] = this.fromX[i] + (this.toX[i] - this.fromX[i]) * t;
      this.cellY[i] = this.fromY[i] + (this.toY[i] - this.fromY[i]) * t;
    }
  }
}

/** A client's view of the host's game, rebuilt from the seed and kept current by deltas. */
export class ClientSession implements GameSource {
  readonly isHost = false;
  debug = false;
  players: Player[] = [];
  worldVersion = 0;
  world: (StaticWorld & { nutrient: Uint32Array }) | null = null;

  onLobby: () => void = () => {};
  onStart: () => void = () => {};
  onEnd: (reason: string) => void = () => {};

  private replicated: ReplicatedCells | null = null;
  private ready = false;
  private worldTime = 0;
  private isPaused = false;
  private hoverId = -1;
  private hover: CellInfo | null = null;
  private totals: { water: number; cells: number } | null = null;
  private lastView: ViewRect | null = null;
  private lastViewSent = 0;
  private started = false;
  private myDna: number | null = null;
  private mySpecies: SpeciesInfo[] = [];
  private boardEntries: BoardEntry[] = [];
  private feedItems: FeedItem[] = [];
  private noticeText = '';
  private noticeUntil = 0;

  get selfId(): number {
    return this.conn.id;
  }

  constructor(private conn: RelayConnection) {
    conn.onJson = (msg) => this.onJson(msg as RelayMsg | HostMsg);
    conn.onBinary = (buf) => this.onBinary(buf);
    conn.onClose = (reason) => this.onEnd(reason);
  }

  private onJson(msg: RelayMsg | HostMsg): void {
    switch (msg.t) {
      case 'lobby':
        this.players = msg.players;
        this.onLobby();
        break;
      case 'start':
        // Use the host's tuning, then rebuild the static world from the seed.
        applyConfig(msg.config);
        this.debug = msg.debug;
        this.players = msg.players;
        this.world = generateWorld(msg.seed);
        this.replicated = new ReplicatedCells();
        this.ready = false;
        this.lastView = null;
        this.worldVersion++;
        if (!this.started) {
          this.started = true;
          this.onStart();
        }
        break;
      case 'inspect':
        this.hover = msg.cell;
        break;
      case 'stats':
        this.totals = { water: msg.water, cells: msg.cells };
        this.isPaused = msg.paused;
        break;
      case 'me':
        this.myDna = msg.dna;
        this.mySpecies = msg.species;
        break;
      case 'board':
        this.boardEntries = msg.entries;
        break;
      case 'event':
        this.feedItems.push({ text: msg.text, color: msg.color, at: performance.now() });
        if (this.feedItems.length > FEED.maxItems) this.feedItems.shift();
        break;
      case 'notice':
        this.noticeText = msg.text;
        this.noticeUntil = performance.now() + 3000;
        break;
      case 'host-left':
        this.onEnd('The host left the game.');
        break;
    }
  }

  private onBinary(buf: ArrayBuffer): void {
    if (!this.world || !this.replicated) return;
    const now = performance.now();
    const tag = tagOf(buf);
    if (tag === Tag.Snapshot) {
      const snap = decodeSnapshot(buf);
      this.worldTime = snap.time;
      this.world.nutrient.set(snap.water);
      this.replicated.applyEvents(snap.records, now);
      this.ready = true;
      return;
    }
    // Deltas only make sense on top of a snapshot.
    if (!this.ready) return;
    if (tag === Tag.Events) {
      this.replicated.applyEvents(decodeEvents(buf), now);
    } else if (tag === Tag.Nutrient) {
      const pairs = decodeNutrient(buf);
      for (let k = 0; k < pairs.length; k += 2) this.world.nutrient[pairs[k]] = pairs[k + 1];
    } else if (tag === Tag.Positions) {
      const cells = this.replicated;
      const update = decodePositions(buf, (r) => {
        if (cells.cellType[r.id] === CellType.None) return;
        cells.moveTo(r.id, r.x, r.y, now);
        cells.cellAngle[r.id] = r.angle;
        cells.cellEnergy[r.id] = r.energyFraction * energyCap(cells.cellType[r.id]);
        cells.cellNutrient[r.id] = r.nutrient;
        cells.cellDrained[r.id] = r.drained;
        cells.cellFiring[r.id] = r.firing;
        cells.cellSignal[r.id] = r.signal;
      });
      this.worldTime = update.time;
      cells.wires = update.wires;
    }
  }

  stop(): void {
    this.conn.close();
  }

  // ------------------------------------------------------------- GameSource

  cells(now: number): RenderCells | null {
    if (!this.ready || !this.replicated) return null;
    this.replicated.update(now);
    return this.replicated;
  }

  water(): Uint32Array | null {
    return this.ready ? this.world!.nutrient : null;
  }

  time(): number {
    return this.worldTime;
  }

  paused(): boolean {
    return this.isPaused;
  }

  hoverInfo(): CellInfo | null {
    return this.hover && this.hover.id === this.hoverId ? this.hover : null;
  }

  setHover(id: number): void {
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.hover = null;
    this.conn.send({ t: 'inspect', id });
  }

  /** Sends the camera view to the host when it changes, at most viewSendHz times per second. */
  setView(v: ViewRect): void {
    const now = performance.now();
    const l = this.lastView;
    if (l && l.x === v.x && l.y === v.y && l.w === v.w && l.h === v.h) return;
    if (now - this.lastViewSent < 1000 / NETWORK.viewSendHz) return;
    this.lastView = { ...v };
    this.lastViewSent = now;
    this.conn.send({ t: 'view', ...v });
  }

  stepMs(): number | null {
    return null;
  }

  stats(): { water: number; cells: number } | null {
    return this.debug ? this.totals : null;
  }

  readonly designsVersion = 0;

  /** Sends this player's saved designs to the host, which can spawn them in debug mode. */
  shareDesigns(designs: Design[]): void {
    this.conn.send({ t: 'designs', designs });
  }

  spawnChoices(): SpawnChoice[] {
    return [];
  }

  reroll(): void {}
  spawn(): void {}
  togglePause(): void {}
  step(): void {}
  setSpeed(): void {}

  notice(): string {
    return performance.now() < this.noticeUntil ? this.noticeText : '';
  }

  /** Asks the host to release one organism; the host checks and spends this player's DNA. */
  releaseDesign(design: Design, x: number, y: number): void {
    this.conn.send({ t: 'release', design, x, y });
  }

  dna(): number | null {
    return this.myDna;
  }

  species(): SpeciesInfo[] {
    return this.mySpecies;
  }

  board(): BoardEntry[] {
    return this.boardEntries;
  }

  feed(): FeedItem[] {
    return this.feedItems;
  }

  playerColor(owner: number): number {
    return this.players.find((p) => p.id === owner)?.color ?? 0x8899aa;
  }
}
