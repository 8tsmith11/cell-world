# Cell World

Competitive LAN multiplayer evolution sandbox in the browser.

## Stack and conventions

- TypeScript, Vite, PixiJS v8.
- The simulation will run in a Web Worker over flat typed arrays (one array per
  field, indexed `y * width + x`). Code in `src/sim/` must stay DOM-free so it
  can move into the worker unchanged.
- **All tuning numbers go in `src/config.ts`.** No magic numbers elsewhere.
- Implement only what the current step specifies.

## Design

### World
- Aquatic, top-down 2D world generated from a seed. The world starts empty.
- **Depth**: generated with noise.
- **Temperature**: warmest at the center, decreasing toward the edges.
  Temperature sets metabolism speed: warmer means faster energy use, movement,
  growth, and reproduction.
- **Light**: based on a day/night cycle and depth:
  `light = daylight(time) * exp(-k * depth)`.

### Currents
- Stored per tile as a direction and a strength, generated from the world seed.
- A handful of smooth streams follow curved paths through calmer water; some
  loop into large circular currents.
- Cells sample the current smoothly between neighboring tiles and drift with
  it, with water drag. Nutrient in the water does not drift.

### Presentation
- The world fills the browser window. Camera: drag or WASD to pan, scroll to
  zoom toward the cursor, clamped to the world bounds.
- Art style: bioluminescent deep, "dark stage". The water is a quiet,
  near-black backdrop with only a faint hint of blue-teal in shallows, so the
  glowing cells carry the color and the focus; overlays carry terrain detail.
  At night the water dims further. No temperature tint (temperature shows only
  in its overlay). The water is static (no animation).
- The world is a grid and is drawn honestly: each tile is one flat color from
  its own values, with no interpolation between tiles. Depth varies gradually,
  giving large shallow and deep regions.
- Overlays (player-facing, styled to match the art), switched from a toggle bar
  or hotkeys `1`–`6` (`F` cycles), with a legend for the active one:
  - Currents: animated streaks flowing along the stream paths.
  - Nutrient: soft amber haze, brighter where rich, darker where depleted.
  - Temperature: translucent warm-to-cool gradient with faint isotherm lines.
  - Depth: nautical-chart-style contour lines.
  - Contours and isotherms follow tile edges (stair-steps), since values only
    change between tiles.
  - Light: soft pale glow showing current light levels.
- Hovering shows the active overlay's local reading (current, nutrient,
  temperature, depth, or light; nothing on the plain view), plus cell fields
  when over a cell.

### Resources
- **Energy**: gained from light or eating; spent to live and move.
- **Nutrient**: the material bodies are made of. A fixed world total that moves
  between water, living bodies, and dead matter, and never drifts. Stored as
  integer units so conservation is exact; every transfer must move units, never
  create or destroy them. Each cell's nutrient is split into **body** nutrient
  (the fixed amount the cell is made of) and **stored** nutrient (surplus, up
  to a cap). The debug total (water + all cell body and stored nutrient) must
  stay constant.

### Organisms
- Organisms are made entirely of cells attached directly to each other. Every
  part is a cell. Different kinds of organisms emerge from how cells are
  combined.
- Behavior reacts to what an organism senses, not to predefined categories.
- Organisms mutate and evolve.

### Cell model
Cell data (flat typed arrays, one array per field):
`alive, type, x, y, vx, vy, angle, energy, bodyNutrient, storedNutrient, age,
organism`.

Each cell also records its spot in its organism's hex layout (`hexQ, hexR`).

Organism data: `owner, lineage, genome, cell count`.

Rules:
- The simulation runs in a Web Worker.
- Cells are circles of one fixed size.
- Cell types for now: **Leaf**, **Mouth**, **Root**, **Fat**, **Spike**,
  **Decomposer**, **Jet**, five sensors (**Light**, **Nutrient**,
  **Temperature**, **Touch**, **Proximity**) and **Dead**.
- Leaf gains energy from the light at its position.
- Every living cell (all types) pays energy upkeep each tick, scaled by
  temperature.
- Death: a cell with no energy becomes Dead. Dead cells have no upkeep and
  slowly return their nutrient (stored, then body) to the water.
- Nutrient is conserved: the on-screen total (water + cells) stays constant.

Mouth rules:
- Drifts with currents like other cells.
- While a Mouth touches a living cell, it drains that cell's energy at a fixed
  rate. Touching means the cells overlap or are within touching distance
  (contact checks use the spatial grid).
- The Mouth gains only a fraction of the drained energy (efficiency in
  `config.ts`); the rest is lost.
