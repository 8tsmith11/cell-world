const GRAD_X = [1, -1, 1, -1, 1, -1, 0, 0];
const GRAD_Y = [1, 1, -1, -1, 0, 0, 1, -1];

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Seeded 2D Perlin noise. Output is roughly in [-1, 1]. */
export function createNoise2D(rng: () => number): (x: number, y: number) => number {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  const dot = (hash: number, x: number, y: number) => GRAD_X[hash & 7] * x + GRAD_Y[hash & 7] * y;

  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const X = xi & 255;
    const Y = yi & 255;
    const n00 = dot(perm[perm[X] + Y], xf, yf);
    const n10 = dot(perm[perm[X + 1] + Y], xf - 1, yf);
    const n01 = dot(perm[perm[X] + Y + 1], xf, yf - 1);
    const n11 = dot(perm[perm[X + 1] + Y + 1], xf - 1, yf - 1);
    const u = fade(xf);
    return lerp(lerp(n00, n10, u), lerp(n01, n11, u), fade(yf));
  };
}

/** Fractal Brownian motion over a noise function. */
export function fbm(
  noise: (x: number, y: number) => number,
  x: number,
  y: number,
  octaves: number,
  persistence: number,
  lacunarity: number,
): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += noise(x * freq, y * freq) * amp;
    amp *= persistence;
    freq *= lacunarity;
  }
  return sum;
}
