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
- Aquatic, top-down 2D world generated from a seed (362 × 272 tiles). The
  world starts empty.
- **Depth**: generated with noise.
- **Temperature**: warmest at the center, decreasing toward the edges, and
  colder in deep water (`TEMPERATURE.depthCooling` at the deepest point).
  Temperature sets metabolism speed: warmer means faster energy use, movement,
  growth, and reproduction.
- **Vents**: a few rare hydrothermal vents (`VENTS`) in deep water, spread
  apart. Each is a soft spot of vent strength (0-1) that feeds Chemosynth
  cells, day and night. Shown as a faint warm glow over the water.
- **Light**: based on a day/night cycle and depth:
  `light = daylight(time) * exp(-k * depth)`.

### Currents
- Stored per tile as a direction and a strength, generated from the world seed.
- A handful of smooth, wide streams follow curved paths through calmer water;
  some loop into large circular currents. Calm water drifts at a typical
  (mean) `calmSpeed`, clamped so no calm spot gets stream-fast. Where streams
  overlap, speed approaches `CURRENTS.maxSpeed` (soft cap) instead of adding up.
- Cells sample the current smoothly between neighboring tiles and drift with
  it, with water drag.
- Currents carry water nutrient: every `NUTRIENT_FLOW.intervalTicks`, each
  tile sends whole units downstream to its neighbors (plus a little diffusion),
  computed from a snapshot so every unit leaving one tile arrives in another.
  Nothing flows out of the world.

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
  between water, living bodies, and dead matter, and is never created or
  destroyed (currents move it between tiles). Stored as
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
  **Temperature**, **Touch**, **Proximity**), **Neuron**, **Chemosynth**,
  **Filter**, **Shell**, **Growth tip**, **Timer** and **Dead**.
- Leaf gains energy from the light at its position.
- Every living cell (all types) pays energy upkeep each tick, scaled by
  temperature, by its type (`METABOLISM.typeUpkeep`: support cells such as
  sensors, neurons, timers, tips, Fat, Shell and Decomposers cost less), and
  by a colony discount: cells of bigger organisms pay up to
  `COLONY.maxDiscount` less, reaching it at `COLONY.fullSize` cells.
- Death: a cell with no energy becomes Dead. Dead cells have no upkeep and
  slowly return their nutrient (stored, then body) to the water. They drift
  slowly down the depth slope ("marine snow", `DEAD.sinkSpeed`), carrying
  nutrient into deep water.
- Nutrient is conserved: the on-screen total (water + cells) stays constant.

Mouth rules:
- Drifts with currents like other cells.
- While a Mouth touches a living cell, it drains that cell's energy at a fixed
  rate (`MOUTH.drainRate`, 30/s; Shells only at `SHELL.mouthDrainFactor` of
  it). A Mouth biting a Spike loses `SPIKE.retaliation` energy per second. Touching means the cells overlap or are within touching distance
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
  water faster than Leaf, from a wide area: each unit comes from the richest
  tile within `ROOT.absorbRadius`. Has a somewhat larger stored nutrient cap.
- **Fat**: has high energy and stored nutrient caps, so the organism can store
  extra energy and nutrient. It acts as a reservoir: it takes a bonded
  neighbor's energy above a keep level (a fraction of the neighbor's cap) and
  gives energy back when the neighbor drops below it, but never gives away its
  own reserve. Below its reserve it fills up from its neighbors like any cell.
- **Spike**: defensive only. It never drains anything itself; a Mouth that
  bites it loses `SPIKE.retaliation` energy per second (more than the Mouth
  gains). A Mouth that starves soon after counts as killed by the Spike's
  lineage.
- **Decomposer**: eats Dead cells it touches: takes their nutrient into its
  stored nutrient and gains a small amount of energy per unit. It always eats
  while touching one; nutrient above its store cap goes into the water at its
  position.
  The Dead cell is removed once its nutrient is gone. Does not eat living
  cells. Pays reduced upkeep (`METABOLISM.typeUpkeep.decomposer`).
- **Chemosynth**: gains energy from vents (`CHEMOSYNTH.rate` × vent strength
  at its position), day and night. Absorbs nutrient from the water like a Leaf.
- **Filter**: feeds on water moving through it: the current at its position
  relative to the cell's own velocity. Energy per second =
  `FILTER.energyRate` × flow (relative speed / `fullSpeed`, up to 1) × water
  nutrient (/ `fullNutrient`, up to 1); it also absorbs nutrient at
  `FILTER.absorbRate` × flow. Drifting cells barely feed, so it pays off on
  anchored (Root) or swimming bodies.
