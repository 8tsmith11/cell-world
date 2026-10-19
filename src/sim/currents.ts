import { CURRENTS, WORLD } from '../config';
import { createNoise2D, fbm } from './noise';

/** Current per tile: direction (radians) and strength (world units per second), and the same as a velocity. */
export interface CurrentField {
  dir: Float32Array;
  strength: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
}

/** Builds the velocity form of a field sent as direction and strength. */
export function currentField(dir: Float32Array, strength: Float32Array): CurrentField {
  const vx = new Float32Array(dir.length);
  const vy = new Float32Array(dir.length);
  for (let i = 0; i < dir.length; i++) {
    vx[i] = Math.cos(dir[i]) * strength[i];
    vy[i] = Math.sin(dir[i]) * strength[i];
  }
  return { dir, strength, vx, vy };
}

/**
 * A handful of smooth streams along curved paths (some closed into large
 * loops) over a weak background drift. Each stream is a path stamped into the
 * grid as a soft band of flow along the path's tangent.
 */
export function generateCurrents(rng: () => number, width: number, height: number): CurrentField {
  const n = width * height;
  const vx = new Float32Array(n);
  const vy = new Float32Array(n);
  addCalmWater(rng, width, height, vx, vy);

  for (let s = 0; s < CURRENTS.streams; s++) {
    const speed = CURRENTS.streamSpeed * (CURRENTS.streamSpeedMin + (1 - CURRENTS.streamSpeedMin) * rng());
    if (rng() < CURRENTS.loopChance) {
      stampPath(loopPath(rng, width, height), true, speed, width, height, vx, vy);
    } else {
      stampPath(openPath(rng, width, height), false, speed, width, height, vx, vy);
    }
  }

  // Soft cap: where streams overlap, speed approaches maxSpeed instead of adding up.
  const dir = new Float32Array(n);
  const strength = new Float32Array(n);
  const cap = CURRENTS.maxSpeed;
  for (let i = 0; i < n; i++) {
    dir[i] = Math.atan2(vy[i], vx[i]);
    strength[i] = cap * Math.tanh(Math.hypot(vx[i], vy[i]) / cap);
  }
  return currentField(dir, strength);
}

/** Weak background drift: the curl of a noise stream function, faded to run parallel to edges. */
function addCalmWater(
  rng: () => number,
  width: number,
  height: number,
  vx: Float32Array,
  vy: Float32Array,
): void {
  const noise = createNoise2D(rng);
  const ox = rng() * 1000;
  const oy = rng() * 1000;
  const psi = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const e = Math.min(1, Math.min(x, y, width - 1 - x, height - 1 - y) / CURRENTS.edgeFalloff);
      const fade = e * e * (3 - 2 * e);
      psi[y * width + x] = fbm(noise, ox + x * CURRENTS.calmNoiseScale, oy + y * CURRENTS.calmNoiseScale, 3, 0.5, 2) * fade;
    }
  }
  const cx = new Float32Array(width * height);
  const cy = new Float32Array(width * height);
  let sum = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      cx[i] = (psi[Math.min(height - 1, y + 1) * width + x] - psi[Math.max(0, y - 1) * width + x]) / 2;
      cy[i] = -(psi[y * width + Math.min(width - 1, x + 1)] - psi[y * width + Math.max(0, x - 1)]) / 2;
      sum += Math.hypot(cx[i], cy[i]);
    }
  }
  // Scaled so the typical (mean) drift is calmSpeed, clamped so no calm spot gets stream-fast.
  const scale = CURRENTS.calmSpeed / Math.max(1e-9, sum / cx.length);
  const maxCalm = CURRENTS.calmSpeed * CURRENTS.calmMaxFactor;
  for (let i = 0; i < cx.length; i++) {
    let sx = cx[i] * scale;
    let sy = cy[i] * scale;
    const m = Math.hypot(sx, sy);
    if (m > maxCalm) {
      sx *= maxCalm / m;
      sy *= maxCalm / m;
    }
    vx[i] += sx;
    vy[i] += sy;
  }
}

type Path = { x: number[]; y: number[] };

/** A wandering open path, 1 tile per step, with smoothly varying curvature, steered away from edges. */
function openPath(rng: () => number, width: number, height: number): Path {
  const m = CURRENTS.edgeMargin;
  let x = m + rng() * (width - 2 * m);
  let y = m + rng() * (height - 2 * m);
  let heading = rng() * Math.PI * 2;
  let turn = 0;
  const length = CURRENTS.streamLengthMin + rng() * (CURRENTS.streamLengthMax - CURRENTS.streamLengthMin);
  const path: Path = { x: [], y: [] };
  for (let k = 0; k < length; k++) {
    path.x.push(x);
    path.y.push(y);
    turn += (rng() * 2 - 1) * CURRENTS.curveJitter;
    turn = Math.max(-CURRENTS.maxTurn, Math.min(CURRENTS.maxTurn, turn));
    // Near an edge, turn toward the world center.
    const edgeDist = Math.min(x, y, width - 1 - x, height - 1 - y);
    if (edgeDist < m) {
      const toCenter = Math.atan2(height / 2 - y, width / 2 - x);
      const diff = Math.atan2(Math.sin(toCenter - heading), Math.cos(toCenter - heading));
      heading += diff * CURRENTS.edgeSteer * (1 - edgeDist / m);
    }
    heading += turn;
    x += Math.cos(heading);
    y += Math.sin(heading);
  }
  return path;
}

