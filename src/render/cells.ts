import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { AdvancedBloomFilter } from 'pixi-filters';
import { CELL, CELL_RENDER, CELL_STYLE } from '../config';
import type { RenderCells } from '../game-source';
import { CellType, energyCap, isSensorType, TYPE_STYLE } from '../sim/sim';

/** Builds a texture from a per-pixel function of normalized coords in [-1, 1] returning [gray, alpha]. */
function makeTexture(size: number, pixel: (u: number, v: number) => [number, number]): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const [gray, alpha] = pixel(((px + 0.5) / size) * 2 - 1, ((py + 0.5) / size) * 2 - 1);
      const p = (py * size + px) * 4;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = clamp01(gray) * 255;
      img.data[p + 3] = clamp01(alpha) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return Texture.from(canvas);
}

const blend = (a: number, b: number) =>
  ((((a >> 16) & 255) + ((b >> 16) & 255)) >> 1) * 65536 +
  ((((a >> 8) & 255) + ((b >> 8) & 255)) >> 1) * 256 +
  (((a & 255) + (b & 255)) >> 1);

const dot = (u: number, v: number, cx: number, cy: number, r: number) =>
  1 - Math.min(1, Math.max(0, (Math.hypot(u - cx, v - cy) - r * 0.6) / (r * 0.4)));

/** Soft line: 1 on the segment, fading to 0 at distance w. */
function segment(u: number, v: number, ax: number, ay: number, bx: number, by: number, w: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((u - ax) * dx + (v - ay) * dy) / (dx * dx + dy * dy)));
  return Math.max(0, 1 - Math.hypot(u - ax - dx * t, v - ay - dy * t) / w);
}

const ring = (u: number, v: number, radius: number, w: number) => Math.max(0, 1 - Math.abs(Math.hypot(u, v) - radius) / w);

/** Sensor mark: two little antennae with bulb tips. */
function antennaTexture(): Texture {
  return makeTexture(64, (u, v) =>
    [
      1,
      Math.max(
        segment(u, v, -0.05, 0.45, -0.32, -0.5, 0.07),
        segment(u, v, 0.05, 0.45, 0.32, -0.5, 0.07),
        dot(u, v, -0.34, -0.58, 0.2),
        dot(u, v, 0.34, -0.58, 0.2),
        dot(u, v, 0, 0.5, 0.16) * 0.8,
      ),
    ],
  );
}

