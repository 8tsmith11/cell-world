import { DNA, FEED, LEADERBOARD, LINEAGE, NETWORK, PLAYERS } from '../config';
import type { BoardEntry, FeedItem, GameSource, RenderCells, SpawnChoice, SpeciesInfo, StaticWorld, ViewRect } from '../game-source';
import { BUILTIN_DESIGNS, type Design, releaseCost, validateDesign } from '../sim/genome';
import type { LineageReport, ReleaseResult } from '../sim/protocol';
import type { LineageStats } from '../sim/lineages';
import { CATEGORIES, leaders } from './leaderboard';
import type { CellInfo, FrameMsg, FromWorker, ToWorker } from '../sim/protocol';
import { CellType } from '../sim/sim';
import { encodeEvents, encodeNutrient, encodePositions, encodeSnapshot } from './codec';
import { exportConfig } from './config-sync';
import type { ClientMsg, Player, RelayConnection, RelayMsg } from './relay';

const randomSeed = () => (Math.random() * 2 ** 32) >>> 0;

/**
 * The host's browser: runs the authoritative simulation in a worker and streams
 * changes to clients through the relay.
 */
export class HostSession implements GameSource {
  readonly isHost = true;
  readonly selfId = 0;
  debug = false;
  started = false;
  players: Player[];
  worldVersion = 0;
  world: StaticWorld | null = null;

  /** Called whenever the player list changes (for the lobby screen). */
  onLobby: () => void = () => {};
  onEnd: (reason: string) => void = () => {};

  private worker: Worker | null = null;
  private frame: FrameMsg | null = null;
  private views = new Map<number, ViewRect>();
  private hovers = new Map<number, number>();
  /** Clients that need the start message and a full snapshot on the next frame. */
  private pending = new Set<number>();
  /** Water nutrient as of the last diff sent; diffs carry absolute values. */
  private lastSentWater: Uint32Array | null = null;
  /** Latest water nutrient from the worker (it arrives every few frames). */
  private latestWater: Uint32Array | null = null;
  private isPaused = false;
  private noticeText = '';
  private noticeUntil = 0;
  private timers: number[] = [];
  /** Saved designs shared by each player (the host's own under id 0). */
  private designs = new Map<number, Design[]>();
  designsVersion = 0;

  // Competition state (authoritative here).
  private dnaBy = new Map<number, number>();
  /** Names of everyone who has played, kept after they leave (lineage names use them). */
  private playerNames = new Map<number, string>();
  private lineageStats = new Map<number, LineageStats>();
  private boardEntries: BoardEntry[] = [];
  /** Per category: the announced leader, and a challenger with the time it took the lead. */
  private announced: (number | null)[] = CATEGORIES.map(() => null);
  private challenger: { lineage: number | null; since: number }[] = CATEGORIES.map(() => ({ lineage: null, since: 0 }));
  private feedItems: FeedItem[] = [];
  /** Releases waiting for the worker; their DNA is reserved and refunded on failure. */
  private releases = new Map<number, { player: number; cost: number; name: string }>();
  private nextReleaseId = 1;

  constructor(
    private conn: RelayConnection,
    name: string,
  ) {
    this.players = [{ id: 0, name, color: PLAYERS.colors[0] }];
    this.playerNames.set(0, name);
    this.dnaBy.set(0, DNA.start);
    conn.onJson = (msg) => this.onRelay(msg as RelayMsg);
    conn.onClose = (reason) => this.onEnd(reason);
  }

  private onRelay(msg: RelayMsg): void {
    switch (msg.t) {
      case 'peer-join': {
        if (this.players.length >= PLAYERS.maxPlayers) return;
        const used = new Set(this.players.map((p) => p.color));
        const color = PLAYERS.colors.find((c) => !used.has(c)) ?? PLAYERS.colors[msg.id % PLAYERS.colors.length];
        this.players.push({ id: msg.id, name: msg.name || `Player ${msg.id}`, color });
        this.playerNames.set(msg.id, msg.name || `Player ${msg.id}`);
        if (!this.dnaBy.has(msg.id)) this.dnaBy.set(msg.id, DNA.start);
        this.broadcastLobby();
        // Joining a running game: send seed, config and a snapshot on the next frame.
        if (this.started) this.pending.add(msg.id);
        break;
      }
      case 'peer-leave':
        this.players = this.players.filter((p) => p.id !== msg.id);
        this.views.delete(msg.id);
        this.hovers.delete(msg.id);
        this.pending.delete(msg.id);
        if (this.designs.delete(msg.id)) this.designsVersion++;
        this.updateInspect();
        this.broadcastLobby();
        break;
      case 'from':
        this.onClient(msg.id, msg.msg);
        break;
    }
  }

