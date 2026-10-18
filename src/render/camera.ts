import type { Container } from 'pixi.js';
import { CAMERA } from '../config';

/** Pan/zoom camera over a world of fixed size. The view never leaves the world bounds. */
export class Camera {
  /** World point at the center of the screen. */
  x: number;
  y: number;
  /** Screen pixels per world unit. */
  zoom = 0;
  screenW = 1;
  screenH = 1;

  constructor(
    private worldW: number,
    private worldH: number,
  ) {
    this.x = worldW / 2;
    this.y = worldH / 2;
  }

  resize(screenW: number, screenH: number): void {
    this.screenW = screenW;
    this.screenH = screenH;
    this.clamp();
  }

  private minZoom(): number {
    return Math.max(this.screenW / this.worldW, this.screenH / this.worldH);
  }

  private clamp(): void {
    const min = this.minZoom();
    this.zoom = Math.min(Math.max(this.zoom, min), Math.max(min, CAMERA.maxZoom));
    const halfW = this.screenW / 2 / this.zoom;
    const halfH = this.screenH / 2 / this.zoom;
    this.x = Math.min(Math.max(this.x, halfW), this.worldW - halfW);
    this.y = Math.min(Math.max(this.y, halfH), this.worldH - halfH);
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: this.x + (sx - this.screenW / 2) / this.zoom,
      y: this.y + (sy - this.screenH / 2) / this.zoom,
    };
  }

  /** The visible world rectangle. */
  viewRect(): { x: number; y: number; w: number; h: number } {
    const w = this.screenW / this.zoom;
    const h = this.screenH / this.zoom;
    return { x: this.x - w / 2, y: this.y - h / 2, w, h };
  }

  /** Pans by a screen-space delta (content follows the pointer). */
  pan(dx: number, dy: number): void {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
    this.clamp();
  }

  /** Zooms by a factor, keeping the world point under (sx, sy) fixed. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.screenToWorld(sx, sy);
    this.zoom *= factor;
    this.clamp();
    const after = this.screenToWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.clamp();
  }

  apply(container: Container): void {
    container.scale.set(this.zoom);
    container.position.set(this.screenW / 2 - this.x * this.zoom, this.screenH / 2 - this.y * this.zoom);
  }
}
