import { Application, Container } from 'pixi.js';
import { CAMERA, CURRENTS, DEPTH, FEED, LIGHT, NUTRIENT, OVERLAY, SIM, TEMPERATURE, WORLD } from './config';
import type { GameSource, RenderCells, SpawnChoice, StaticWorld } from './game-source';
import { type Design, releaseCost } from './sim/genome';
import { Camera } from './render/camera';
import { CellView } from './render/cells';
import { Streaks } from './render/streaks';
import { Vents } from './render/vents';
import { OVERLAYS, Water, type Overlay } from './render/water';
import { type CurrentField, sampleCurrent } from './sim/currents';
import type { CellInfo } from './sim/protocol';
import { CELL_TYPE_NAMES, CellType, energyCap, storedCap } from './sim/sim';
import { dayPhase, daylight } from './sim/world';

const css = (hex: number) => `#${hex.toString(16).padStart(6, '0')}`;
const overlayLabels: Record<Overlay, string> = {
  none: 'None',
  currents: 'Currents',
  nutrient: 'Nutrient',
  temperature: 'Temperature',
  depth: 'Depth',
  light: 'Light',
};
/** How often the nutrient overlay texture is refreshed. */
const NUTRIENT_REFRESH_MS = 100;

function legendHtml(o: Overlay): string {
  const bar = (from: string, to: string) => `<div class="bar" style="background:linear-gradient(90deg,${from},${to})"></div>`;
  const ends = (...labels: string[]) => `<div class="ends">${labels.map((l) => `<span>${l}</span>`).join('')}</div>`;
  switch (o) {
    case 'currents':
      return `<div class="title">Currents</div>${bar('#0a1a1e', css(OVERLAY.streakColor))}${ends('calm', `strong · ${CURRENTS.maxSpeed} u/s`)}<div class="note">streaks flow with the water</div>`;
    case 'nutrient':
      return `<div class="title">Nutrient in water</div>${bar('#050403', css(OVERLAY.nutrientColor))}${ends('depleted', 'even', 'rich')}`;
    case 'temperature':
      return `<div class="title">Temperature</div>${bar(css(OVERLAY.coolColor), css(OVERLAY.warmColor))}${ends(`${TEMPERATURE.edge - TEMPERATURE.depthCooling}°C`, `${TEMPERATURE.center}°C`)}<div class="note">lines every ${OVERLAY.isothermStep}°C</div>`;
    case 'depth':
      return `<div class="title">Depth</div><div class="note">contours every ${OVERLAY.contourMinor} m · bold every ${OVERLAY.contourMajor} m</div>${ends(`${DEPTH.min} m`, `${DEPTH.max} m`)}`;
    case 'light':
      return `<div class="title">Light</div>${bar('#000000', css(OVERLAY.lightColor))}${ends('dark', 'full sun')}<div class="note">changes with time of day and depth · warm glows are vents (energy for Chemosynths)</div>`;
    default:
      return '';
  }
}

