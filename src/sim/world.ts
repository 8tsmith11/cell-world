import { DEPTH, LIGHT, NUTRIENT, TEMPERATURE, WORLD } from '../config';
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
  /** Nutrient dissolved in water, integer units. Never moved by currents. */
  nutrient: Uint32Array;
  /** Water current per tile: direction in radians. */
  currentDir: Float32Array;
  /** Water current per tile: strength in world units per second. */
  currentStrength: Float32Array;
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

  // Temperature: radial gradient, warmest at center, coldest at the corners.
  const temperature = new Float32Array(n);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - cx) / cx;
      const dy = (y - cy) / cy;
      const r = Math.min(1, Math.sqrt(dx * dx + dy * dy) / Math.SQRT2);
      temperature[y * width + x] = TEMPERATURE.center + (TEMPERATURE.edge - TEMPERATURE.center) * r;
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
  };
  updateLight(world);
  return world;
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
