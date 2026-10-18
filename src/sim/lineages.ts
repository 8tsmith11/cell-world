// Lineages: who owns what, energy flows between lineages (for trophic levels),
// deaths (for extinction credit), and per-lineage stats. DOM-free.
import { LINEAGE, SIM } from '../config';

export interface LineageStats {
  id: number;
  owner: number;
  /** Design name; the host shows it as "<player>'s <design>". */
  design: string;
  /** Nutrient in living cells. */
  biomass: number;
  /** Living organisms. */
  organisms: number;
  /** Most cells in one living organism. */
  largest: number;
  /** Total stored energy in living cells. */
  energy: number;
  trophic: number;
  /** Seconds since the lineage started (continuous survival while alive). */
  ageSec: number;
  extinct: boolean;
}

/** killer: lineage credited with most of its deaths in the final stretch, or null if it mostly starved. */
export interface ExtinctionEvent {
  lineage: number;
  killer: number | null;
}

/** What the lineage pass needs from the simulation. */
export interface LineageSource {
  cellCount: number;
  alive: Uint8Array;
  type: Uint8Array;
  organism: Int32Array;
  cellLineage: Int32Array;
  bodyNutrient: Uint32Array;
  storedNutrient: Uint32Array;
  energy: Float32Array;
  orgCells: Int32Array;
}

const STARVED = -1;

export class Lineages {
  readonly owner = new Int32Array(LINEAGE.maxLineages).fill(-1);
  readonly design: string[] = [];
  readonly bornTick = new Int32Array(LINEAGE.maxLineages);
  readonly extinct = new Uint8Array(LINEAGE.maxLineages);
  readonly trophic = new Float64Array(LINEAGE.maxLineages).fill(1);
  /** Next unused id; id 0 is never used. */
  count = 1;
  /** Live lineage for each (owner, design name). */
  private active = new Map<string, number>();
  /** Energy gained from light, per lineage, over the recent (decaying) window. */
  private light = new Float64Array(LINEAGE.maxLineages);
  /** Energy gained by predator lineage from prey lineage, over the recent window. Key: pred * max + prey. */
  private eaten = new Map<number, number>();
  /** Recent deaths per lineage: [tick, killer lineage or STARVED]. */
  private deaths = new Map<number, [number, number][]>();

  /**
   * The lineage a release of this design joins: the first release of a design
   * starts a lineage; later releases join it while it survives.
   */
  forRelease(owner: number, designName: string, tick: number): number {
    const key = `${owner}\u0000${designName}`;
    const live = this.active.get(key);
    if (live !== undefined && !this.extinct[live]) return live;
    if (this.count >= LINEAGE.maxLineages) return -1;
    const id = this.count++;
    this.owner[id] = owner;
    this.design[id] = designName;
    this.bornTick[id] = tick;
    this.extinct[id] = 0;
    this.trophic[id] = 1;
    this.active.set(key, id);
    return id;
  }

  creditLight(lineage: number, energy: number): void {
    if (lineage > 0) this.light[lineage] += energy;
  }

  creditPrey(predator: number, prey: number, energy: number): void {
    if (predator <= 0 || prey <= 0 || energy <= 0) return;
    const key = predator * LINEAGE.maxLineages + prey;
    this.eaten.set(key, (this.eaten.get(key) ?? 0) + energy);
  }

  /** killer: the lineage that ate it or spiked it to death, or -1 if it starved. */
  recordDeath(victim: number, killer: number, tick: number): void {
    if (victim <= 0) return;
    let list = this.deaths.get(victim);
    if (!list) this.deaths.set(victim, (list = []));
    list.push([tick, killer]);
  }

