import { DEPTH, LIGHT, NUTRIENT, NUTRIENT_FLOW, SIM, TEMPERATURE, VENTS, WORLD } from '../config';
import { generateCurrents } from './currents';
import { createNoise2D, fbm } from './noise';
import { createRng } from './rng';

/** World state as flat typed arrays indexed by `y * width + x`. DOM-free. */
export interface World {
  seed: number;
  width: number;
  height: number;
  /** Seconds of world time elapsed. */
  time: number;
  /** Meters. */
  depth: Float32Array;
  /** °C. */
  temperature: Float32Array;
  /** exp(-k * depth), fixed per cell. */
  attenuation: Float32Array;
  /** daylight(time) * attenuation, in [0, 1]. Updated by stepWorld. */
  light: Float32Array;
  /** Nutrient dissolved in water, integer units. Carried by currents (see stepNutrientFlow). */
  nutrient: Uint32Array;
  /** Water current per tile: direction in radians. */
  currentDir: Float32Array;
  /** Water current per tile: strength in world units per second. */
  currentStrength: Float32Array;
  /** Water current per tile as a velocity (world units per second). */
  currentVx: Float32Array;
  currentVy: Float32Array;
  /** Hydrothermal vent strength per tile, 0 to 1 (feeds Chemosynth cells). */
  chem: Float32Array;
}

export function generateWorld(seed: number): World {
  const { width, height } = WORLD;
  const n = width * height;
  const rng = createRng(seed);
  const noise = createNoise2D(rng);

  // Depth: fBm normalized to the full [min, max] range.
  const depth = new Float32Array(n);
  const ox = rng() * 1000;
  const oy = rng() * 1000;
  let lo = Infinity;
  let hi = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = fbm(
        noise,
        ox + x * DEPTH.noiseScale,
        oy + y * DEPTH.noiseScale,
        DEPTH.octaves,
        DEPTH.persistence,
        DEPTH.lacunarity,
      );
      depth[y * width + x] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  const range = hi - lo || 1;
  for (let i = 0; i < n; i++) {
    depth[i] = DEPTH.min + ((depth[i] - lo) / range) * (DEPTH.max - DEPTH.min);
  }

  // Temperature: radial gradient, warmest at center, coldest at the corners,
  // and colder in deep water.
  const temperature = new Float32Array(n);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - cx) / cx;
      const dy = (y - cy) / cy;
      const r = Math.min(1, Math.sqrt(dx * dx + dy * dy) / Math.SQRT2);
      const i = y * width + x;
      const deep = (depth[i] - DEPTH.min) / (DEPTH.max - DEPTH.min);
      temperature[i] = TEMPERATURE.center + (TEMPERATURE.edge - TEMPERATURE.center) * r - TEMPERATURE.depthCooling * deep;
    }
  }

  const attenuation = new Float32Array(n);
  for (let i = 0; i < n; i++) attenuation[i] = Math.exp(-LIGHT.attenuation * depth[i]);

  // Nutrient: fixed integer total spread evenly. Cell i gets the integer step
  // of floor(i * total / n), so the remainder is interleaved and the sum is exact.
  const nutrient = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    nutrient[i] = Math.floor(((i + 1) * NUTRIENT.total) / n) - Math.floor((i * NUTRIENT.total) / n);
  }

  const currents = generateCurrents(rng, width, height);
  const chem = generateVents(rng, width, height, depth);

  const world: World = {
    seed,
    width,
    height,
    time: LIGHT.startPhase * LIGHT.dayLengthSec,
    depth,
    temperature,
    attenuation,
    light: new Float32Array(n),
    nutrient,
    currentDir: currents.dir,
    currentStrength: currents.strength,
    currentVx: currents.vx,
    currentVy: currents.vy,
    chem,
  };
  updateLight(world);
  return world;
}

/**
 * A few rare vents in deep water, spread apart. Each is a Gaussian spot of
 * strength 1 at its center; where vents overlap the stronger one counts.
 */