/** A closed, gently wobbling loop that fits inside the edge margin. */
function loopPath(rng: () => number, width: number, height: number): Path {
  const m = CURRENTS.edgeMargin;
  const maxR = Math.max(4, Math.min(width, height) / 2 - m);
  const radius = Math.min(maxR, CURRENTS.loopRadiusMin + rng() * (CURRENTS.loopRadiusMax - CURRENTS.loopRadiusMin));
  const span = radius * (1 + CURRENTS.loopWobble) + m;
  const cx = span + rng() * Math.max(0, width - 2 * span);
  const cy = span + rng() * Math.max(0, height - 2 * span);
  const spin = rng() < 0.5 ? 1 : -1;
  const p2 = rng() * Math.PI * 2;
  const p3 = rng() * Math.PI * 2;
  const steps = Math.ceil(2 * Math.PI * radius);
  const path: Path = { x: [], y: [] };
  for (let k = 0; k < steps; k++) {
    const t = spin * (k / steps) * Math.PI * 2;
    const r = radius * (1 + CURRENTS.loopWobble * (0.6 * Math.sin(2 * t + p2) + 0.4 * Math.sin(3 * t + p3)));
    path.x.push(cx + Math.cos(t) * r);
    path.y.push(cy + Math.sin(t) * r);
  }
  return path;
}

/**
 * Adds flow along a path: each path point stamps a Gaussian band along its
 * tangent. Point spacing is ~1 tile, so dividing by sqrt(pi) * width makes the
 * summed band peak at `speed`. Open paths taper in and out at their ends.
 */
function stampPath(
  path: Path,
  closed: boolean,
  speed: number,
  width: number,
  height: number,
  vx: Float32Array,
  vy: Float32Array,
): void {
  const w = CURRENTS.streamWidth;
  const reach = Math.ceil(w * 3);
  const count = path.x.length;
  const norm = speed / (Math.sqrt(Math.PI) * w);
  for (let k = 0; k < count; k++) {
    const prev = closed ? (k - 1 + count) % count : Math.max(0, k - 1);
    const next = closed ? (k + 1) % count : Math.min(count - 1, k + 1);
    let tx = path.x[next] - path.x[prev];
    let ty = path.y[next] - path.y[prev];
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    let taper = 1;
    if (!closed) {
      const a = Math.min(1, k / CURRENTS.taper);
      const b = Math.min(1, (count - 1 - k) / CURRENTS.taper);
      taper = a * a * (3 - 2 * a) * b * b * (3 - 2 * b);
    }
    const px = path.x[k];
    const py = path.y[k];
    const x0 = Math.max(0, Math.floor(px - reach));
    const x1 = Math.min(width - 1, Math.ceil(px + reach));
    const y0 = Math.max(0, Math.floor(py - reach));
    const y1 = Math.min(height - 1, Math.ceil(py + reach));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d2 = (x - px) ** 2 + (y - py) ** 2;
        const f = Math.exp(-d2 / (w * w)) * norm * taper;
        vx[y * width + x] += tx * f;
        vy[y * width + x] += ty * f;
      }
    }
  }
}

/** Current at a world position, interpolated between the four nearest tile centers. */
export function sampleCurrent(field: CurrentField, px: number, py: number, out: { x: number; y: number }): void {
  const { vx, vy } = field;
  const fx = Math.min(WORLD.width - 1, Math.max(0, px / WORLD.tileSize - 0.5));
  const fy = Math.min(WORLD.height - 1, Math.max(0, py / WORLD.tileSize - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(WORLD.width - 1, x0 + 1);
  const y1 = Math.min(WORLD.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = y0 * WORLD.width + x0;
  const b = y0 * WORLD.width + x1;
  const c = y1 * WORLD.width + x0;
  const d = y1 * WORLD.width + x1;
  const wa = (1 - tx) * (1 - ty);
  const wb = tx * (1 - ty);
  const wc = (1 - tx) * ty;
  const wd = tx * ty;
  out.x = vx[a] * wa + vx[b] * wb + vx[c] * wc + vx[d] * wd;
  out.y = vy[a] * wa + vy[b] * wb + vy[c] * wc + vy[d] * wd;
}