- **Shell**: armor. Very low upkeep, and Mouths drain it slowly.
- **Jet**: its exhaust points outward from the cell it's attached to (its
  earliest-placed neighbor in the design: the cell it grew from; for a starter,
  its first neighbor placed after it), and it pushes the organism the opposite
  way. Where it's placed decides which way it pushes; off-center Jets make the
  organism turn. Fires constantly at a strength (0 to 1) set in the editor,
  spending energy in proportion to strength, and only while it has energy.
  A Jet only produces thrust if the hex in its exhaust direction has no cell
  of its own organism; a blocked Jet produces no thrust and spends no firing
  energy. The editor marks blocked Jets with a warning style.

Sensor cells (all pay upkeep scaled by temperature like other cells):
- Every sensor is directional: like a Jet, it faces outward from the cell it's
  attached to.
- **Light sensor**: light level. **Nutrient sensor**: nutrient in the water.
  **Temperature sensor**: temperature. These three read at a point a set
  distance ahead in the direction they face (`SENSOR.readDistance`).
- **Touch sensor**: whether it's touching a living cell of another organism.
- **Proximity sensor**: how many living cells of other organisms are within a
  short range and inside a cone ahead (`SENSOR.coneHalfAngle`). Each Proximity
  sensor has a filter set in the editor: any living cell, one chosen cell type,
  or Dead cells; it counts only matching cells.
- Each sensor gives two outputs: **level**, its current reading normalized to
  0-1, and **change**, whether the reading is rising or falling over a short
  recent window (the level minus its recent moving average, scaled), -1 to 1.

**Timer** cell (a source, wired like a sensor; it doesn't face anywhere):
- Follows the time of day, so it stays aligned with day and night. Settings:
  cycles per day (1 to `TIMER.maxCycles`), when in its cycle it switches on
  (phase, 0-1) and how long it stays on (duty, 0-1).
- Level is 1 while on and 0 while off, ramped over `TIMER.edge` of a cycle;
  change works like a sensor's.
- New timers (placed in the editor or added by mutation) start random over a
  wide range (mostly 1 cycle per day, any phase), so diurnal or nocturnal
  behavior can evolve.

**Growth tip** cell (a target, wired like a Jet):
- Three signals, each its base (set in the editor) + sum of (weight × input)
  on that channel, clamped to -1..1: **Grow**, **Turn** and **Branch**. Each
  wire into a tip picks its channel.
- It faces a hex direction, starting outward from the cell it's attached to.
- With any tips, an organism grows only while at least one tip's Grow is above
  `TIP.growThreshold`.
- Form, Pattern and Worm: the free planned spot nearest an active tip grows
  next (the plan stays exact).
- Blob (after its drawn body and lost spots): the next active tip, in turn,
  turns 60° right or left if Turn is above or below ±`TIP.turnThreshold`,
  grows the spot it faces and moves onto it, leaving the next cell type of its
  repeating deposit list (up to `TIP.maxDeposit` types) behind. If Branch is
  above `TIP.branchThreshold` (at most every `TIP.branchCooldown` advances) it
  also starts a new tip beside the cell it left, facing that side (alternating
  sides), with the same settings and wiring. If every active tip stays blocked
  for `TIP.stuckChecks` growth checks, the Blob grows one random edge cell.

**Neuron** cell:
- Takes wired inputs and produces an output from -1 to 1:
  target = tanh(bias + sum of (weight × input)). The output moves toward the
  target at the neuron's own speed (0 to 1; slow neurons hold state).
- All inputs use the previous tick's outputs, so loops (including a neuron
  wired to itself) are well defined.
- Internal inputs, each with its own weight (-1 to 1) set on the neuron:
  - **Velocity**: forward, sideways and turning speed relative to the body
    (forward = the way its Jets push overall).
  - **Being eaten**: energy drained by Mouths or Spikes from cells within the
    neuron's range (a number of cells, up to the whole organism).
  - **Energy**: the organism's stored energy as a fraction of capacity.
  - **Nutrient**: stored nutrient as a fraction of capacity.
  - **Size**: cells as a fraction of max cells.
  - **Noise**: a slowly drifting random value.
- Bias and speed are set per neuron in the editor (defaults in `config.ts`).

Behavior wiring:
- Sources: sensor and timer outputs (level or change) and neuron outputs.
  Targets: Jets, Neurons and Growth tips. Any source connects to any number of targets, and any target
  takes any number of connections. Each connection has a weight from -1 to 1.
