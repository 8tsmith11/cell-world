// Binary messages from host to clients. Every message starts with a uint32 tag.
import { WORLD } from '../config';
import type { FrameMsg } from '../sim/protocol';
import { CellEvent, CellType, EVENT_STRIDE, energyCap } from '../sim/sim';

export const Tag = { Snapshot: 1, Events: 2, Nutrient: 3, Positions: 4 } as const;

const WORLD_W = () => WORLD.width * WORLD.tileSize;
const WORLD_H = () => WORLD.height * WORLD.tileSize;

export function tagOf(buf: ArrayBuffer): number {
  return new Uint32Array(buf, 0, 1)[0];
}

// ------------------------------------------------------------- snapshot
// [tag][f32 time][u32 recordCount][f32 records * EVENT_STRIDE][u32 water * tiles]
// Records use the event layout: cells with kind = Born, then bonds with kind = BondAdded.

export function encodeSnapshot(frame: FrameMsg): ArrayBuffer {
  const records: number[] = [];
  for (let i = 0; i < frame.cellCount; i++) {
    if (frame.cellType[i] === CellType.None) continue;
    records.push(
      CellEvent.Born,
      i,
      frame.cellType[i],
      frame.cellX[i],
      frame.cellY[i],
      frame.cellAngle[i],
      frame.cellEnergy[i],
      frame.cellNutrient[i],
      frame.cellOrganism[i],
      frame.cellOwner[i],
      frame.cellLineage[i],
    );
  }
  for (let k = 0; k < frame.bonds.length; k += 2) records.push(CellEvent.BondAdded, frame.bonds[k], frame.bonds[k + 1], 0, 0, 0, 0, 0, 0, 0, 0);
  const tiles = frame.waterNutrient.length;
  const buf = new ArrayBuffer(12 + records.length * 4 + tiles * 4);
  const head = new DataView(buf);
  head.setUint32(0, Tag.Snapshot, true);
  head.setFloat32(4, frame.time, true);
  head.setUint32(8, records.length / EVENT_STRIDE, true);
  new Float32Array(buf, 12, records.length).set(records);
  new Uint32Array(buf, 12 + records.length * 4, tiles).set(frame.waterNutrient);
  return buf;
}

export function decodeSnapshot(buf: ArrayBuffer): { time: number; records: Float32Array; water: Uint32Array } {
  const head = new DataView(buf);
  const count = head.getUint32(8, true);
  const records = new Float32Array(buf, 12, count * EVENT_STRIDE);
  const tiles = WORLD.width * WORLD.height;
  const water = new Uint32Array(buf, 12 + records.byteLength, tiles);
  return { time: head.getFloat32(4, true), records, water };
}

// ------------------------------------------------------------- events
// [tag][f32 events * EVENT_STRIDE]

export function encodeEvents(events: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(4 + events.byteLength);
  new Uint32Array(buf, 0, 1)[0] = Tag.Events;
  new Float32Array(buf, 4).set(events);
  return buf;
}

export function decodeEvents(buf: ArrayBuffer): Float32Array {
  return new Float32Array(buf, 4);
}

// ------------------------------------------------------------- nutrient
// [tag][u32 tile, u32 value]*

export function encodeNutrient(pairs: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(4 + pairs.length * 4);
  new Uint32Array(buf, 0, 1)[0] = Tag.Nutrient;
  new Uint32Array(buf, 4).set(pairs);
  return buf;
}

export function decodeNutrient(buf: ArrayBuffer): Uint32Array {
  return new Uint32Array(buf, 4);
}

// ------------------------------------------------------------- positions
// [tag][f32 time][u32 count] then per cell (10 bytes):
// u16 id, u16 x, u16 y, u8 angle, u8 energy, u8 body nutrient, u8 flags (bit 0: drained, bit 1: Jet firing)
// Energy is sent as a fraction of the cell type's cap.
// x/y are quantized over the world size, angle to 256 steps, energy to 255.

const POS_HEADER = 12;
const POS_RECORD = 10;

export interface PositionRecord {
  id: number;
  x: number;
  y: number;
  angle: number;
  /** Energy as a fraction of the cell type's cap. */
  energyFraction: number;
  nutrient: number;
  drained: number;
  firing: number;
}

export function encodePositions(time: number, frame: FrameMsg, ids: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(POS_HEADER + ids.length * POS_RECORD);
  const v = new DataView(buf);
  v.setUint32(0, Tag.Positions, true);
  v.setFloat32(4, time, true);
  v.setUint32(8, ids.length, true);
  const qx = 65535 / WORLD_W();
  const qy = 65535 / WORLD_H();
  const qa = 256 / (Math.PI * 2);
  let o = POS_HEADER;
  for (const i of ids) {
    const a = ((frame.cellAngle[i] % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    v.setUint16(o, i, true);
    v.setUint16(o + 2, Math.round(frame.cellX[i] * qx), true);
    v.setUint16(o + 4, Math.round(frame.cellY[i] * qy), true);
    v.setUint8(o + 6, Math.round(a * qa) & 255);
    v.setUint8(o + 7, Math.round(Math.min(1, Math.max(0, frame.cellEnergy[i] / energyCap(frame.cellType[i]))) * 255));
    v.setUint8(o + 8, Math.min(255, frame.cellNutrient[i]));
    v.setUint8(o + 9, (frame.cellDrained[i] ? 1 : 0) | (frame.cellFiring[i] ? 2 : 0));
    o += POS_RECORD;
  }
  return buf;
}

export function decodePositions(buf: ArrayBuffer, each: (r: PositionRecord) => void): number {
  const v = new DataView(buf);
  const count = v.getUint32(8, true);
  const qx = WORLD_W() / 65535;
  const qy = WORLD_H() / 65535;
  const qa = (Math.PI * 2) / 256;
  const r: PositionRecord = { id: 0, x: 0, y: 0, angle: 0, energyFraction: 0, nutrient: 0, drained: 0, firing: 0 };
  let o = POS_HEADER;
  for (let k = 0; k < count; k++) {
    r.id = v.getUint16(o, true);
    r.x = v.getUint16(o + 2, true) * qx;
    r.y = v.getUint16(o + 4, true) * qy;
    r.angle = v.getUint8(o + 6) * qa;
    r.energyFraction = v.getUint8(o + 7) / 255;
    r.nutrient = v.getUint8(o + 8);
    r.drained = v.getUint8(o + 9) & 1;
    r.firing = (v.getUint8(o + 9) >> 1) & 1;
    each(r);
    o += POS_RECORD;
  }
  return v.getFloat32(4, true);
}