// Textures are built on first use, after the host's config has been applied.
function buildTextures() {
  const antenna = antennaTexture();
  return {
    // Translucent interior that brightens into an opaque rim. The 1px soft edge antialiases.
    membrane: makeTexture(128, (u, v) => {
      const d = Math.hypot(u, v);
      const edge = Math.max(0, Math.min(1, (1 - d) * 64));
      const rim = Math.max(0, Math.min(1, (d - (1 - CELL_RENDER.membraneRim)) / CELL_RENDER.membraneRim));
      const rimShape = rim * rim;
      return [0.65 + 0.35 * rimShape, (CELL_RENDER.membraneFill + (1 - CELL_RENDER.membraneFill) * rimShape) * edge];
    }),
    glow: makeTexture(64, (u, v) => {
      const d2 = u * u + v * v;
      return [1, Math.exp(-4 * d2) * (1 - Math.min(1, Math.sqrt(d2)))];
    }),
    // Inner marks, one per type (drawn tinted, sized by CELL_STYLE.markSize).
    marks: {
      leaf: makeTexture(32, (u, v) => [
        1,
        Math.max(dot(u, v, 0.35, 0, 0.22), dot(u, v, -0.2, 0.32, 0.22), dot(u, v, -0.2, -0.32, 0.22)),
      ]),
      // Mouth: a bright ring, like an open maw.
      mouth: makeTexture(48, (u, v) => [1, ring(u, v, 0.62, 0.24) ** 1.5]),
      // Root: branching root lines.
      root: makeTexture(64, (u, v) =>
        [
          1,
          Math.max(
            segment(u, v, 0, -0.55, 0, 0.75, 0.09),
            segment(u, v, 0, 0.05, 0.42, 0.55, 0.08),
            segment(u, v, 0, 0.05, -0.42, 0.55, 0.08),
            segment(u, v, 0, 0.4, 0.2, 0.8, 0.07),
            segment(u, v, 0, 0.4, -0.2, 0.8, 0.07),
            segment(u, v, 0.42, 0.55, 0.6, 0.62, 0.06),
            segment(u, v, -0.42, 0.55, -0.6, 0.62, 0.06),
          ) * 0.95,
        ],
      ),
      // Fat: a soft full blob filling the cell.
      fat: makeTexture(48, (u, v) => [1, Math.max(0, 1 - (u * u + v * v)) ** 0.8 * 0.55]),
      // Spike: sharp spikes around the edge.
      spike: makeTexture(64, (u, v) => {
        const d = Math.hypot(u, v);
        if (d < 0.5 || d > 1) return [1, 0];
        const n = 8;
        const a = Math.atan2(v, u) * (n / (Math.PI * 2));
        const off = Math.abs(a - Math.round(a)); // 0 at a spike's center line
        const half = 0.32 * (1 - (d - 0.5) / 0.5); // narrows toward the tip
        return [1, Math.max(0, Math.min(1, (half - off) * 12))];
      }),
      // Decomposer: a swirl.
      decomposer: makeTexture(64, (u, v) => {
        const d = Math.hypot(u, v);
        if (d > 0.85) return [1, 0];
        const t = Math.atan2(v, u) / (Math.PI * 2);
        const f = (d * 2.4 - t + 10) % 1; // spiral arm where f ≈ 0 or 1
        return [1, Math.max(0, 1 - Math.min(f, 1 - f) / 0.14) * Math.min(1, d * 4)];
      }),
      // Jet: a chevron pointing the way it pushes (texture points +x).
      jet: makeTexture(48, (u, v) => [1, Math.max(segment(u, v, 0.45, 0, -0.25, 0.45, 0.12), segment(u, v, 0.45, 0, -0.25, -0.45, 0.12))]),
      dead: makeTexture(32, (u, v) => [1, ring(u, v, 0.6, 0.2)]),
      // Every sensor shares the antenna mark, in its own color.
      lightSensor: antenna,
      nutrientSensor: antenna,
      temperatureSensor: antenna,
      touchSensor: antenna,
      proximitySensor: antenna,
      // Neuron: a small bright node.
      neuron: makeTexture(32, (u, v) => {
        const d = Math.hypot(u, v);
        return [1, Math.max(0, 1 - d / 0.55) ** 1.2 + ring(u, v, 0.75, 0.12) * 0.6];
      }),
    },
    // Jet exhaust: bright where it leaves the Jet (left end), fading outward.
    exhaust: makeTexture(64, (u, v) => [1, ((1 - u) / 2) ** 1.4 * Math.max(0, 1 - v * v * 1.6)]),
    // Bond bridge: a soft band joining two bonded membranes (stretched along the bond).
    bridge: makeTexture(32, (_u, v) => [0.9, Math.sqrt(Math.max(0, 1 - v * v))]),
    // Owner outline: a thin ring just outside the membrane.
    outline: makeTexture(96, (u, v) => [1, ring(u, v, 0.94, 0.05)]),
    // Drain cue: a thin soft ring around the prey.
    drain: makeTexture(64, (u, v) => [1, ring(u, v, 0.82, 0.12)]),
  };
}

/** Reuses sprites across frames; sprites beyond the used count are hidden. */
class SpritePool {
  private sprites: Sprite[] = [];
  private used = 0;

  constructor(
    private layer: Container,
    private texture: Texture,
    private blendMode: 'normal' | 'add',
  ) {}

  begin(): void {
    this.used = 0;
  }

  next(x: number, y: number, diameter: number, tint: number, alpha: number, rotation = 0): void {
    let s = this.sprites[this.used];
    if (!s) {
      s = new Sprite(this.texture);
      s.anchor.set(0.5);
      s.blendMode = this.blendMode;
      this.layer.addChild(s);
      this.sprites.push(s);
    }
    this.used++;
    s.visible = true;
    s.position.set(x, y);
    s.scale.set(diameter / this.texture.width);
    s.rotation = rotation;
    s.tint = tint;
    s.alpha = alpha;
  }

  /** A sprite stretched to length × width, centered at (x, y). */
  nextBar(x: number, y: number, length: number, width: number, tint: number, alpha: number, rotation: number): void {
    this.next(x, y, length, tint, alpha, rotation);
    const s = this.sprites[this.used - 1];
    s.scale.set(length / this.texture.width, width / this.texture.height);
  }

  end(): void {
    for (let i = this.used; i < this.sprites.length; i++) this.sprites[i].visible = false;
  }
}