  private onClient(id: number, msg: ClientMsg): void {
    if (msg.t === 'view') this.views.set(id, { x: msg.x, y: msg.y, w: msg.w, h: msg.h });
    else if (msg.t === 'designs') {
      this.designs.set(id, (Array.isArray(msg.designs) ? msg.designs : []).filter((d) => validateDesign(d) === null));
      this.designsVersion++;
    }
    else if (msg.t === 'release') this.requestRelease(id, msg.design, msg.x, msg.y);
    else if (msg.t === 'inspect') {
      this.hovers.set(id, msg.id);
      this.updateInspect();
    }
  }

  private broadcastLobby(): void {
    this.conn.sendTo(null, { t: 'lobby', players: this.players });
    this.onLobby();
  }

  // ------------------------------------------------------------- game

  start(): void {
    if (this.started) return;
    this.started = true;
    this.worker = new Worker(new URL('../sim/worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onWorker(e.data);
    this.toWorker({ type: 'generate', seed: randomSeed() });
    for (const p of this.players) if (p.id !== 0) this.pending.add(p.id);

    const every = (hz: number, fn: () => void) => this.timers.push(window.setInterval(fn, 1000 / hz));
    every(NETWORK.positionHz, () => this.sendPositions());
    every(1 / NETWORK.nutrientIntervalSec, () => this.sendNutrientDiff());
    every(NETWORK.inspectHz, () => this.sendInspect());
    every(NETWORK.statsHz, () => this.sendStats());
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.worker?.terminate();
    this.conn.close();
  }

  private toWorker(msg: ToWorker): void {
    this.worker?.postMessage(msg);
  }

  private onWorker(msg: FromWorker): void {
    if (msg.type === 'world') {
      this.world = msg;
      this.worldVersion++;
      this.frame = null;
      this.lastSentWater = null;
      this.latestWater = null;
      // A new world starts with no lineages.
      this.lineageStats.clear();
      this.announced = CATEGORIES.map(() => null);
      this.challenger = CATEGORIES.map(() => ({ lineage: null, since: 0 }));
      // A new world: every client needs the new seed and a fresh snapshot.
      for (const p of this.players) if (p.id !== 0) this.pending.add(p.id);
    } else if (msg.type === 'frame') {
      this.frame = msg;
      if (msg.waterNutrient) this.latestWater = msg.waterNutrient;
      this.isPaused = msg.paused;
      if (this.pending.size > 0 && this.latestWater) this.sendSnapshots(msg);
      if (msg.events.length > 0) this.conn.sendBinaryTo(null, encodeEvents(msg.events));
    } else if (msg.type === 'released') {
      this.onReleased(msg);
    } else if (msg.type === 'lineages') {
      this.onLineages(msg);
    }
  }

  // ------------------------------------------------------------- releasing and DNA

  /** Checks and reserves DNA, then asks the worker to release. The cost is refunded if the release fails. */
  private requestRelease(player: number, design: Design, x: number, y: number, free = false): void {
    if (!this.started || validateDesign(design) !== null) return;
    const cost = free ? 0 : releaseCost(design);
    const dna = this.dnaBy.get(player) ?? 0;
    if (dna < cost) {
      this.notify(player, `Not enough DNA to release ${design.name}: it costs ${cost}.`);
      return;
    }
    this.dnaBy.set(player, dna - cost);
    const id = this.nextReleaseId++;
    this.releases.set(id, { player, cost, name: design.name });
    this.toWorker({ type: 'release', id, design, owner: player, x, y });
  }

  private onReleased(msg: ReleaseResult): void {
    const r = this.releases.get(msg.id);
    if (!r) return;
    this.releases.delete(msg.id);
    if (!msg.ok) {
      this.dnaBy.set(r.player, (this.dnaBy.get(r.player) ?? 0) + r.cost);
      this.notify(r.player, `Couldn't release ${r.name}: ${msg.reason}. No DNA spent.`);
    } else if (!this.lineageStats.has(msg.lineage)) {
      // Know a new lineage's name right away; full stats arrive with the next report.
      this.lineageStats.set(msg.lineage, {
        id: msg.lineage,
        owner: r.player,
        design: r.name,
        biomass: 0,
        organisms: 1,
        largest: 1,
        energy: 0,
        trophic: 1,
        ageSec: 0,
        extinct: false,
      });
    }
    this.sendMe(r.player);
  }

  private notify(player: number, text: string): void {
    if (player === 0) {
      this.noticeText = text;
      this.noticeUntil = performance.now() + 3000;
    } else {
      this.conn.sendTo(player, { t: 'notice', text });
    }
  }

  lineageName(id: number): string {
    const l = this.lineageStats.get(id);
    if (!l) return `lineage ${id}`;
    return `${this.playerNames.get(l.owner) ?? `Player ${l.owner}`}'s ${l.design}`;
  }

  playerColor(owner: number): number {
    return this.players.find((p) => p.id === owner)?.color ?? 0x8899aa;
  }

  private colorOfLineage(id: number): number {
    const l = this.lineageStats.get(id);
    return l ? this.playerColor(l.owner) : 0x8899aa;
  }

  private pushEvent(text: string, color: number): void {
    this.feedItems.push({ text, color, at: performance.now() });
    if (this.feedItems.length > FEED.maxItems) this.feedItems.shift();
    this.conn.sendTo(null, { t: 'event', text, color });
  }

  /** Every LINEAGE.statsIntervalSec: DNA income, extinction news, leaderboard, and each player's own panel. */
  private onLineages(report: LineageReport): void {
    for (const l of report.stats) this.lineageStats.set(l.id, l);

    // DNA from biomass (nutrient in each player's living cells).
    const biomass = new Map<number, number>();
    for (const l of report.stats) if (!l.extinct) biomass.set(l.owner, (biomass.get(l.owner) ?? 0) + l.biomass);
    for (const p of this.players) {
      const gain = (biomass.get(p.id) ?? 0) * DNA.perBiomassPerSecond * LINEAGE.statsIntervalSec;
      this.dnaBy.set(p.id, (this.dnaBy.get(p.id) ?? DNA.start) + gain);
    }

    for (const e of report.extinctions) {
      const text =
        e.killer !== null ? `${this.lineageName(e.killer)} drove ${this.lineageName(e.lineage)} extinct.` : `${this.lineageName(e.lineage)} died out.`;
      this.pushEvent(text, this.colorOfLineage(e.killer ?? e.lineage));
    }

    // Leaderboard, announcing a new leader once it has held the spot for a moment.
    const now = performance.now();
    const top = leaders(report.stats);
    this.boardEntries = CATEGORIES.map((c, k) => {
      const l = top[k];
      return { category: c.name, lineage: l ? this.lineageName(l.id) : '', color: l ? this.playerColor(l.owner) : 0, value: l ? c.format(l) : '' };
    });
    CATEGORIES.forEach((c, k) => {
      const id = top[k]?.id ?? null;
      const ch = this.challenger[k];
      if (id !== ch.lineage) {
        ch.lineage = id;
        ch.since = now;
      }
      if (id !== null && id !== this.announced[k] && now - ch.since >= LEADERBOARD.changeConfirmSec * 1000) {
        this.announced[k] = id;
        this.pushEvent(`${this.lineageName(id)} is the new ${c.name}.`, this.colorOfLineage(id));
      }
    });
    this.conn.sendTo(null, { t: 'board', entries: this.boardEntries });
    for (const p of this.players) if (p.id !== 0) this.sendMe(p.id);
  }

  private speciesOf(player: number): SpeciesInfo[] {
    const out: SpeciesInfo[] = [];
    for (const l of this.lineageStats.values()) {
      if (l.owner === player) out.push({ name: this.lineageName(l.id), organisms: l.organisms, extinct: l.extinct });
    }
    return out.sort((a, b) => Number(a.extinct) - Number(b.extinct) || b.organisms - a.organisms);
  }

  private sendMe(player: number): void {
    if (player === 0) return;
    this.conn.sendTo(player, { t: 'me', dna: this.dnaBy.get(player) ?? 0, species: this.speciesOf(player) });
  }

  private sendSnapshots(frame: FrameMsg): void {
    // Bring every connected client's nutrient baseline up to this frame first,
    // so diffs after the snapshot stay consistent for old and new clients alike.
    this.sendNutrientDiff();
    const start = { t: 'start' as const, seed: this.world!.seed, config: exportConfig(), debug: this.debug, players: this.players };
    // New clients start from the same water baseline the others hold.
    const snapshot = encodeSnapshot({ ...frame, waterNutrient: (this.lastSentWater ?? this.latestWater)! });
    for (const id of this.pending) {
      this.conn.sendTo(id, start);
      this.conn.sendBinaryTo(id, snapshot);
      // Their DNA and species right away, and the current leaderboard.
      this.sendMe(id);
      this.conn.sendTo(id, { t: 'board', entries: this.boardEntries });
    }
    this.pending.clear();
  }

  /**
   * Sends water tiles that changed noticeably since they were last sent: by at
   * least NETWORK.nutrientDiffMin, or reaching or leaving zero. Currents move
   * nutrient everywhere, so tiny changes are left out to save bandwidth.
   */
  private sendNutrientDiff(): void {
    const water = this.latestWater;
    if (!water) return;
    const sent = this.lastSentWater;
    if (!sent) {
      this.lastSentWater = water.slice();
      return;
    }
    const pairs: number[] = [];
    for (let i = 0; i < water.length; i++) {
      const v = water[i];
      const old = sent[i];
      if (v === old) continue;
      if (Math.abs(v - old) >= NETWORK.nutrientDiffMin || v === 0 || old === 0) {
        pairs.push(i, v);
        sent[i] = v;
      }
    }
    if (pairs.length > 0) this.conn.sendBinaryTo(null, encodeNutrient(pairs));
  }

  stepMs(): number | null {
    return this.frame?.stepMs ?? null;
  }

  /** Each client gets positions only for cells in or near its camera view, plus the time of day. */
  private sendPositions(): void {
    const f = this.frame;
    if (!f) return;
    const m = NETWORK.viewMargin;
    for (const p of this.players) {
      if (p.id === 0) continue;
      const v = this.views.get(p.id);
      const ids: number[] = [];
      if (v) {
        for (let i = 0; i < f.cellCount; i++) {
          if (f.cellType[i] === CellType.None) continue;
          const x = f.cellX[i];
          const y = f.cellY[i];
          if (x >= v.x - m && x <= v.x + v.w + m && y >= v.y - m && y <= v.y + v.h + m) ids.push(i);
        }
      }
      this.conn.sendBinaryTo(p.id, encodePositions(f.time, f, ids));
    }
  }

  private updateInspect(): void {
    const ids = [...new Set([...this.hovers.values()].filter((id) => id >= 0))];
    this.toWorker({ type: 'inspect', ids });
  }

  private inspectFor(id: number): CellInfo | null {
    if (id < 0 || !this.frame) return null;
    const info = this.frame.inspect.find((c) => c.id === id) ?? null;
    // Add the lineage's display name for hover info.
    if (info?.org) info.org.lineageName = this.lineageName(info.org.lineage);
    return info;
  }

  private sendInspect(): void {
    for (const [player, id] of this.hovers) {
      if (player !== 0 && id >= 0) this.conn.sendTo(player, { t: 'inspect', cell: this.inspectFor(id) });
    }
  }

  private sendStats(): void {
    if (!this.debug || !this.frame) return;
    this.conn.sendTo(null, { t: 'stats', water: this.frame.waterNutrientTotal, cells: this.frame.cellNutrientTotal, paused: this.isPaused });
  }

  // ------------------------------------------------------------- GameSource

  cells(): RenderCells | null {
    return this.frame;
  }

  water(): Uint32Array | null {
    return this.latestWater;
  }

  time(): number {
    return this.frame?.time ?? 0;
  }

  paused(): boolean {
    return this.isPaused;
  }

  hoverInfo(): CellInfo | null {
    return this.inspectFor(this.hovers.get(0) ?? -1);
  }

  setHover(id: number): void {
    if (this.hovers.get(0) === id) return;
    this.hovers.set(0, id);
    this.updateInspect();
  }

  setView(): void {}

  stats(): { water: number; cells: number } | null {
    if (!this.debug || !this.frame) return null;
    return { water: this.frame.waterNutrientTotal, cells: this.frame.cellNutrientTotal };
  }

  reroll(): void {
    if (this.debug) this.toWorker({ type: 'generate', seed: randomSeed() });
  }

  /** Debug: a free release of any player's design, owned by that player. */
  spawn(choice: SpawnChoice, x: number, y: number): void {
    if (this.debug) this.requestRelease(choice.owner, choice.design, x, y, true);
  }

  releaseDesign(design: Design, x: number, y: number): void {
    this.requestRelease(0, design, x, y);
  }

  dna(): number | null {
    return this.dnaBy.get(0) ?? 0;
  }

  species(): SpeciesInfo[] {
    return this.speciesOf(0);
  }

  board(): BoardEntry[] {
    return this.boardEntries;
  }

  feed(): FeedItem[] {
    return this.feedItems;
  }

  spawnChoices(): SpawnChoice[] {
    const out: SpawnChoice[] = BUILTIN_DESIGNS.map((design) => ({ label: design.name, owner: 0, design }));
    for (const p of this.players) {
      for (const design of this.designs.get(p.id) ?? []) out.push({ label: `${p.name}: ${design.name}`, owner: p.id, design });
    }
    return out;
  }

  shareDesigns(designs: Design[]): void {
    this.designs.set(0, structuredClone(designs));
    this.designsVersion++;
  }

  togglePause(): void {
    if (!this.debug) return;
    this.isPaused = !this.isPaused;
    this.toWorker({ type: 'pause', paused: this.isPaused });
  }

  step(): void {
    if (this.debug) this.toWorker({ type: 'step' });
  }

  setSpeed(speed: number): void {
    if (this.debug) this.toWorker({ type: 'speed', speed });
  }

  notice(): string {
    return performance.now() < this.noticeUntil ? this.noticeText : '';
  }
}
