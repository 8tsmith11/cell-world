// All tuning numbers live here.

export const WORLD = {
  width: 362, // grid tiles
  height: 272, // grid tiles
  tileSize: 16, // world units per grid tile
};

export const DEPTH = {
  min: 2, // meters, shallowest point
  max: 170, // meters, deepest point
  noiseScale: 0.005, // noise frequency per grid tile (lower = larger, more gradual features)
  octaves: 4,
  persistence: 0.45, // amplitude multiplier per octave
  lacunarity: 2, // frequency multiplier per octave
};

export const TEMPERATURE = {
  center: 30, // °C at the world center
  edge: 4, // °C at the corners
  depthCooling: 8, // °C colder at the deepest point than at the surface (deep water lowers metabolism)
};

export const LIGHT = {
  attenuation: 0.02, // k in light = daylight(time) * exp(-k * depth), per meter
  dayLengthSec: 240, // simulated seconds per full day/night cycle
  startPhase: 0.3, // 0 = midnight, 0.5 = noon
  nightDaylight: 0, // daylight value at midnight (noon is 1)
};

export const NUTRIENT = {
  total: 2_000_000, // integer units in the whole world, conserved forever
};

/** Water nutrient carried by currents (integer donor-cell advection) and slow diffusion. */
export const NUTRIENT_FLOW = {
  intervalTicks: 15, // ticks between flow steps (each step moves a whole interval's worth)
  diffusion: 0.01, // fraction of a tile's nutrient that spreads to each of its 4 neighbors per step
  maxOutflow: 0.5, // most of a tile's nutrient that can leave it in one step
};

/** Hydrothermal vents: rare spots in deep water that feed Chemosynth cells, day and night. */
export const VENTS = {
  count: 4, // vents per world
  minDepthFraction: 0.65, // vents only form where depth is at least this fraction of the depth range
  radius: 8, // tiles, Gaussian falloff of a vent's strength
  minSpacing: 50, // tiles between vents
  attempts: 4000, // placement tries
};

// ---------------------------------------------------------------- simulation

export const CURRENTS = {
  calmSpeed: 3, // world units per second of typical (mean) background drift in calm water
  calmMaxFactor: 2, // background drift is clamped at this multiple of calmSpeed
  calmNoiseScale: 0.015, // background drift noise frequency per grid tile
  edgeFalloff: 12, // tiles over which background drift turns parallel to the world edge
  streams: 10, // number of streams per world
  loopChance: 0.35, // chance a stream is a closed loop
  streamSpeed: 7, // world units per second at the core of the strongest stream
  streamSpeedMin: 0.5, // weakest stream, as a fraction of streamSpeed
  streamWidth: 9, // tiles, Gaussian half-width of a stream
  maxSpeed: 8, // soft cap: overlapping streams approach this speed but never exceed it
  streamLengthMin: 120, // tiles, open streams
  streamLengthMax: 280,
  curveJitter: 0.004, // change in turn rate per tile, radians
  maxTurn: 0.035, // radians per tile
  edgeMargin: 18, // tiles; streams steer away from edges inside this
  edgeSteer: 0.08, // how hard streams turn toward the center near edges
  taper: 20, // tiles over which an open stream fades in and out at its ends
  loopRadiusMin: 16, // tiles
  loopRadiusMax: 34,
  loopWobble: 0.15, // radius variation of loops, as a fraction
};

export const SIM = {
  tickHz: 30, // simulation ticks per second at 1x speed
  speedMin: 0.25, // debug speed slider range (multiplier)
  speedMax: 8,
  maxCells: 32768, // network cell ids are 16-bit, so at most 65536
  maxBonds: 98304,
  maxOrganisms: 32768,
  waterFrameEvery: 15, // the worker sends the water nutrient field to the main thread every this many ticks
};

export const CELL = {
  radius: 6, // world units; every cell is a circle of this size
  maxEnergy: 100,
  bodyNutrient: 8, // nutrient units a cell's body is made of (fixed)
  storedNutrientCap: 16, // max surplus nutrient a cell can store; excess goes to the water
  spawnEnergy: 40, // energy of a debug-spawned cell
};

export const LEAF = {
  photosynthesis: 6, // energy per second at light = 1
  absorbRate: 1.5, // nutrient units per second a Leaf moves from the water into its store
};

export const ROOT = {
  absorbRate: 5, // nutrient units per second moved from the water into its store (faster than Leaf)
  absorbRadius: 2, // tiles around the Root it absorbs from (each unit comes from the richest tile in range)
  storedNutrientCap: 24, // somewhat larger store than other cells
};