function cellLines(c: CellInfo): string[] {
  const lines = [
    `<span class="head">${CELL_TYPE_NAMES[c.type]} cell #${c.id}</span>`,
    `alive      ${c.alive}`,
    `energy     ${c.energy.toFixed(1)} / ${energyCap(c.type)}`,
    `body       ${c.bodyNutrient} nutrient`,
    `stored     ${c.storedNutrient} / ${storedCap(c.type)} nutrient`,
    `age        ${c.age} ticks`,
    `x, y       ${c.x.toFixed(1)}, ${c.y.toFixed(1)}`,
    `vx, vy     ${c.vx.toFixed(2)}, ${c.vy.toFixed(2)}`,
    `angle      ${c.angle.toFixed(2)}`,
    `organism   ${c.organism}`,
  ];
  if ((c.type >= CellType.LightSensor && c.type <= CellType.ProximitySensor) || c.type === CellType.Timer) {
    lines.push(`level      ${c.sensorLevel.toFixed(2)}`, `change     ${c.sensorChange >= 0 ? '+' : ''}${c.sensorChange.toFixed(2)}`);
  }
  if (c.type === CellType.Neuron) lines.push(`output     ${c.neuronOutput >= 0 ? '+' : ''}${c.neuronOutput.toFixed(2)}`);
  if (c.type === CellType.Tip) {
    const [grow, turn, branch] = c.tipSignal;
    const sign = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
    lines.push(`grow       ${sign(grow)}`, `turn       ${sign(turn)}`, `branch     ${sign(branch)}`);
  }
  if (c.org) {
    lines.push(
      `owner      ${c.org.owner}`,
      `lineage    ${c.org.lineageName ?? c.org.lineage}`,
      `generation ${c.org.generation}`,
      `mutations  ${c.org.mutations}`,
      `design     ${c.org.genome.name}`,
      `growth     ${c.org.genome.growth}, up to ${c.org.genome.maxCells} cells`,
      `reproduce  ${c.org.genome.reproduction}`,
      `cells      ${c.org.cellCount}`,
    );
  }
  return lines;
}

/** Sun/moon dial: the sun circles the dial over a day (top = noon); the moon sits opposite. */
function updateDial(dial: HTMLElement, time: number): void {
  const a = dayPhase(time) * Math.PI * 2;
  const r = 15;
  const sun = { x: 22 - Math.sin(a) * r, y: 22 + Math.cos(a) * r };
  const moon = { x: 22 + Math.sin(a) * r, y: 22 - Math.cos(a) * r };
  dial.querySelector('.sun')!.setAttribute('transform', `translate(${sun.x} ${sun.y})`);
  dial.querySelector('.moon')!.setAttribute('transform', `translate(${moon.x} ${moon.y})`);
  dial.title = `Time of day ${String(Math.floor(dayPhase(time) * 24)).padStart(2, '0')}:00`;
}

const DIAL_SVG = `<svg viewBox="0 0 44 44" width="44" height="44" aria-label="Time of day">
  <defs>
    <clipPath id="dial-face"><circle cx="22" cy="22" r="21"/></clipPath>
    <radialGradient id="sun-glow"><stop offset="0" stop-color="#fff3b0"/><stop offset="1" stop-color="#ffcf4d" stop-opacity="0"/></radialGradient>
  </defs>
  <g clip-path="url(#dial-face)">
    <rect x="0" y="0" width="44" height="22" fill="#0d2f3a"/>
    <rect x="0" y="22" width="44" height="22" fill="#030a0f"/>
    <g class="sun"><circle r="7" fill="url(#sun-glow)"/><circle r="3.6" fill="#ffd96b"/></g>
    <g class="moon"><circle r="3.4" fill="#cfe8ff"/><circle r="3" cx="1.6" cy="-1" fill="#030a0f"/></g>
    <rect x="0" y="22" width="44" height="22" fill="#030a0f" opacity="0.55"/>
  </g>
  <line x1="1" y1="22" x2="43" y2="22" stroke="rgba(110,240,220,0.35)" stroke-width="1"/>
  <circle cx="22" cy="22" r="21" fill="none" stroke="rgba(110,240,220,0.25)"/>
</svg>`;

/** The in-game view: rendering, camera, overlays, hover info, HUD. Same for host and clients. */
/** The static world's current field, for sampling. */
function worldCurrents(w: StaticWorld): CurrentField {
  return { dir: w.currentDir, strength: w.currentStrength, vx: w.currentVx, vy: w.currentVy };
}

