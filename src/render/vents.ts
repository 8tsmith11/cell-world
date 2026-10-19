import { Container, Sprite, Texture } from 'pixi.js';
import { VENT_RENDER, VENTS, WORLD } from '../config';

/** Soft radial glow texture (white; tinted per sprite). */
function glowTexture(size: number): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return Texture.from(canvas);
}

/**
 * Hydrothermal vents: a faint warm shimmer at each vent center, so the rare
 * deep-water energy sources can be found without an overlay.
 */
export class Vents {
  readonly container = new Container();
  private sprites: Sprite[] = [];
  private texture: Texture | null = null;

  /** Finds vent centers (where vent strength peaks) and places a glow on each. */
  setWorld(chem: Float32Array): void {
    this.texture ??= glowTexture(128);
    for (const s of this.sprites) s.destroy();
    this.sprites = [];
    const w = WORLD.width;
    for (let i = 0; i < chem.length; i++) {
      if (chem[i] < 0.99) continue;
      const x = i % w;
      const y = Math.floor(i / w);
      const s = new Sprite(this.texture);
      s.anchor.set(0.5);
      s.blendMode = 'add';
      s.tint = VENT_RENDER.color;
      s.position.set((x + 0.5) * WORLD.tileSize, (y + 0.5) * WORLD.tileSize);
      s.scale.set((VENTS.radius * 2 * WORLD.tileSize * VENT_RENDER.size) / 128);
      this.container.addChild(s);
      this.sprites.push(s);
    }
  }

  /** Dimmer by day, a slow shimmer always. */
  update(daylight: number): void {
    const t = performance.now() / 1000;
    const base = VENT_RENDER.alphaNight + (VENT_RENDER.alphaDay - VENT_RENDER.alphaNight) * daylight;
    this.sprites.forEach((s, k) => {
      s.alpha = base * (0.8 + 0.2 * Math.sin(t * Math.PI * 2 * VENT_RENDER.shimmerHz + k * 2.1));
    });
  }
}