- When the prey's energy reaches zero, the Mouth takes all of the prey's
  nutrient (body and stored) into its stored nutrient and the prey is removed.
  Eaten cells do not become Dead.
- If the Mouth's stored nutrient is above the cap, the excess is released into
  the water at its position.
- Mouths eat only living cells, not Dead cells, and eat any living cell they
  touch, including other Mouths.
- Mouths do not absorb nutrient from the water.
- Mouths do not eat cells that are part of their own organism. They still eat
  any other organism's cells, including others of the same lineage.
- Upkeep scaled by temperature, like Leaf.
- Death: a Mouth with no energy becomes Dead, like Leaf.

Root, Fat, Spike, Decomposer, Jet:
- **Root**: an organism with any living Root cell does not move at all,
  including from currents (other cells bump off it). Absorbs nutrient from the
  water faster than Leaf. Has a high stored nutrient cap.
- **Fat**: has a high energy cap, so the organism can store extra energy. It
  acts as a reservoir: it takes a bonded neighbor's energy above a keep level
  (a fraction of the neighbor's cap) and gives energy back when the neighbor
  drops below it.
- **Spike**: drains energy from every living cell it touches that isn't part
  of its own organism. The Spike gains nothing. A drained cell that reaches
  zero energy dies (becomes Dead) as usual.
- **Decomposer**: eats Dead cells it touches: takes their nutrient into its
  stored nutrient (up to its cap) and gains a small amount of energy per unit.
  The Dead cell is removed once its nutrient is gone. Does not eat living
  cells.
- **Jet**: its exhaust points outward from the cell it's attached to (its
  earliest-placed neighbor in the design: the cell it grew from; for a starter,
  its first neighbor placed after it), and it pushes the organism the opposite
  way. Where it's placed decides which way it pushes; off-center Jets make the
  organism turn. Fires constantly at a strength (0 to 1) set in the editor,
  spending energy in proportion to strength, and only while it has energy.
  A Jet only produces thrust if the hex in its exhaust direction has no cell
  of its own organism; a blocked Jet produces no thrust and spends no firing
  energy. The editor marks blocked Jets with a warning style.
  Control by behavior comes later.

Sensor cells (each reads only at its own position; all pay upkeep scaled by
temperature like other cells):
- **Light sensor**: light level. **Nutrient sensor**: nutrient in the water.
  **Temperature sensor**: temperature.
- **Touch sensor**: whether it's touching a living cell of another organism.
- **Proximity sensor**: how many living cells of other organisms are within a
  short range. Each Proximity sensor has a filter set in the editor: any cell,
  or one chosen cell type; it counts only matching cells.
- Each sensor gives two outputs: **level**, its current reading normalized to
  0-1, and **change**, whether the reading is rising or falling over a short
  recent window (the level minus its recent moving average, scaled), -1 to 1.

Behavior wiring:
- Sensors connect to Jets. A sensor can connect to any number of Jets, and a
  Jet can receive any number of connections. Each connection has a weight
  from -1 to 1 and uses either the sensor's level or change output.