- A Jet's firing strength = its base strength + the sum of (weight × input)
  from its connections, clamped to 0-1 (below a tiny minimum it doesn't fire).
- Wiring applies to every growth type. In Blob it applies to the drawn body;
  cells Blob adds later are unwired (tips that branch keep their wiring). In
  Worm, wiring inside the segment is copied into every segment (same, previous
  or next), wiring to the head uses the first segment and to the tail the last. Wires refer to
  body slots; each cell remembers which slot it fills, so a target finds its
  sources in its own organism.
- Pattern: wiring drawn in the motif is copied into every repeat. Each
  connection's target is in the same repeat, the previous repeat (the one this
  repeat attached to), or the next repeats (every repeat attached to this
  one).

Resource flow:
- Leaves and Chemosynths (and Roots, faster, from a wide area) absorb nutrient
  from the water into stored nutrient, up to their cap. Filters absorb with
  the flow through them.
- Mouths gain stored nutrient by eating.
- Energy and stored nutrient flow across bonds between attached cells. Energy
  evens out (Fat is the reservoir exception above); stored nutrient moves
  toward equal fullness relative to each cell's cap, so a Root's big store
  backs up the body.
- Growth and reproduction spend stored energy and stored nutrient, pooled
  across the whole organism: the cell that grows it pays first, then the cells
  with the most to spare, each keeping a small energy reserve
  (`GROWTH.keepEnergy`; Fat keeps its own reserve). The nutrient becomes the
  new body (any surplus starts its store); part of the energy is lost
  (`GROWTH.energyLoss`) and the rest starts the new cell.
- A bud also gets `GROWTH.budShare` of the organism's spare energy and stored
  nutrient, up to its caps.
- Nutrient stays conserved.

Bonds:
- Bonds connect cells directly: cell A, cell B, rest length. Every pair of
  neighboring cells in an organism's hex layout is bonded.
- Stiff constraints that don't fully correct each step, so the body can flex.
  Each organism is also pulled part of the way back toward its designed shape
  every step (best-fit rotation and position of its hex layout), so bodies
  hold their orientation and spring back after bending, with some give.
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
  - **Worm**: keeps a head and a tail and grows by adding segments between
    them. The body is drawn as head, one segment and tail; the player marks
    head and tail cells and the segment's start and end. Each next segment sits
    one step on (end - start, plus one hex), like a Pattern chain. Once the
    body is complete, a whole segment is added in one step (paid for every
    cell at once): the tail moves back by one segment and the new segment's
    cells fill the gap. Up to max segments. Slot ids stay stable as segments
    are added, so wiring and regrowth keep working.
- Form, Pattern and Worm compile to an ordered plan of hex slots; an organism
  grows the earliest free slot that touches its body (or, with growth tips,
  the one nearest an active tip), so pieces left after a split regrow what
  they're missing.
- Organisms try to regrow cells they lose (eaten, or died) when they can: they
  remember each lost spot and its cell type (pieces that come apart keep the
  memory) and refill those spots, as they were, before any Blob random growth.
  A dead cell's corpse occupies its spot until it decays or is decomposed.
- Max cells, and the stored energy and nutrient needed to add a cell.
- Reproduction type: **Split** (two halves), **Bud** (releases a single
  starter cell that grows the full design from scratch), **Fragment** (breaks
  into several pieces that each keep growing). Form allows only Bud; Blob and
  Pattern and Worm allow all three.
- Reproduces when it reaches max size and has enough stored energy and
  nutrient.