type StyleKey = keyof typeof CELL_STYLE;
const styleOf = (type: number) => CELL_STYLE[TYPE_STYLE[type] as StyleKey];
/** Marks drawn additively (bright); the Dead mark is drawn normally (dull). */
const MARK_BLEND: Record<StyleKey, 'normal' | 'add'> = {
  leaf: 'add',
  mouth: 'add',
  root: 'add',
  fat: 'add',
  spike: 'add',
  decomposer: 'add',
  jet: 'add',
  lightSensor: 'add',
  nutrientSensor: 'add',
  temperatureSensor: 'add',
  touchSensor: 'add',
  proximitySensor: 'add',
  neuron: 'add',
  dead: 'normal',
};

/** Draws cells: membranes, inner type marks, bond bridges, cues, and night glow with bloom. */
export class CellView {
  readonly container = new Container();
  private bridges: SpritePool;
  private outlines: SpritePool;
  private membranes: SpritePool;
  private marks: Record<StyleKey, SpritePool>;
  private exhausts: SpritePool;
  private drainCues: SpritePool;
  private glows: SpritePool;
  private ring = new Graphics();
  private wireLines = new Graphics();

  constructor() {
    const bridgeLayer = new Container();
    const membraneLayer = new Container();
    const marksLayer = new Container();
    const cueLayer = new Container();
    const glowLayer = new Container();

    const bloom = new AdvancedBloomFilter({
      threshold: CELL_RENDER.bloomThreshold,
      bloomScale: CELL_RENDER.bloomScale,
      blur: CELL_RENDER.bloomBlur,
    });
    bloom.blendMode = 'add';
    glowLayer.filters = [bloom];

    const tex = buildTextures();
    this.bridges = new SpritePool(bridgeLayer, tex.bridge, 'normal');
    this.outlines = new SpritePool(bridgeLayer, tex.outline, 'normal');
    this.membranes = new SpritePool(membraneLayer, tex.membrane, 'normal');
    this.marks = Object.fromEntries(
      (Object.keys(tex.marks) as StyleKey[]).map((k) => [k, new SpritePool(marksLayer, tex.marks[k], MARK_BLEND[k])]),
    ) as Record<StyleKey, SpritePool>;
    this.exhausts = new SpritePool(cueLayer, tex.exhaust, 'add');
    this.drainCues = new SpritePool(cueLayer, tex.drain, 'add');
    this.glows = new SpritePool(glowLayer, tex.glow, 'add');
    this.container.addChild(this.wireLines, bridgeLayer, membraneLayer, marksLayer, cueLayer, glowLayer, this.ring);
  }