- A Jet's firing strength = its base strength + the sum of (weight × input)
  from its connections, clamped to 0-1 (below a tiny minimum it doesn't fire).
- Wiring only applies to Form designs for now (other growth types ignore it
  and fire at their base strength). Wires refer to body slots; each cell
  remembers which slot it fills, so a Jet finds its sensors in its own
  organism.

Resource flow:
- Leaves (and Roots, faster) absorb nutrient from the water at their position
  into stored nutrient, up to their cap.
- Mouths gain stored nutrient by eating.
- Energy and stored nutrient flow across bonds between attached cells. Energy
  evens out (Fat is the reservoir exception above); stored nutrient moves
  toward equal fullness relative to each cell's cap, so a Root's big store
  backs up the body.
- Growth and reproduction spend stored energy and stored nutrient: adding a
  cell costs the design's energy and nutrient at the cell that grows it. The
  nutrient becomes the new body (any surplus starts its store); part of the
  energy is lost and the rest starts the new cell.
- Nutrient stays conserved.

Bonds:
- Bonds connect cells directly: cell A, cell B, rest length. Every pair of
  neighboring cells in an organism's hex layout is bonded.
- Stiff constraints that don't fully correct each step, so the body can flex.
- A bond breaks when either cell dies or is eaten.
- If an organism becomes disconnected, each connected piece becomes its own
  organism with the same genome.

Genome (per organism; compiled from a design made in the editor):
- Growth type:
  - **Form**: grows the exact designed body cell by cell in the designed
    order, then stops.
  - **Blob**: grows the body, then adds cells at random free spots on its edge,
    up to max cells. New cells' types follow the mix of cell types in the body
    (Jets it adds use the average strength of the body's Jets).
  - **Pattern**: repeats a designed motif (the body) up to a max repeat count.
    The motif has one start cell and one or more end points. Each new repeat
    attaches its start cell to an end point of the previous repeat, continuing
    in the direction from start to end. One end point makes a chain; several
    make it branch.
- Form and Pattern compile to an ordered plan of hex slots; an organism always
  grows the earliest free slot that touches its body, so pieces left after a
  split regrow what they're missing.
- Organisms try to regrow cells they lose (eaten, or died) when they can: they
  remember each lost spot and its cell type (pieces that come apart keep the
  memory) and refill those spots, as they were, before any Blob random growth.
  A dead cell's corpse occupies its spot until it decays or is decomposed.
- Max cells, and the stored energy and nutrient needed to add a cell.
- Reproduction type: **Split** (two halves), **Bud** (releases a single
  starter cell that grows the full design from scratch), **Fragment** (breaks
  into several pieces that each keep growing). Form allows only Bud; Blob and
  Pattern allow all three.
- Reproduces when it reaches max size and has enough stored energy and
  nutrient.
- Built-in single-cell designs "Leaf" and "Mouth" (Form + Bud) are always
  available.

Cell rendering:
- Translucent membranes with a brighter edge and a small inner mark for their
  type.
- Living cells glow (additive blending + bloom); glow is most visible at night.
- Leaf: green-cyan glow with small bright chloroplast dots.
- Mouth: magenta-red glow with a ring-shaped inner mark.
- Root: earthy amber glow with branching root-line marks.
- Fat: soft pale yellow glow, slightly fuller-looking.
- Spike: sharp white-violet glow with spike marks around the edge.
- Decomposer: murky olive-green glow with a swirl mark.
- Jet: bright blue glow, a chevron pointing the way it pushes, and a small
  flickering exhaust trail while firing.
- Sensors: each has its own color and a small antenna-like mark.
- Dead: dull gray, no glow, slowly fading.
- A brief pulsing cue on a cell while a Mouth, Spike or Decomposer drains it.
- Bonded cells are joined by a soft bridge in their colors.

### Organism editor
- Opened from a button in the game UI. Each player has their own; designs are
  saved, named and loaded in that player's browser.
- Hex grid for designing; cells snap to hex positions.
- Body tab: place Leaf, Mouth, Root, Fat, Spike, Decomposer, Jet and the five
  sensor cells (each must touch an earlier one). The first cell is the starter. For Form,
  each cell shows its growth order. Each Jet shows an arrow for the direction
  it pushes, and has its own strength slider. Each Proximity sensor has a type
  filter (any cell, or one cell type).
- Growth tab: growth type and its settings (energy and nutrient per new cell;
  Blob max cells, with the cell mix shown from the body; Pattern max repeats and the motif
  editor, where the player marks the start cell and end points).
- Reproduction tab: reproduction type, limited by growth type, and the
  mutation rate slider.
- Behavior tab (Form only): click a sensor, then a Jet, to connect them. Each
  connection has a weight slider and a level/change toggle. Connections show
  as lines between cells, colored by positive or negative weight (dashed for
  change).
- Preview animates the design growing from its starter cell. Stats: cell
  count, upkeep per tick, nutrient needed to grow, nutrient needed to
  reproduce.
- Styled to match the bioluminescent art.

### Multiplayer (LAN)
- A small Node WebSocket relay (`server/relay.ts`, `npm run relay`) forwards
  messages between one host and its clients and prints the LAN address to join.
  It pings connections and drops ones that stop answering, so a vanished host
  frees the slot. `VITE_RELAY_PORT` overrides the port (for the relay and the
  dev server alike), so a second instance can run alongside the first.
- The host's browser runs the simulation (in its worker) and is authoritative.
- On join, the host sends the world seed, its config, and a full snapshot.
  Clients regenerate the static world from the seed.
- After that the host sends only changes: cell births, deaths and type changes
  as events; changed nutrient tiles, periodically; quantized positions only for
  cells in or near each client's camera view (clients send their view), at
  10-20 Hz, interpolated on the client; and the time of day.
- Each client has its own camera and overlays.

### Screens
- Start screen: glowing, membrane-styled "Cell World" title; username; Host, or
  Join with the host's address.
- Lobby: title at the top; connected players with usernames and assigned
  colors; the host has a Start button and a Debug Mode toggle (clients never
  see it).
- Regular game: no debug text, seed, nutrient total or control hints. A small
  sun/moon dial shows the time of day. Overlay bar, legend and hover info.

### Music
- CC0 tracks (credited in `CREDITS.md`): a calm, ethereal track on the start
  screen and lobby, a slow underwater ambient track in game. Both loop; the
  lobby track crossfades into the game track when the game starts.

### Debug mode
- Only when the host enabled it in the lobby; there is no in-game toggle.
- The host can reroll the seed (`R`), spawn any saved design for free (pick it
  in the panel, then click empty water; the panel lists the built-ins and
  every player's saved designs, which clients share with the host; the
  organism belongs to that player; "Off" returns clicks to normal releasing), pause
  (`Space`), single-step (`N`), and set the simulation speed with a slider
  (0.25x to 8x; more fixed-size ticks per second, not a bigger time step).
- The seed and nutrient total are shown.
- Hovering a cell shows its fields, including body and stored nutrient.

### Players
- Players unlock new cell types and abilities during a match.
- DNA (the unlock currency) comes from biomass.

### Mutation
- Each organism has its own genome. When an organism reproduces, the
  offspring's genome is a copy of the parent's with a chance of mutations
  (base rates in `config.ts`). Offspring are: a Bud's new organism, and the
  pieces split off by Split/Fragment (the largest piece stays the parent).
  Pieces that come apart because a cell died are not offspring and keep the
  genome unchanged.
- Each design has a mutation rate set in the editor (slider, default in the
  middle). It scales all mutation chances (the middle = base rates, 0 = exact
  copies) and is inherited by offspring.
- Small, frequent mutations: nudge wiring weights; nudge Jet base strength;
  nudge Blob max cells and the energy and nutrient needed to add a cell;
  Blob: shift cell mix proportions between kinds it already uses (a genome
  can carry its own mix weights, starting from the body's mix); Pattern:
  change the repeat count.
- Rare, structural mutations: change a cell's type; add a cell on the edge of
  a Form or a Pattern motif; remove a cell, only if the design stays
  connected; add or remove a wiring connection.
- Each mutation is kept only if the design stays valid. Mutated offspring stay
  in the same lineage and owner.
- Hover info shows an organism's generation (released = 1, +1 per
  reproduction) and its number of mutations (accumulated along its ancestry).

### Copy an individual
- Clicking a cell selects its organism. When it's one of your own, the
  selection panel shows "Save as design" (not available for other players'
  organisms).
- It saves that organism's current genome (body, growth type, reproduction
  type, wiring, mutation rate, and settings) as a new design in your editor,
  named "<original design name> (evolved)" by default, and opens it there.
  It can be renamed and edited like any other design.
- Releasing it follows the normal rules, so its first release starts a new
  lineage.

### Ownership and lineages
- Every organism belongs to a player and a lineage. Offspring and split
  pieces inherit both. Each cell keeps its lineage, also after death (so
  Decomposers count as eating that lineage).
- The owner's color shows as a thin outline around each of their living cells.

### DNA and releasing
- Players start with some DNA and earn it over time from their total biomass
  (nutrient in their living cells). Each player sees only their own DNA.
- Players choose a saved design, then click the map to release one organism;
  each click releases another. A release places only the design's starter
  cell, which then grows the rest. Its body is built from nutrient in the
  water around the release point (nearest tiles first, within a radius). If
  there isn't enough, the release fails and costs nothing. Releasing never
  creates nutrient.
- Each release costs DNA: the sum of its body cells' costs. Each cell type has
  its own cost; Leaf is the cheapest.
- The first release of a design starts a new lineage, shown as
  "<player>'s <design name>". Later releases of the same design (same player,
  same name) join it. Releasing a design whose lineage went extinct starts a
  fresh lineage.
- The host's browser is authoritative for DNA: it reserves the cost, asks the
  sim to release, and refunds if the release fails.

### Trophic level (per lineage)
- Energy from light counts as level 1; energy eaten from a prey lineage counts
  as 1 + that lineage's level. A lineage's level is the energy-weighted
  average over a recent (exponentially fading) window. So producers are level
  1, and pure consumers are 1 + the average level of what they eat, weighted
  by energy gained from each prey lineage. Mouth bites and Decomposer meals
  count; Spikes gain nothing, so they don't.

### Leaderboard, events
- Toggleable leaderboard panel (button or `L`): Apex Predator (highest trophic
  level among lineages above a minimum biomass), Most Biomass, Largest
  Population (living organisms), Largest Organism (most cells in one living
  organism), Most Energy (total stored energy), Oldest Lineage (longest
  continuous survival). Each shows the lineage name and the owner's color.
- When a lineage goes extinct, the lineage that caused most of its deaths in
  its final stretch (by eating, or by Spike: a cell that starves soon after a
  Spike drained it) gets the credit: "<lineage> drove <lineage> extinct." If
  it mostly starved: "<lineage> died out."
- Leader changes are announced ("<lineage> is the new <category>.") once the
  new leader has held the spot briefly.
- Recent events show in a small fading feed.
- A collapsible panel lists the player's own species with the number of
  living organisms in each (extinct ones marked).

## Roadmap

- [x] **Step 1 — World generation**: seeded grid; depth (noise), temperature
  (radial gradient), light (day/night × depth), nutrient (fixed total spread
  evenly, total shown on screen). PixiJS rendering with live light. `R` rerolls
  the seed, `F` cycles field overlays, seed shown on screen. No organisms.
- [x] **Step 2 — Camera, art style, Leaf cells**: full-window world, camera,
  bioluminescent water shader; worker simulation of single-cell Leaf/Dead
  organisms (division, death, decay); membrane + glow rendering; debug tools.
- [x] **Step 3 — Currents, overlays, debug mode**: stream/loop currents that
  cells drift with; player-facing overlays with toggle bar, hotkeys and legend;
  hover readout; backtick debug mode.
- [x] **Step 4 — LAN multiplayer**: relay server, start screen and lobby,
  host-authoritative replication with deltas, regular vs debug game, music.
- [x] **Step 5 — Mouth cells**: body/stored nutrient split; Mouth predator
  (drain on contact, eat, store with cap, divide from store); drain cue; debug
  spawn type choice.
- [x] **Step 6 — Multicellular organisms**: resource flow, bonds, genomes
  (Form/Blob/Pattern growth; Split/Bud/Fragment reproduction), organism
  editor, debug spawning of saved designs.
- [x] **Step 7 — More cell types**: Root, Fat, Spike, Decomposer, Jet, with
  rendering and editor support.
- [x] **Step 8 — Competition**: ownership outlines, DNA, releasing, lineages,
  trophic levels, leaderboard, extinction and leader events, species panel.
- [x] **Step 9 — Sensors and behavior**: five sensor cells with level/change
  outputs, sensor-to-Jet wiring in the editor (Form designs).
- [x] **Step 10 — Mutation**: per-organism genomes, mutation on reproduction,
  generation and mutation counts, saving an evolved individual as a design.

## Layout

- `src/config.ts` — all tuning numbers.
- `src/sim/` — DOM-free simulation: `rng.ts` (seeded PRNG), `noise.ts` (seeded
  Perlin + fBm), `world.ts` (world fields, generation, day/night step),
  `currents.ts` (current generation and smooth sampling, shared with rendering),
  `sim.ts` (cells, organisms, tick), `worker.ts` (worker entry), `protocol.ts`
  (messages between main thread and worker).
- `src/render/` — PixiJS rendering: `water.ts` (water + overlay shader),
  `streaks.ts` (currents overlay particles), `cells.ts` (membranes, marks,
  glow), `camera.ts`.
- `src/net/` — multiplayer: `relay.ts` (browser relay connection and JSON
  messages), `codec.ts` (binary snapshot/event/nutrient/position messages),
  `host.ts` (host session: lobby, worker, delta streams), `client.ts` (client
  session: replicated state, interpolation), `config-sync.ts`.
- `src/sim/mutation.ts` — mutation operators.
- `src/sim/lineages.ts` — lineage table, trophic levels, death credit,
  extinctions, per-lineage stats.
- `src/net/leaderboard.ts` — leaderboard categories.
- `src/sim/genome.ts` — hex math, designs, validation, compiling a design into
  a growth plan (shared by the sim and the editor).
- `src/ui/editor.ts` — organism editor; `src/ui/designs.ts` — saved designs.
- `src/game.ts` — in-game view (rendering, camera, input, overlays, hover, dial,
  debug HUD), fed by a `GameSource` (`src/game-source.ts`) from either session.
- `src/main.ts` — start screen and lobby flow. `src/audio.ts` — music.
- `server/relay.ts` — the LAN relay. `public/audio/` — music files.

## Commands

- `npm run relay` — LAN relay (run on the host's machine)
- `npm run dev` — dev server, reachable on the LAN so other players can load
  the game from the host's machine
- `npm run build` — typecheck + production build