export class Game {
  private camera = new Camera(WORLD.width * WORLD.tileSize, WORLD.height * WORLD.tileSize);
  private worldLayer = new Container();
  private water = new Water();
  private cells = new CellView();
  private streaks = new Streaks();
  private vents = new Vents();
  private overlay: Overlay = 'none';
  private buttons: HTMLButtonElement[] = [];
  private held = new Set<string>();
  private press: { x: number; y: number; dragging: boolean } | null = null;
  private pointer: { x: number; y: number } | null = null;
  private hoverId = -1;
  /** Design the host spawns on click (debug). */
  private spawnChoice: SpawnChoice | null = null;
  /** The player's saved design picked for releasing, if any. */
  private releaseChoice: Design | null = null;
  private ownDesigns: Design[] = [];
  private lastPanels = 0;
  /** Clicked organism (by one of its cells), and its latest info from the host. */
  private selectedId = -1;
  private selectedInfo: CellInfo | null = null;
  /** Called to save one of the player's own organisms' genome as a new design. */
  onSaveAsDesign: (design: Design, name: string) => void = () => {};
  private boardKey = '';
  private designsVersion = -1;
  private worldVersion = -1;
  private lastNutrientRefresh = 0;
  private hud = document.getElementById('hud')!;
  private dial = document.getElementById('dial')!;
  private legend = document.getElementById('legend')!;
  private tooltip = document.getElementById('tooltip')!;

  private constructor(
    private app: Application,
    private source: GameSource,
  ) {
    this.worldLayer.addChild(this.water.mesh, this.vents.container, this.streaks.container, this.cells.container);
    app.stage.addChild(this.worldLayer);
    this.dial.innerHTML = DIAL_SVG;
    this.buildOverlayBar();
    this.buildDebugTools();
    this.buildPanels();
    this.bindInput();
    app.ticker.add((ticker) => this.tick(ticker.deltaMS / 1000));
  }

  static async create(source: GameSource): Promise<Game> {
    const app = new Application();
    await app.init({ resizeTo: window, background: '#000000', antialias: false, preference: 'webgl' });
    document.getElementById('game')!.prepend(app.canvas);
    return new Game(app, source);
  }

  private get debugTools(): boolean {
    return this.source.isHost && this.source.debug;
  }

  // ------------------------------------------------------------- overlays

  private buildOverlayBar(): void {
    const bar = document.getElementById('overlays')!;
    bar.innerHTML = '';
    this.buttons = OVERLAYS.map((o, i) => {
      const b = document.createElement('button');
      b.innerHTML = `<kbd>${i + 1}</kbd>${overlayLabels[o]}`;
      b.addEventListener('click', () => this.setOverlay(o));
      bar.appendChild(b);
      return b;
    });
    this.setOverlay('none');
  }

  private setOverlay(o: Overlay): void {
    this.overlay = o;
    this.buttons.forEach((b, i) => b.classList.toggle('active', OVERLAYS[i] === o));
    this.legend.innerHTML = legendHtml(o);
    this.legend.style.display = o === 'none' ? 'none' : 'block';
    this.lastNutrientRefresh = 0;
  }

  /** Debug mode, host: lists built-in designs plus every player's saved designs to spawn. */
  private refreshSpawnChoices(): void {
    if (!this.debugTools || this.source.designsVersion === this.designsVersion) return;
    this.designsVersion = this.source.designsVersion;
    const select = document.getElementById('spawn-design') as HTMLSelectElement;
    const choices = this.source.spawnChoices();
    const keep = this.spawnChoice ? choices.findIndex((c) => c.label === this.spawnChoice!.label) : -1;
    select.innerHTML = '';
    // "Off": clicks use the normal release panel instead of free debug spawning.
    const off = document.createElement('option');
    off.value = '-1';
    off.textContent = 'Off (use Release)';
    select.appendChild(off);
    choices.forEach((c, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = c.label;
      select.appendChild(o);
    });
    select.value = String(keep);
    this.spawnChoice = choices[keep] ?? null;
    select.onchange = () => {
      this.spawnChoice = choices[Number(select.value)] ?? null;
      select.blur();
    };
  }

  // ------------------------------------------------------------- selection

  private select(id: number): void {
    this.selectedId = id;
    const info = this.source.hoverInfo();
    this.selectedInfo = info && info.id === id && info.org ? info : null;
    this.renderSelected();
  }