export const FAT = {
  maxEnergy: 400, // much larger energy cap than other cells
  keepNeighborsAt: 0.8, // Fat takes a bonded neighbor's energy above this fraction of its cap, and gives back below it
  reserve: 25, // energy a Fat cell keeps for itself and never gives away; below it, it fills up like a normal cell
  storedNutrientCap: 64, // Fat also stores nutrient: a much larger store than other cells
};

export const SPIKE = {
  retaliation: 40, // energy per second a Mouth loses while it bites a Spike (more than the Mouth gains)
};

export const SHELL = {
  mouthDrainFactor: 0.25, // Mouths drain a Shell at this fraction of their normal rate
};

export const FILTER = {
  energyRate: 5, // energy per second at full flow through the cell in full-nutrient water
  absorbRate: 2, // nutrient units per second at full flow
  fullSpeed: 6, // water speed relative to the cell (world units/s) that counts as full flow
  fullNutrient: 20, // water nutrient per tile that counts as full
};

export const CHEMOSYNTH = {
  rate: 7, // energy per second at the center of a vent (vent strength 1)
  absorbRate: 1.5, // nutrient units per second it moves from the water into its store (like a Leaf)
};

/** Timer: a clock cell whose output follows the time of day. */
export const TIMER = {
  maxCycles: 8, // most on/off cycles per day
  cyclesSpread: 0.8, // new timers: how far beyond 1 cycle per day the random start reaches (exponential)
  edge: 0.04, // fraction of a cycle over which the output ramps between off and on
};

/** Growth tip: an advancing tip that grows the spot it faces and moves onto it. */
export const TIP = {
  defaultGrow: 1, // base Grow signal for tips placed in the editor
  growThreshold: 0.5, // a tip advances only while its Grow signal is above this
  turnThreshold: 0.5, // a Turn signal above this turns the tip 60° right before advancing (below minus this: left)
  branchThreshold: 0.5, // a Branch signal above this also starts a new tip at its side
  branchCooldown: 3, // advances a tip must make between branches
  stuckChecks: 6, // growth checks with every active tip blocked before a Blob grows one random edge cell
  maxDeposit: 4, // longest list of cell types a tip leaves behind
};

export const DECOMPOSER = {
  eatRate: 4, // nutrient units per second taken from a touching Dead cell
  energyPerNutrient: 1.5, // small energy gain per nutrient unit taken
  touchDistance: 2.2, // in cell radii, center to center
};

export const JET = {
  thrust: 60, // velocity added per second (world units/s²) at strength 1
  energyPerSecond: 3, // energy spent per second at strength 1
  defaultStrength: 0.5, // for Jets placed in the editor, until changed
  minStrength: 0.01, // below this firing strength a Jet doesn't fire at all
};

export const NEURON = {
  maxRate: 8, // per second: how fast a neuron at speed 1 moves its output toward its target
  defaultBias: 0,
  defaultSpeed: 0.5,
};

export const SENSOR = {
  readDistance: 30, // world units ahead where Light, Nutrient and Temperature sensors read
  coneHalfAngle: 60, // degrees: Proximity sensors count cells within this angle of where they face
  nutrientFull: 40, // water nutrient per tile that reads as level 1 (twice the even starting share)
  touchDistance: 2.2, // touch sensor reach, in cell radii, center to center
  proximityRange: 7, // proximity sensor range, in cell radii
  proximityFull: 8, // other organisms' cells in range that read as level 1
  changeWindowSec: 2, // "recent" window for the change output (moving average time constant)
  changeScale: 0.15, // level difference from the recent average that reads as change ±1
};

export const MOUTH = {
  drainRate: 30, // energy per second drained from each living cell a Mouth touches
  efficiency: 0.5, // fraction of drained energy the Mouth gains; the rest is lost
  touchDistance: 2.2, // center-to-center distance that counts as touching, in cell radii (2 = edges meet)
};

export const METABOLISM = {
  upkeep: 0.6, // energy per second per living cell at multiplier 1
  /** Upkeep multiplier per cell type (absent = 1). Support cells cost less to keep. */
  typeUpkeep: {
    decomposer: 0.4,
    fat: 0.5,
    neuron: 0.5,
    lightSensor: 0.6,
    nutrientSensor: 0.6,
    temperatureSensor: 0.6,
    touchSensor: 0.6,
    proximitySensor: 0.6,
    shell: 0.2,
    tip: 0.5,
    timer: 0.5,
  } as Record<string, number>,
  coldMultiplier: 0.5, // upkeep multiplier at TEMPERATURE.edge
  warmMultiplier: 1.5, // upkeep multiplier at TEMPERATURE.center
};