- Launch (0-1, set in the editor's Reproduction tab): offspring are shot away
  from the parent: a Bud from the cell it budded from, Split/Fragment pieces
  from the parent piece's center. 0 = no launch.
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
- Sensors: each has its own color and a small antenna-like mark pointing the
  way it faces.
- Neuron: a small bright node whose glow follows its output (tinted by sign).
- Chemosynth: warm orange-red with a vent-dot mark. Filter: pale cyan with a
  cilia fringe. Shell: nacre white with nested rings. Growth tip: bright
  spring-green bud with an arrow the way it grows. Timer: soft pink clock face.
- Wires are drawn in game as thin lines between connected cells, colored by
  positive or negative weight.
- Dead: dull gray, no glow, slowly fading.
- A brief pulsing cue on a cell while a Mouth, Spike or Decomposer drains it.
- Bonded cells are joined by a soft bridge in their colors.

### Organism editor
- Opened from a button in the game UI. Each player has their own; designs are
  saved, named and loaded in that player's browser.
- Hex grid for designing; cells snap to hex positions.
- Body tab: place any cell type (each must touch an earlier one; buttons
  explain the newer types). The first cell is the starter. For Form,
  each cell shows its growth order. Each Jet shows an arrow for the direction
  it pushes, and has its own strength slider. Each sensor shows an arrow for
  the way it faces. Each Proximity sensor has a type filter (any cell, or one
  cell type). Each Neuron has bias, speed, internal-input weight and
  being-eaten range sliders. Each Growth tip has its deposit list (chips) and
  Grow / Turn / Branch sliders. Each Timer has cycles per day, switch-on time
  and on-length sliders, with a 24-hour strip showing when it's on.
- Growth tab: growth type and its settings (energy and nutrient per new cell;
  Blob max cells, with the cell mix shown from the body; Pattern max repeats and the motif
  editor, where the player marks the start cell and end points; Worm max
  segments, and marking head, tail, segment start and segment end).
- Reproduction tab: reproduction type, limited by growth type, the launch
  slider, and the mutation rate slider.
- Behavior tab (every growth type): click a source (sensor, timer or neuron),
  then a target (Jet, neuron or growth tip) to connect them; clicking a neuron
  twice wires it to itself. Each connection has a weight slider, a
  level/change toggle for sensor and timer sources, a Grow/Turn/Branch picker
  for tip targets, and for Pattern and Worm a target picker (same, previous or
  next repeat). Connections show as lines between cells, colored by positive or
  negative weight (dashed for change).
- On any sensor, "Steer toward" and "Steer away" buttons replace that sensor's
  Jet connections with wiring that turns the organism toward or away from the
  sensor's side. These are normal, editable connections.
- Preview animates the design growing from its starter cell (Blob tips
  advance at their base signals; Worms show their full length). Stats: cell
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
  10-20 Hz, interpolated on the client; and the time of day. Water nutrient
  tiles are re-sent once they differ from what clients hold by at least
  `NETWORK.nutrientDiffMin` (or reach or leave zero), since currents move
  nutrient everywhere.
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
- The seed, nutrient total and simulation time per tick (host) are shown.
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
- Several mutations can happen in one offspring: each roll is independent.
  Now and then (`MUTATION.burstChance`) an offspring mutates at
  `burstFactor` times the usual rates.
- Small, frequent mutations (rolled per part, so bigger bodies get more): nudge
  wiring weights; nudge Jet base strength; nudge neuron bias, speed, an
  internal input weight and being-eaten range; nudge a tip's Grow, Turn or
  Branch; nudge a timer's phase and duty; nudge Blob max cells, the energy and
  nutrient needed to add a cell, launch and the mutation rate itself; Blob:
  shift cell mix proportions between kinds it already uses (a genome can carry
  its own mix weights, starting from the body's mix); Pattern and Worm: change
  the repeat / segment count.
- Rarer changes to details: a wire's output (level/change), repeat target and
  tip channel; a tip's deposit list; a timer's cycles per day.
- Rare, structural mutations, each rolled once plus once more per
  `MUTATION.cellsPerRoll` cells (up to `maxRolls`), so bigger bodies change
  more: change a cell's type (it starts with fresh settings); add a cell on
  the edge (half the time a copy of the cell it grows from; a Worm's new cell
  joins that part); remove a cell, only if the design stays connected; add or
  remove a wiring connection; change a Proximity sensor's filter; switch
  between Form and Blob; change the reproduction type; Pattern: add or remove
  an end point.
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
  its final stretch (by eating, or by Spike: a Mouth that starves soon after
  biting a Spike) gets the credit: "<lineage> drove <lineage> extinct." If
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
- [x] **Step 11 — Neurons**: directional sensors, Neuron cells with internal
  inputs, general wiring (sensors/neurons to Jets/neurons) for Form and
  Pattern, steer toward/away, wires rendered in game.
- [x] **Step 12 — Ecology pass**: 2× world; even currents that carry nutrient;
  vents, deep cooling and marine snow; Chemosynth, Filter, Shell, Growth tip
  and Timer cells; Worm growth; defensive Spikes; Fat and Root rework; Dead
  proximity filter; type upkeep, colony discount, pooled growth and bud
  provisioning; richer, size-scaled mutation; CPU performance pass and render
  culling.

## Layout

- `src/config.ts` — all tuning numbers.
- `src/sim/` — DOM-free simulation: `rng.ts` (seeded PRNG), `noise.ts` (seeded
  Perlin + fBm), `world.ts` (world fields, generation, day/night step),
  `currents.ts` (current generation and smooth sampling, shared with rendering),
  `sim.ts` (cells, organisms, tick), `worker.ts` (worker entry), `protocol.ts`
  (messages between main thread and worker).
- `src/render/` — PixiJS rendering: `water.ts` (water + overlay shader),
  `vents.ts` (vent glow), `streaks.ts` (currents overlay particles),
  `cells.ts` (membranes, marks, glow; culled to the camera view), `camera.ts`.
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