function generateVents(rng: () => number, width: number, height: number, depth: Float32Array): Float32Array {
  const chem = new Float32Array(width * height);
  const minDepth = DEPTH.min + VENTS.minDepthFraction * (DEPTH.max - DEPTH.min);
  const vents: [number, number][] = [];
  for (let a = 0; a < VENTS.attempts && vents.length < VENTS.count; a++) {
    const x = Math.floor(rng() * width);
    const y = Math.floor(rng() * height);
    if (depth[y * width + x] < minDepth) continue;
    if (vents.some(([vx, vy]) => Math.hypot(vx - x, vy - y) < VENTS.minSpacing)) continue;
    vents.push([x, y]);
  }
  const R = VENTS.radius;
  const reach = Math.ceil(R * 3);
  for (const [vx, vy] of vents) {
    for (let y = Math.max(0, vy - reach); y <= Math.min(height - 1, vy + reach); y++) {
      for (let x = Math.max(0, vx - reach); x <= Math.min(width - 1, vx + reach); x++) {
        const v = Math.exp(-((x - vx) ** 2 + (y - vy) ** 2) / (R * R));
        const i = y * width + x;
        if (v > 0.01 && v > chem[i]) chem[i] = v;
      }
    }
  }
  return chem;
}

/**
 * Currents carry nutrient: integer donor-cell advection plus slow diffusion.
 * Every tile sends whole units to its 4 neighbors, computed from a snapshot
 * (`scratch`), so every unit taken from one tile is added to another and the
 * total never changes. Fractions round up or down by chance. Nothing flows
 * out of the world.
 */
export function stepNutrientFlow(world: World, scratch: Uint32Array, rng: () => number): void {
  const { width, height, nutrient, currentVx, currentVy } = world;
  const seconds = NUTRIENT_FLOW.intervalTicks / SIM.tickHz;
  const k = seconds / WORLD.tileSize;
  const diff = NUTRIENT_FLOW.diffusion;
  scratch.set(nutrient);
  const units = (n: number, f: number) => {
    const amount = n * f;
    const whole = Math.floor(amount);
    return whole + (rng() < amount - whole ? 1 : 0);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const n = scratch[i];
      if (n === 0) continue;
      const fx = currentVx[i] * k;
      const fy = currentVy[i] * k;
      // Fractions toward right, left, down, up (zero where that neighbor is outside the world).
      let r = x < width - 1 ? Math.max(0, fx) + diff : 0;
      let l = x > 0 ? Math.max(0, -fx) + diff : 0;
      let d = y < height - 1 ? Math.max(0, fy) + diff : 0;
      let u = y > 0 ? Math.max(0, -fy) + diff : 0;
      const total = r + l + d + u;
      if (total > NUTRIENT_FLOW.maxOutflow) {
        const s = NUTRIENT_FLOW.maxOutflow / total;
        r *= s;
        l *= s;
        d *= s;
        u *= s;
      }
      let left = n;
      let m = 0;
      if (r > 0 && (m = Math.min(left, units(n, r))) > 0) {
        nutrient[i + 1] += m;
        left -= m;
      }
      if (l > 0 && (m = Math.min(left, units(n, l))) > 0) {
        nutrient[i - 1] += m;
        left -= m;
      }
      if (d > 0 && (m = Math.min(left, units(n, d))) > 0) {
        nutrient[i + width] += m;
        left -= m;
      }
      if (u > 0 && (m = Math.min(left, units(n, u))) > 0) {
        nutrient[i - width] += m;
        left -= m;
      }
      nutrient[i] -= n - left;
    }
  }
}

/** Fraction of the day in [0, 1): 0 = midnight, 0.5 = noon. */
export function dayPhase(time: number): number {
  const p = (time / LIGHT.dayLengthSec) % 1;
  return p < 0 ? p + 1 : p;
}

/** Surface light in [nightDaylight, 1], smooth over the day. */
export function daylight(time: number): number {
  const sun = 0.5 - 0.5 * Math.cos(2 * Math.PI * dayPhase(time));
  return LIGHT.nightDaylight + (1 - LIGHT.nightDaylight) * sun;
}

export function updateLight(world: World): void {
  const d = daylight(world.time);
  const { light, attenuation } = world;
  for (let i = 0; i < light.length; i++) light[i] = d * attenuation[i];
}

export function stepWorld(world: World, dt: number): void {
  world.time += dt;
  updateLight(world);
}

/** Sum of all nutrient in the world. Must always equal NUTRIENT.total. */
export function totalNutrient(world: World): number {
  let sum = 0;
  for (let i = 0; i < world.nutrient.length; i++) sum += world.nutrient[i];
  return sum;
}