/** Colony discount: cells of bigger organisms pay less upkeep each. */
export const COLONY = {
  maxDiscount: 0.3, // upkeep reduction at full colony size
  fullSize: 8, // cells in an organism for the full discount (scales linearly from 1 cell)
};

export const BONDS = {
  stiffness: 0.6, // fraction of a bond's length error corrected per solver pass (1 = rigid)
  shapeStiffness: 0.25, // fraction of the way each cell is pulled back toward the body's designed shape per solver pass (0 = floppy, 1 = rigid)
  energyFlowRate: 2, // fraction of the energy difference moved across a bond per second
  nutrientFlowChance: 0.2, // chance per tick that 1 stored nutrient unit moves down a bond's gradient
};

export const GROWTH = {
  checkInterval: 10, // ticks between growth/reproduction checks per organism
  energyLoss: 0.3, // fraction of the energy spent to add a cell that is lost; the rest starts the new cell
  lostMemory: 32, // lost cell spots an organism remembers, to regrow first
  keepEnergy: 10, // energy a cell must keep after paying for a new cell or bud (so it doesn't starve right after)
  launchSpeed: 150, // world units per second given to offspring at launch strength 1 (water drag slows them)
  budShare: 0.25, // a bud also gets this share of the organism's spare energy and stored nutrient
};

/** Organism designs (editor) and their limits. */
export const DESIGN = {
  maxCells: 60, // most cells a design can grow to
  gridRadius: 5, // editor hex grid radius
  growEnergyDefault: 40,
  growEnergyMin: 10,
  growEnergyMax: 90,
  growNutrientDefault: 8, // must be at least CELL.bodyNutrient; the surplus starts the new cell's store
  growNutrientMax: 16,
  blobMaxCellsDefault: 12,
  patternMaxRepeatsDefault: 5,
  patternMaxRepeatsMax: 12,
  fragmentPieces: 3, // pieces a Fragment organism breaks into
  steerWeight: 0.6, // weight of the connections "steer toward/away" creates
};

export const DEAD = {
  decayChance: 0.005, // chance per tick that a dead cell returns 1 nutrient unit
  sinkSpeed: 2, // world units per second dead cells drift toward deeper water ("marine snow")
};

export const PHYSICS = {
  iterations: 3, // contact solver passes per tick
  drag: 0.9, // per tick, how much velocity is kept; the rest relaxes toward the current
};

// ---------------------------------------------------------------- presentation

export const CAMERA = {
  panSpeed: 900, // screen pixels per second for WASD
  zoomSpeed: 0.0015, // zoom factor per wheel delta unit (exponential)
  maxZoom: 8, // screen pixels per world unit
  dragThreshold: 5, // screen pixels before a press becomes a drag
};

export const WATER = {
  // Dark stage: the water is a quiet backdrop with only a hint of depth, so the
  // glowing cells carry the color. Overlays show terrain detail when wanted.
  deepColor: 0x010204,
  shallowColor: 0x072832,
  shallowPower: 1.8, // >1 keeps more of the world dark
  nightFloor: 0.35, // water brightness multiplier at midnight
};

/** Vent glow drawn over the water. */
export const VENT_RENDER = {
  color: 0xff7a3d,
  size: 1.6, // glow diameter, as a multiple of the vent's diameter (2 × VENTS.radius)
  alphaDay: 0.12,
  alphaNight: 0.3,
  shimmerHz: 0.25,
};

export const OVERLAY = {
  dimArt: 0.7, // art brightness under an active overlay
  // Currents: streak particles traced through the current field.
  streakCount: 900,
  streakSpeedPx: 160, // screen px/s for the strongest current
  streakLengthPx: 34, // screen px for the strongest current
  streakWidthPx: 2,
  streakLife: 2.5, // seconds
  streakColor: 0x9ff8ff,
  streakAlpha: 0.75,
  // Nutrient: amber haze.
  nutrientColor: 0xffb347,
  nutrientStrength: 0.55,
  nutrientDepletedDim: 0.45, // art brightness where the water is fully depleted
  // Temperature: translucent gradient with isotherms.
  coolColor: 0x3d7bff,
  warmColor: 0xff6a3d,
  temperatureAlpha: 0.32,
  isothermStep: 2, // °C between isotherm lines
  isothermAlpha: 0.35,
  // Depth: nautical-chart contours.
  contourMinor: 10, // meters
  contourMajor: 50, // meters
  contourColor: 0xbfe9ff,
  contourMinorAlpha: 0.22,
  contourMajorAlpha: 0.6,
  // Light: soft pale glow.
  lightColor: 0xfff3cf,
  lightStrength: 0.6,
};