  /** `ownerColor` gives each player's color, for the thin outline on their organisms. */
  draw(frame: RenderCells, daylight: number, inspectId: number, zoom: number, ownerColor: (owner: number) => number): void {
    const r = CELL.radius;
    const glowAlpha = CELL_RENDER.glowDay + (CELL_RENDER.glowNight - CELL_RENDER.glowDay) * (1 - daylight);
    const { cellType, cellX, cellY, cellAngle, cellEnergy, cellNutrient, cellDrained, cellFiring, cellOwner, cellSignal } = frame;
    const now = performance.now() / 1000;
    const pulse = 0.55 + 0.45 * Math.sin(now * Math.PI * 2 * CELL_RENDER.drainPulseHz);
    const pools = [this.bridges, this.outlines, this.membranes, ...Object.values(this.marks), this.exhausts, this.drainCues, this.glows];
    for (const p of pools) p.begin();

    for (let i = 0; i < frame.cellCount; i++) {
      const type = cellType[i];
      if (type === CellType.None) continue;
      const x = cellX[i];
      const y = cellY[i];
      const key = TYPE_STYLE[type] as StyleKey;
      const style = CELL_STYLE[key];
      if (type === CellType.Dead) {
        const fade = cellNutrient[i] / CELL.bodyNutrient;
        this.membranes.next(x, y, 2 * r, style.color, fade);
        this.marks.dead.next(x, y, r * style.markSize, style.mark, fade);
      } else {
        this.outlines.next(x, y, r * CELL_RENDER.ownerOutlineSize * style.membraneScale, ownerColor(cellOwner[i]), CELL_RENDER.ownerOutlineAlpha);
        this.membranes.next(x, y, 2 * r * style.membraneScale, style.color, 1);
        // A Jet's and sensor's angle is the way it faces (outward): a Jet's chevron
        // points the way it pushes; a sensor's antennae (drawn pointing up) point where it faces.
        const rotation = type === CellType.Jet ? cellAngle[i] + Math.PI : isSensorType(type) ? cellAngle[i] + Math.PI / 2 : cellAngle[i];
        if (type === CellType.Neuron) {
          // The node and its glow follow the neuron's output; tint shows its sign.
          const level = Math.abs(cellSignal[i]);
          const tint = cellSignal[i] >= 0 ? CELL_RENDER.wirePositive : CELL_RENDER.wireNegative;
          this.marks.neuron.next(x, y, r * style.markSize * (0.7 + 0.6 * level), level > 0.05 ? blend(style.mark, tint) : style.mark, 0.35 + 0.65 * level);
          this.glows.next(x, y, 2 * r * CELL_RENDER.glowRadius, style.glow, Math.max(glowAlpha, 0.25) * (0.2 + 1.2 * level));
        } else {
          this.marks[key].next(x, y, r * style.markSize, style.mark, 0.9, rotation);
          const vigor = 0.4 + 0.6 * Math.min(1, cellEnergy[i] / energyCap(type));
          this.glows.next(x, y, 2 * r * CELL_RENDER.glowRadius, style.glow, glowAlpha * vigor);
        }
      }
      if (cellFiring[i]) {
        // Flickering exhaust trail behind the Jet.
        const flicker = 0.75 + 0.25 * Math.sin(now * Math.PI * 2 * CELL_RENDER.exhaustFlickerHz + i * 1.7);
        const length = r * CELL_RENDER.exhaustLength * flicker;
        const a = cellAngle[i];
        this.exhausts.nextBar(
          x + Math.cos(a) * (r * 0.8 + length / 2),
          y + Math.sin(a) * (r * 0.8 + length / 2),
          length,
          r * 0.9,
          CELL_RENDER.exhaustColor,
          0.85 * flicker,
          a,
        );
      }
      if (cellDrained[i]) {
        this.drainCues.next(x, y, r * CELL_RENDER.drainSize, CELL_RENDER.drainColor, CELL_RENDER.drainAlpha * pulse);
      }
    }
    // Bonds: a bridge between bonded cells, in the color of the cells it joins.
    const { bonds } = frame;
    for (let k = 0; k < bonds.length; k += 2) {
      const a = bonds[k];
      const b = bonds[k + 1];
      if (a >= frame.cellCount || b >= frame.cellCount || !cellType[a] || !cellType[b]) continue;
      const dx = cellX[b] - cellX[a];
      const dy = cellY[b] - cellY[a];
      const ca = styleOf(cellType[a]).color;
      const cb = styleOf(cellType[b]).color;
      this.bridges.nextBar(
        (cellX[a] + cellX[b]) / 2,
        (cellY[a] + cellY[b]) / 2,
        Math.hypot(dx, dy),
        r * CELL_RENDER.bridgeWidth,
        ca === cb ? ca : blend(ca, cb),
        CELL_RENDER.bridgeAlpha,
        Math.atan2(dy, dx),
      );
    }
    for (const p of pools) p.end();

    // Wiring: thin lines from source to target, colored by the sign of the weight.
    const g = this.wireLines;
    g.clear();
    const { wires } = frame;
    for (let k = 0; k < wires.length; k += 3) {
      const a = wires[k];
      const b = wires[k + 1];
      if (a >= frame.cellCount || b >= frame.cellCount || !cellType[a] || !cellType[b] || a === b) continue;
      const w = wires[k + 2];
      g.moveTo(cellX[a], cellY[a])
        .lineTo(cellX[b], cellY[b])
        .stroke({ width: (0.8 + Math.abs(w) * 1.2) / zoom, color: w >= 0 ? CELL_RENDER.wirePositive : CELL_RENDER.wireNegative, alpha: CELL_RENDER.wireAlpha * (0.4 + 0.6 * Math.abs(w)) });
    }

    this.ring.clear();
    if (inspectId >= 0 && inspectId < frame.cellCount && cellType[inspectId] !== CellType.None) {
      this.ring
        .circle(cellX[inspectId], cellY[inspectId], r * 1.5)
        .stroke({ width: 1.5 / zoom, color: CELL_RENDER.inspectRingColor });
    }
  }

  /** Index of the cell under a world point, or -1. */
  static pick(frame: RenderCells, x: number, y: number): number {
    let best = -1;
    let bestD2 = CELL.radius * CELL.radius;
    for (let i = 0; i < frame.cellCount; i++) {
      if (frame.cellType[i] === CellType.None) continue;
      const d2 = (frame.cellX[i] - x) ** 2 + (frame.cellY[i] - y) ** 2;
      if (d2 <= bestD2) {
        best = i;
        bestD2 = d2;
      }
    }
    return best;
  }
}