  /** Per-lineage stats, trophic levels, and extinctions since the last call. */
  update(sim: LineageSource, tick: number): { stats: LineageStats[]; extinctions: ExtinctionEvent[] } {
    const n = this.count;
    const living = new Int32Array(n);
    const biomass = new Float64Array(n);
    const energy = new Float64Array(n);
    const orgsSeen = new Map<number, number>(); // organism -> lineage
    for (let i = 0; i < sim.cellCount; i++) {
      if (!sim.alive[i]) continue;
      const l = sim.cellLineage[i];
      if (l <= 0 || l >= n) continue;
      living[l]++;
      biomass[l] += sim.bodyNutrient[i] + sim.storedNutrient[i];
      energy[l] += sim.energy[i];
      orgsSeen.set(sim.organism[i], l);
    }
    const organisms = new Int32Array(n);
    const largest = new Int32Array(n);
    for (const [o, l] of orgsSeen) {
      organisms[l]++;
      largest[l] = Math.max(largest[l], sim.orgCells[o]);
    }

    // Extinctions: no living cells left.
    const extinctions: ExtinctionEvent[] = [];
    const windowStart = tick - LINEAGE.extinctionWindowSec * SIM.tickHz;
    for (const [victim, list] of this.deaths) {
      while (list.length && list[0][0] < windowStart) list.shift();
      if (!list.length) this.deaths.delete(victim);
    }
    for (let l = 1; l < n; l++) {
      if (this.extinct[l] || living[l] > 0) continue;
      this.extinct[l] = 1;
      this.active.delete(`${this.owner[l]}\u0000${this.design[l]}`);
      const tally = new Map<number, number>();
      for (const [, killer] of this.deaths.get(l) ?? []) tally.set(killer, (tally.get(killer) ?? 0) + 1);
      let killer: number | null = null;
      let best = 0;
      for (const [k, c] of tally) {
        if (k !== STARVED && c > best) {
          best = c;
          killer = k;
        }
      }
      // "Mostly starved" wins ties.
      if (killer !== null && (tally.get(STARVED) ?? 0) >= best) killer = null;
      extinctions.push({ lineage: l, killer });
      this.deaths.delete(l);
    }

    this.updateTrophic();

    // Fade the window.
    const fade = Math.exp(-LINEAGE.statsIntervalSec / LINEAGE.trophicWindowSec);
    for (let l = 1; l < n; l++) this.light[l] *= fade;
    for (const [k, v] of this.eaten) {
      if (v * fade < 1e-3) this.eaten.delete(k);
      else this.eaten.set(k, v * fade);
    }

    // Extinct lineages stay listed: the owner's species panel shows them.
    const stats: LineageStats[] = [];
    for (let l = 1; l < n; l++) {
      stats.push({
        id: l,
        owner: this.owner[l],
        design: this.design[l],
        biomass: biomass[l],
        organisms: organisms[l],
        largest: largest[l],
        energy: energy[l],
        trophic: this.trophic[l],
        ageSec: (tick - this.bornTick[l]) / SIM.tickHz,
        extinct: this.extinct[l] === 1,
      });
    }
    return { stats, extinctions };
  }

  /**
   * Producers (energy from light) are level 1; energy eaten from a prey lineage
   * counts as 1 + that lineage's level. A lineage's level is the
   * energy-weighted average over the recent window, so pure consumers are
   * 1 + the average level of what they eat. Lineages with no recent income
   * keep their last level.
   */
  private updateTrophic(): void {
    const n = this.count;
    const incoming = new Map<number, [number, number][]>(); // pred -> [prey, energy]
    for (const [k, e] of this.eaten) {
      const pred = Math.floor(k / LINEAGE.maxLineages);
      const prey = k % LINEAGE.maxLineages;
      let list = incoming.get(pred);
      if (!list) incoming.set(pred, (list = []));
      list.push([prey, e]);
    }
    const level = this.trophic;
    for (let iter = 0; iter < 30; iter++) {
      for (let l = 1; l < n; l++) {
        const prey = incoming.get(l);
        let weight = this.light[l];
        let sum = this.light[l];
        for (const [p, e] of prey ?? []) {
          weight += e;
          sum += e * (1 + level[p]);
        }
        if (weight > 1e-6) level[l] = Math.min(LINEAGE.trophicMax, sum / weight);
      }
    }
  }
}