  private renderSelected(): void {
    const panel = document.getElementById('selected')!;
    const org = this.selectedInfo?.org;
    if (this.selectedId < 0) {
      panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');
    panel.innerHTML = '';
    const close = document.createElement('button');
    close.className = 'close';
    close.setAttribute('aria-label', 'Clear selection');
    close.textContent = '×';
    close.addEventListener('click', () => {
      this.selectedId = -1;
      this.selectedInfo = null;
      this.renderSelected();
    });
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = org ? (org.lineageName ?? org.genome.name) : 'Selected cell (reading…)';
    panel.append(close, title);
    if (!org) return;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `generation ${org.generation} · ${org.mutations} mutation${org.mutations === 1 ? '' : 's'} · ${org.cellCount} cells`;
    panel.append(meta);
    // Copying is only for your own organisms.
    if (org.owner === this.source.selfId) {
      const save = document.createElement('button');
      save.textContent = 'Save as design';
      save.title = "Save this organism's current genome as a new design in your editor";
      save.addEventListener('click', () => this.onSaveAsDesign(org.design, `${org.design.name} (evolved)`));
      panel.appendChild(save);
    }
  }

  // ------------------------------------------------------------- competition panels

  /** The player's saved designs, for the release picker. */
  setDesigns(designs: Design[]): void {
    this.ownDesigns = designs;
    const select = document.querySelector('#release select') as HTMLSelectElement;
    const keep = this.releaseChoice?.name ?? '';
    select.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = designs.length ? 'None' : 'Save a design first';
    select.appendChild(none);
    for (const d of designs) {
      const o = document.createElement('option');
      o.value = d.name;
      o.textContent = `${d.name} · ${releaseCost(d)} DNA`;
      select.appendChild(o);
    }
    this.releaseChoice = designs.find((d) => d.name === keep) ?? null;
    select.value = this.releaseChoice?.name ?? '';
    this.updateReleaseCost();
  }

  private updateReleaseCost(): void {
    const cost = document.querySelector('#release .cost')!;
    cost.textContent = this.releaseChoice ? 'click the map to release' : '';
  }

  private buildPanels(): void {
    const select = document.querySelector('#release select') as HTMLSelectElement;
    select.addEventListener('change', () => {
      this.releaseChoice = this.ownDesigns.find((d) => d.name === select.value) ?? null;
      this.updateReleaseCost();
      select.blur();
    });
    const btn = document.getElementById('board-btn')!;
    btn.addEventListener('click', () => this.toggleBoard());
    this.setDesigns([]);
  }

  private toggleBoard(): void {
    const board = document.getElementById('board')!;
    const open = board.classList.toggle('hidden') === false;
    document.getElementById('board-btn')!.setAttribute('aria-expanded', String(open));
  }

  /** DNA, own species, leaderboard, event feed and notices. */
  private updatePanels(now: number): void {
    const src = this.source;
    // The feed fades every frame; the rest refreshes a few times a second.
    const feed = document.getElementById('feed')!;
    const items = src.feed().filter((f) => now - f.at < FEED.lifetimeSec * 1000);
    if (feed.childElementCount !== items.length || now - this.lastPanels > 250) {
      feed.innerHTML = '';
      for (const f of items) {
        const div = document.createElement('div');
        div.className = 'item';
        const dot = document.createElement('span');
        dot.className = 'owner-dot';
        dot.style.background = dot.style.boxShadow = '';
        dot.style.background = css(f.color);
        dot.style.boxShadow = `0 0 6px ${css(f.color)}`;
        const text = document.createElement('span');
        text.textContent = f.text;
        div.append(dot, text);
        // Fade out over the last third of its life.
        const life = (now - f.at) / (FEED.lifetimeSec * 1000);
        div.style.opacity = String(Math.min(1, (1 - life) * 3));
        feed.appendChild(div);
      }
    }
    if (now - this.lastPanels < 250) return;
    this.lastPanels = now;

    // Fill in the selection once the host's info for that cell arrives.
    if (this.selectedId >= 0 && !this.selectedInfo) {
      const info = src.hoverInfo();
      if (info && info.id === this.selectedId && info.org) {
        this.selectedInfo = info;
        this.renderSelected();
      }
    }

    const dna = src.dna();
    document.getElementById('dna')!.innerHTML = dna === null ? '' : `${Math.floor(dna)} <small>DNA</small>`;
    document.getElementById('notice')!.textContent = src.notice();

    const list = document.querySelector('#species ul')!;
    const species = src.species();
    list.innerHTML = '';
    if (!species.length) {
      const li = document.createElement('li');
      li.textContent = 'None yet: release a design.';
      list.appendChild(li);
    }
    for (const s of species) {
      const li = document.createElement('li');
      if (s.extinct) li.className = 'extinct';
      const name = document.createElement('span');
      name.textContent = s.name;
      const count = document.createElement('span');
      count.textContent = s.extinct ? 'extinct' : String(s.organisms);
      li.append(name, count);
      list.appendChild(li);
    }

    const entries = src.board();
    const key = JSON.stringify(entries);
    if (key !== this.boardKey) {
      this.boardKey = key;
      const board = document.getElementById('board')!;
      board.innerHTML = '';
      for (const e of entries) {
        const row = document.createElement('div');
        row.className = 'row';
        const cat = document.createElement('span');
        cat.className = 'cat';
        cat.textContent = e.category;
        const who = document.createElement('span');
        who.className = 'who';
        if (e.lineage) {
          const dot = document.createElement('span');
          dot.className = 'owner-dot';
          dot.style.background = css(e.color);
          dot.style.boxShadow = `0 0 6px ${css(e.color)}`;
          who.append(dot, document.createTextNode(e.lineage));
        } else {
          who.textContent = '—';
        }
        row.append(cat, who);
        if (e.value) {
          const val = document.createElement('span');
          val.className = 'val';
          val.textContent = e.value;
          row.appendChild(val);
        }
        board.appendChild(row);
      }
    }
  }

  /** Debug mode, host only: a log-scale simulation speed slider and the design to spawn. */
  private buildDebugTools(): void {
    const panel = document.getElementById('debug-tools')!;
    if (!this.debugTools) return;
    this.refreshSpawnChoices();
    const slider = panel.querySelector('input')!;
    const label = panel.querySelector('output')!;
    slider.min = String(Math.log2(SIM.speedMin));
    slider.max = String(Math.log2(SIM.speedMax));
    slider.step = '0.25';
    slider.value = '0';
    const show = () => {
      const speed = 2 ** Number(slider.value);
      label.textContent = `${speed < 1 ? speed.toFixed(2) : speed.toFixed(speed % 1 ? 1 : 0)}×`;
      return speed;
    };
    slider.addEventListener('input', () => this.source.setSpeed(show()));
    // Hand focus back so game keys (WASD, Space, ...) keep working.
    slider.addEventListener('change', () => slider.blur());
    show();
    panel.classList.remove('hidden');
  }

  // ------------------------------------------------------------- input

  private bindInput(): void {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || document.body.classList.contains('editor-open')) return;
      this.held.add(e.code);
      if (e.repeat) return;
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (digit && Number(digit[1]) <= OVERLAYS.length) {
        this.setOverlay(OVERLAYS[Number(digit[1]) - 1]);
        return;
      }
      if (e.code === 'KeyL') {
        this.toggleBoard();
        return;
      }
      if (e.code === 'KeyF') {
        this.setOverlay(OVERLAYS[(OVERLAYS.indexOf(this.overlay) + 1) % OVERLAYS.length]);
        return;
      }
      if (!this.debugTools) return;
      switch (e.code) {
        case 'KeyR':
          this.source.reroll();
          break;
        case 'Space':
          e.preventDefault();
          this.source.togglePause();
          break;
        case 'KeyN':
          this.source.step();
          break;
      }
    });
    window.addEventListener('keyup', (e) => this.held.delete(e.code));
    window.addEventListener('blur', () => this.held.clear());

    const canvas = this.app.canvas;
    canvas.addEventListener('pointerdown', (e) => {
      this.press = { x: e.clientX, y: e.clientY, dragging: false };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      this.pointer = { x: e.clientX, y: e.clientY };
      const press = this.press;
      if (!press) return;
      if (!press.dragging && Math.hypot(e.clientX - press.x, e.clientY - press.y) > CAMERA.dragThreshold) {
        press.dragging = true;
      }
      if (press.dragging) this.camera.pan(e.movementX, e.movementY);
    });
    canvas.addEventListener('pointerup', (e) => {
      // Debug (host): click empty water to spawn the chosen cell type. Checks the
      // click point itself; hover state may still be from the previous frame.
      if (this.press && !this.press.dragging && this.debugTools) {
        const p = this.camera.screenToWorld(e.clientX, e.clientY);
        const cells = this.source.cells(performance.now());
        const empty = !cells || CellView.pick(cells, p.x, p.y) < 0;
        if (this.spawnChoice && empty) this.source.spawn(this.spawnChoice, p.x, p.y);
      }
      if (this.press && !this.press.dragging) {
        const p = this.camera.screenToWorld(e.clientX, e.clientY);
        const cells = this.source.cells(performance.now());
        const hit = cells ? CellView.pick(cells, p.x, p.y) : -1;
        if (hit >= 0) {
          // Clicking a cell selects its organism.
          this.select(hit);
        } else if (!(this.debugTools && this.spawnChoice) && this.releaseChoice) {
          // Release: each click on empty water releases one organism of the chosen design.
          this.source.releaseDesign(this.releaseChoice, p.x, p.y);
        }
      }
      this.press = null;
    });
    canvas.addEventListener('pointerleave', () => (this.pointer = null));
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.camera.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * CAMERA.zoomSpeed));
      },
      { passive: false },
    );
  }

  // ------------------------------------------------------------- frame

  private tick(dt: number): void {
    const src = this.source;
    const now = performance.now();
    if (src.world && src.worldVersion !== this.worldVersion) {
      this.worldVersion = src.worldVersion;
      this.water.setWorld(src.world.depth, src.world.temperature);
      this.vents.setWorld(src.world.chem);
      this.streaks.setField(worldCurrents(src.world));
      this.hoverId = -1;
      src.setHover(-1);
    }

    const pan = CAMERA.panSpeed * dt;
    const dx = (this.held.has('KeyA') ? 1 : 0) - (this.held.has('KeyD') ? 1 : 0);
    const dy = (this.held.has('KeyW') ? 1 : 0) - (this.held.has('KeyS') ? 1 : 0);
    this.camera.resize(this.app.screen.width, this.app.screen.height);
    if (dx || dy) this.camera.pan(dx * pan, dy * pan);
    this.camera.apply(this.worldLayer);
    src.setView(this.camera.viewRect());

    const water = src.water();
    if (this.overlay === 'nutrient' && water && now - this.lastNutrientRefresh > NUTRIENT_REFRESH_MS) {
      this.water.setNutrient(water);
      this.lastNutrientRefresh = now;
    }

    const time = src.time();
    const day = daylight(time);
    this.water.update(day, this.overlay);
    this.vents.update(day);
    this.streaks.update(dt, this.overlay === 'currents', this.camera);
    const cells = src.cells(now);
    if (cells) this.cells.draw(cells, day, this.hoverId, this.camera.zoom, (o) => src.playerColor(o), this.camera.viewRect());
    this.updateHover(day, cells);
    updateDial(this.dial, time);
    this.updatePanels(now);
    this.updateDebugHud();
    this.refreshSpawnChoices();
  }

  private updateHover(day: number, cells: RenderCells | null): void {
    const src = this.source;
    const world = src.world;
    const water = src.water();
    const tip = this.tooltip;
    if (!this.pointer || !world || !water || !cells || this.press?.dragging) {
      tip.style.display = 'none';
      return;
    }
    const p = this.camera.screenToWorld(this.pointer.x, this.pointer.y);
    const tx = Math.min(WORLD.width - 1, Math.max(0, Math.floor(p.x / WORLD.tileSize)));
    const ty = Math.min(WORLD.height - 1, Math.max(0, Math.floor(p.y / WORLD.tileSize)));
    const tile = ty * WORLD.width + tx;

    const id = CellView.pick(cells, p.x, p.y);
    if (id !== this.hoverId) {
      this.hoverId = id;
      src.setHover(id);
    }

    // Only the reading for the active overlay, plus cell fields when over a cell.
    const lines: string[] = [];
    switch (this.overlay) {
      case 'currents': {
        const c = { x: 0, y: 0 };
        sampleCurrent(worldCurrents(world), p.x, p.y, c);
        lines.push(`current     ${Math.hypot(c.x, c.y).toFixed(1)} u/s`);
        break;
      }
      case 'nutrient':
        lines.push(`nutrient    ${water[tile]} in water`);
        break;
      case 'temperature':
        lines.push(`temperature ${world.temperature[tile].toFixed(1)}°C`);
        break;
      case 'depth':
        lines.push(`depth       ${world.depth[tile].toFixed(0)} m`);
        break;
      case 'light':
        lines.push(`light       ${(day * Math.exp(-LIGHT.attenuation * world.depth[tile]) * 100).toFixed(0)}%`);
        if (world.chem[tile] > 0.01) lines.push(`vent        ${(world.chem[tile] * 100).toFixed(0)}%`);
        break;
    }
    const info = this.hoverId >= 0 ? src.hoverInfo() : null;
    if (info) lines.push(...(lines.length ? ['', ...cellLines(info)] : cellLines(info)));
    if (lines.length === 0) {
      tip.style.display = 'none';
      return;
    }
    tip.innerHTML = lines.join('\n');
    tip.style.display = 'block';
    const flipX = this.pointer.x + 18 + tip.offsetWidth > window.innerWidth;
    const flipY = this.pointer.y + 18 + tip.offsetHeight > window.innerHeight;
    tip.style.left = `${flipX ? this.pointer.x - 14 - tip.offsetWidth : this.pointer.x + 18}px`;
    tip.style.top = `${flipY ? this.pointer.y - 14 - tip.offsetHeight : this.pointer.y + 18}px`;
  }

  /** Debug mode only: seed and nutrient total (plus tools for the host). Nothing in a regular game. */
  private updateDebugHud(): void {
    const src = this.source;
    if (!src.debug) {
      this.hud.style.display = 'none';
      return;
    }
    const stats = src.stats();
    const total = stats ? stats.water + stats.cells : null;
    const lines = [
      `<span class="debug">DEBUG${src.paused() ? ' · PAUSED' : ''}</span>`,
      `Seed      ${src.world?.seed ?? ''}`,
      total === null
        ? 'Nutrient  …'
        : `Nutrient  ${total.toLocaleString()} = water ${stats!.water.toLocaleString()} + cells ${stats!.cells.toLocaleString()}${total !== NUTRIENT.total ? '  DRIFT!' : ''}`,
    ];
    const ms = src.stepMs();
    if (ms !== null) lines.push(`Tick      ${ms.toFixed(1)} ms (budget ${(1000 / SIM.tickHz).toFixed(0)} ms)`);
    if (src.isHost) lines.push('', '<span class="debug">R reroll · click water: spawn · Space pause · N step</span>');
    this.hud.innerHTML = lines.join('\n');
    this.hud.style.display = 'block';
  }
}
