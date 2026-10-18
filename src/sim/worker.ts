import { SIM } from '../config';
import type { CellInfo, FrameMsg, FromWorker, ToWorker, WorldMsg } from './protocol';
import { CellType, Sim } from './sim';

let sim: Sim | null = null;
let paused = false;
let inspectIds: number[] = [];
const dt = 1 / SIM.tickHz;

// The worker scope's postMessage has the same signature as Worker's.
const scope = self as unknown as Worker;
const post = (msg: FromWorker, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);

function generate(seed: number): void {
  sim = new Sim(seed);
  inspectIds = [];
  const { world } = sim;
  const msg: WorldMsg = {
    type: 'world',
    seed,
    width: world.width,
    height: world.height,
    depth: world.depth.slice(),
    temperature: world.temperature.slice(),
    currentDir: world.currentDir.slice(),
    currentStrength: world.currentStrength.slice(),
  };
  post(msg, [msg.depth.buffer, msg.temperature.buffer, msg.currentDir.buffer, msg.currentStrength.buffer]);
}

function inspect(s: Sim, i: number): CellInfo | null {
  if (i < 0 || i >= s.cellCount || s.type[i] === CellType.None) return null;
  const o = s.organism[i];
  return {
    id: i,
    alive: s.alive[i],
    type: s.type[i],
    x: s.x[i],
    y: s.y[i],
    vx: s.vx[i],
    vy: s.vy[i],
    angle: s.angle[i],
    energy: s.energy[i],
    bodyNutrient: s.bodyNutrient[i],
    storedNutrient: s.storedNutrient[i],
    age: s.age[i],
    organism: o,
    sensorLevel: s.sensorLevel[i],
    sensorChange: s.sensorChange[i],
    neuronOutput: s.neuronOut[i],
    org:
      o < 0
        ? null
        : {
            id: o,
            owner: s.owner[o],
            lineage: s.lineage[o],
            genome: (() => {
              const g = s.genomes[s.genomeId[o]];
              return { name: g.design.name, growth: g.design.growth, reproduction: g.design.reproduction, maxCells: g.maxCells };
            })(),
            cellCount: s.orgCells[o],
            generation: s.generation[o],
            mutations: s.mutations[o],
            design: s.genomes[s.genomeId[o]].design,
          },
  };
}

function bondPairs(s: Sim): Int32Array {
  const pairs: number[] = [];
  for (let b = 0; b < s.bondCount; b++) if (s.bondA[b] >= 0) pairs.push(s.bondA[b], s.bondB[b]);
  return Int32Array.from(pairs);
}

function postFrame(s: Sim): void {
  const n = s.cellCount;
  let living = 0;
  let dead = 0;
  let cellNutrient = 0;
  for (let i = 0; i < n; i++) {
    if (s.alive[i]) living++;
    else if (s.type[i] === CellType.Dead) dead++;
    if (s.type[i] !== CellType.None) cellNutrient += s.bodyNutrient[i] + s.storedNutrient[i];
  }
  let waterNutrient = 0;
  const water = s.world.nutrient;
  for (let i = 0; i < water.length; i++) waterNutrient += water[i];
  let organisms = 0;
  for (let o = 0; o < s.orgCount; o++) if (s.orgCells[o] > 0) organisms++;

  const msg: FrameMsg = {
    type: 'frame',
    tick: s.tick,
    time: s.world.time,
    paused,
    cellCount: n,
    cellType: s.type.slice(0, n),
    cellX: s.x.slice(0, n),
    cellY: s.y.slice(0, n),
    cellAngle: s.angle.slice(0, n),
    cellEnergy: s.energy.slice(0, n),
    cellNutrient: s.bodyNutrient.slice(0, n),
    cellDrained: s.drained.slice(0, n),
    cellFiring: s.firing.slice(0, n),
    cellSignal: s.neuronOut.slice(0, n),
    wires: s.wireList(),
    bonds: bondPairs(s),
    cellOrganism: s.organism.slice(0, n),
    cellLineage: s.cellLineage.slice(0, n),
    cellOwner: Int32Array.from(s.cellLineage.subarray(0, n), (l) => s.lineages.owner[l]),
    events: s.drainEvents(),
    waterNutrient: water.slice(),
    living,
    dead,
    organisms,
    waterNutrientTotal: waterNutrient,
    cellNutrientTotal: cellNutrient,
    inspect: inspectIds.map((id) => inspect(s, id)).filter((c): c is CellInfo => c !== null),
  };
  post(msg, [
    msg.cellType.buffer,
    msg.cellX.buffer,
    msg.cellY.buffer,
    msg.cellAngle.buffer,
    msg.cellEnergy.buffer,
    msg.cellNutrient.buffer,
    msg.cellDrained.buffer,
    msg.cellFiring.buffer,
    msg.cellSignal.buffer,
    msg.wires.buffer,
    msg.bonds.buffer,
    msg.cellOrganism.buffer,
    msg.cellLineage.buffer,
    msg.cellOwner.buffer,
    msg.events.buffer,
    msg.waterNutrient.buffer,
  ]);
}

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === 'generate') {
    generate(msg.seed);
    return;
  }
  if (!sim) return;
  switch (msg.type) {
    case 'release': {
      post({ type: 'released', id: msg.id, ...sim.release(msg.design, msg.owner, msg.x, msg.y) });
      break;
    }
    case 'inspect':
      inspectIds = msg.ids;
      break;
    case 'pause':
      paused = msg.paused;
      break;
    case 'step':
      if (paused) sim.step(dt);
      break;
    case 'speed':
      speed = Math.min(SIM.speedMax, Math.max(SIM.speedMin, msg.speed));
      break;
  }
  postFrame(sim);
};

// Speed changes how many fixed-size ticks run per interval; fractional speeds
// accumulate, so 0.5x runs a tick every other interval.
let speed = 1;
let pendingTicks = 0;
setInterval(() => {
  if (!sim) return;
  if (!paused) {
    pendingTicks += speed;
    while (pendingTicks >= 1) {
      sim.step(dt);
      pendingTicks -= 1;
    }
  }
  postFrame(sim);
  if (sim.lineageReport) {
    post({ type: 'lineages', ...sim.lineageReport });
    sim.lineageReport = null;
  }
}, 1000 / SIM.tickHz);