/** Per-type look: membrane, glow and inner mark colors, mark size (in cell radii). */
export const CELL_STYLE = {
  leaf: { color: 0x37d8a8, glow: 0x2effc4, mark: 0xd4ffe6, markSize: 1.3, membraneScale: 1 },
  mouth: { color: 0xff3d7a, glow: 0xff2d6e, mark: 0xffb8d4, markSize: 1.1, membraneScale: 1 },
  root: { color: 0xc8843c, glow: 0xffa040, mark: 0xffd08a, markSize: 1.7, membraneScale: 1 },
  fat: { color: 0xffe9a6, glow: 0xfff0b8, mark: 0xfff7dc, markSize: 1.1, membraneScale: 1.1 },
  spike: { color: 0xc9b6ff, glow: 0xe6dcff, mark: 0xffffff, markSize: 2.5, membraneScale: 1 },
  decomposer: { color: 0x7d8c34, glow: 0x9db040, mark: 0xd6e08a, markSize: 1.4, membraneScale: 1 },
  jet: { color: 0x3d9bff, glow: 0x4db4ff, mark: 0xcfe8ff, markSize: 1, membraneScale: 1 },
  lightSensor: { color: 0xfff27a, glow: 0xfff59a, mark: 0xfffbe0, markSize: 1.7, membraneScale: 1 },
  nutrientSensor: { color: 0x9cff8a, glow: 0xb4ffa0, mark: 0xe8ffe0, markSize: 1.7, membraneScale: 1 },
  temperatureSensor: { color: 0xff7a5c, glow: 0xff9478, mark: 0xffe0d8, markSize: 1.7, membraneScale: 1 },
  touchSensor: { color: 0xff9ff3, glow: 0xffb8f6, mark: 0xffe8fc, markSize: 1.7, membraneScale: 1 },
  proximitySensor: { color: 0x7ae8ff, glow: 0x9aeeff, mark: 0xe0faff, markSize: 1.7, membraneScale: 1 },
  neuron: { color: 0xd8c8ff, glow: 0xf0e8ff, mark: 0xffffff, markSize: 1.1, membraneScale: 0.85 },
  chemosynth: { color: 0xff6a3d, glow: 0xff7a40, mark: 0xffd2b8, markSize: 1.3, membraneScale: 1 },
  filter: { color: 0x8fe8e0, glow: 0xa8fff4, mark: 0xe0fffb, markSize: 1.9, membraneScale: 1 },
  shell: { color: 0xe8e2f2, glow: 0xd8d0ea, mark: 0xfaf6ff, markSize: 1.6, membraneScale: 1.05 },
  tip: { color: 0x9dff5c, glow: 0xc4ff8a, mark: 0xf0ffe0, markSize: 1.4, membraneScale: 0.95 },
  timer: { color: 0xffc9f0, glow: 0xffd8f4, mark: 0xfff0fb, markSize: 1.4, membraneScale: 0.9 },
  dead: { color: 0x6b7378, glow: 0x000000, mark: 0x50585c, markSize: 0.7, membraneScale: 1 },
};

export const CELL_RENDER = {
  membraneFill: 0.3, // interior opacity
  membraneRim: 0.22, // rim thickness, in cell radii
  drainColor: 0xff5c8f, // cue on a cell that is being drained
  drainSize: 2.7, // cue ring diameter, in cell radii
  drainAlpha: 0.75,
  drainPulseHz: 5,
  exhaustColor: 0x8fd2ff, // Jet exhaust trail
  exhaustLength: 3.2, // in cell radii
  exhaustFlickerHz: 14,
  glowRadius: 3, // in cell radii
  glowDay: 0.08, // glow alpha at noon
  glowNight: 0.45, // glow alpha at midnight
  bloomThreshold: 0.05,
  bloomScale: 1.4,
  bloomBlur: 6,
  ownerOutlineSize: 2.4, // owner-color outline ring diameter, in cell radii
  ownerOutlineAlpha: 0.8,
  bridgeWidth: 1.1, // bond bridge thickness, in cell radii
  bridgeAlpha: 0.55,
  wireAlpha: 0.45, // in-game wiring lines between cells
  wirePositive: 0x5ff5d2,
  wireNegative: 0xff5c8f,
  inspectRingColor: 0xffffff,
};

// ---------------------------------------------------------------- multiplayer

