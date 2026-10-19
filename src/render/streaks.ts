import { Container, Sprite, Texture } from 'pixi.js';
import { CURRENTS, OVERLAY } from '../config';
import { type CurrentField, sampleCurrent } from '../sim/currents';
import type { Camera } from './camera';

/** Soft horizontal streak: bright head on the right, fading tail to the left. */
function streakTexture(): Texture {
  const w = 64;
  const h = 8;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const v = ((y + 0.5) / h) * 2 - 1;
      const along = u * u * Math.min(1, (1 - u) * 8);
      const p = (y * w + x) * 4;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = 255;
      img.data[p + 3] = along * Math.max(0, 1 - v * v) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return Texture.from(canvas);
}

/**
 * Currents overlay: particles that ride the current field, drawn as streaks.
 * They live inside the camera view, so on-screen density, speed, and size stay
 * the same at every zoom. Calm water spawns few; strong streams spawn many.
 */
export class Streaks {
  readonly container = new Container();
  private field: CurrentField | null = null;
  private maxStrength = 1;
  private sprites: Sprite[] = [];
  private x = new Float32Array(OVERLAY.streakCount);
  private y = new Float32Array(OVERLAY.streakCount);
  private age = new Float32Array(OVERLAY.streakCount);
  private cur = { x: 0, y: 0 };

  constructor() {
    const tex = streakTexture();
    for (let i = 0; i < OVERLAY.streakCount; i++) {
      const s = new Sprite(tex);
      s.anchor.set(1, 0.5);
      s.blendMode = 'add';
      s.tint = OVERLAY.streakColor;
      this.sprites.push(s);
      this.container.addChild(s);
    }
    this.container.visible = false;
  }

  setField(field: CurrentField): void {
    this.field = field;
    this.maxStrength = CURRENTS.maxSpeed;
    for (let i = 0; i < OVERLAY.streakCount; i++) this.age[i] = Infinity;
  }

  private respawn(i: number, camera: Camera): void {
    const field = this.field!;
    const view = camera.viewRect();
    // Rejection-sample toward strong current, but always place something.
    for (let attempt = 0; attempt < 8; attempt++) {
      this.x[i] = view.x + Math.random() * view.w;
      this.y[i] = view.y + Math.random() * view.h;
      sampleCurrent(field, this.x[i], this.y[i], this.cur);
      const s = Math.hypot(this.cur.x, this.cur.y) / this.maxStrength;
      if (Math.random() < s * s) break;
    }
    this.age[i] = -Math.random() * OVERLAY.streakLife;
  }

  update(dt: number, visible: boolean, camera: Camera): void {
    this.container.visible = visible && this.field !== null;
    if (!this.container.visible) return;
    const field = this.field!;
    const view = camera.viewRect();
    // World units per second that move the strongest current at streakSpeedPx on screen.
    const speedScale = OVERLAY.streakSpeedPx / camera.zoom / this.maxStrength;
    const life = OVERLAY.streakLife;
    for (let i = 0; i < OVERLAY.streakCount; i++) {
      const outside =
        this.x[i] < view.x || this.y[i] < view.y || this.x[i] > view.x + view.w || this.y[i] > view.y + view.h;
      if (this.age[i] > life || outside) this.respawn(i, camera);
      this.age[i] += dt;
      sampleCurrent(field, this.x[i], this.y[i], this.cur);
      this.x[i] += this.cur.x * speedScale * dt;
      this.y[i] += this.cur.y * speedScale * dt;

      const s = this.sprites[i];
      const strength = Math.hypot(this.cur.x, this.cur.y) / this.maxStrength;
      const t = Math.max(0, this.age[i]) / life;
      const fade = Math.min(1, t * 5) * Math.min(1, (1 - t) * 3);
      s.visible = this.age[i] > 0;
      s.position.set(this.x[i], this.y[i]);
      s.rotation = Math.atan2(this.cur.y, this.cur.x);
      s.scale.set(
        (OVERLAY.streakLengthPx * Math.max(0.25, strength)) / camera.zoom / s.texture.width,
        (OVERLAY.streakWidthPx * 2) / camera.zoom / s.texture.height,
      );
      s.alpha = OVERLAY.streakAlpha * fade * Math.min(1, 0.25 + strength);
    }
  }
}