// The VITE_RELAY_PORT environment variable overrides the relay port, for both
// the relay and the dev server, so a second instance can run alongside the first.
const envRelayPort = Number(
  (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_RELAY_PORT ??
    (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.VITE_RELAY_PORT,
);

export const NETWORK = {
  relayPort: envRelayPort || 8787,
  relayHeartbeatSec: 5, // relay pings every connection this often and drops ones that stop answering
  positionHz: 15, // position updates per second sent to each client
  viewMargin: 240, // world units around a client's view that still get positions
  nutrientIntervalSec: 1, // how often changed nutrient tiles are sent
  nutrientDiffMin: 2, // a tile is re-sent once it differs from its last sent value by at least this (or reaches/leaves 0)
  inspectHz: 10, // hover info updates per second sent to each client
  statsHz: 2, // debug stats (nutrient totals) per second
  viewSendHz: 10, // max camera view updates per second from a client
};

export const PLAYERS = {
  maxPlayers: 8,
  colors: [0x5ff5d2, 0xff8a5c, 0xb48cff, 0xffd24d, 0x5cb8ff, 0xff5c9d, 0x9dff5c, 0xe6f1ff],
};

export const AUDIO = {
  volume: 0.5,
  crossfadeSec: 3, // lobby -> game track crossfade
};

// ---------------------------------------------------------------- competition

export const DNA = {
  start: 100, // DNA each player starts with
  perBiomassPerSecond: 0.001, // DNA earned per second per nutrient unit in the player's living cells
  /** DNA cost of each cell in a released design's body. Leaf is the cheapest. */
  cellCost: {
    leaf: 2,
    mouth: 6,
    root: 5,
    fat: 4,
    spike: 6,
    decomposer: 4,
    jet: 5,
    lightSensor: 3,
    nutrientSensor: 3,
    temperatureSensor: 3,
    touchSensor: 3,
    proximitySensor: 3,
    neuron: 3,
    chemosynth: 4,
    filter: 4,
    shell: 3,
    tip: 4,
    timer: 3,
  },
};

export const RELEASE = {
  gatherRadius: 4, // tiles around the release point the body's nutrient can be drawn from
};

export const LINEAGE = {
  maxLineages: 4096,
  statsIntervalSec: 1, // how often lineage stats, trophic levels and extinctions are computed
  trophicWindowSec: 120, // energy eaten fades with this time constant (the "recent window")
  trophicMax: 10, // cap for cannibal loops
  extinctionWindowSec: 90, // the "final stretch" of deaths used to credit an extinction
  spikeKillCreditSec: 3, // a cell that starves this soon after a Spike drained it counts as killed by that Spike
};

export const LEADERBOARD = {
  apexMinBiomass: 150, // nutrient in living cells a lineage needs to count for Apex Predator
  changeConfirmSec: 3, // a new leader must hold the spot this long before it's announced
};

export const FEED = {
  maxItems: 6,
  lifetimeSec: 14, // events fade out after this long
};

export const MUTATION = {
  defaultRate: 0.5, // editor slider default (0-1); chances are multiplied by rate / defaultRate
  small: 0.15, // base chance per reproduction of each small mutation
  rare: 0.02, // base chance per reproduction of each structural mutation
  weightNudge: 0.15, // max change to a wiring weight
  strengthNudge: 0.1, // max change to a Jet's base strength
  energyNudge: 4, // max change to the energy needed to add a cell
  nutrientNudge: 1, // max change to the nutrient needed to add a cell
  maxCellsNudge: 2, // max change to Blob max cells
  mixShift: 0.1, // fraction of the Blob mix moved from one kind to another
  biasNudge: 0.15, // max change to a neuron's bias
  speedNudge: 0.1, // max change to a neuron's speed
  inputNudge: 0.15, // max change to a neuron's internal input weight
  launchNudge: 0.1, // max change to launch strength
  rateNudge: 0.05, // max change to the mutation rate itself
  tipNudge: 0.15, // max change to a growth tip's base Grow, Turn or Branch
  cellsPerRoll: 4, // bigger bodies mutate more: each structural mutation gets one extra roll per this many cells
  maxRolls: 12, // most rolls of one structural mutation per offspring
  timerNudge: 0.05, // max change to a timer's phase and duty
  burstChance: 0.05, // chance an offspring mutates at burstFactor times the usual rates
  burstFactor: 4,
};

export const NEURON_INPUTS = {
  speedFull: 20, // world units per second of body speed that reads as 1 (forward / sideways)
  turnFull: 1, // radians per second of turning that reads as 1
  eatenFull: 15, // energy per second drained from cells in range that reads as 1
  eatenRangeMax: 8, // largest per-neuron "being eaten" range in cells; this value means the whole organism
  noiseDrift: 0.4, // how fast the noise input wanders (per sqrt-second)
  noisePull: 0.3, // how strongly noise drifts back toward 0 (per second)
};
