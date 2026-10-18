import { CELL, CELL_STYLE, DESIGN, JET, METABOLISM, MUTATION, NEURON_INPUTS, SIM } from '../config';
import {
  ALLOWED_REPRODUCTION,
  areNeighbors,
  attachDirection,
  bodyMix,
  isSensor,
  isSource,
  isTarget,
  NEURON_INPUT_KEYS,
  type NeuronInput,
  neuronBias,
  neuronSpeed,
  type Wire,
  jetBlocked,
  releaseCost,
  CELL_KINDS,
  compileGenome,
  type CellKind,
  type Design,
  designStats,
  type GrowthType,
  HEX_DIRS,
  hexKey,
  hexToLocal,
  type ReproductionType,
  singleCellDesign,
  validateDesign,
} from '../sim/genome';
import { createRng } from '../sim/rng';
import { loadDesigns, storeDesigns } from './designs';

type Tab = 'body' | 'growth' | 'reproduction' | 'behavior';
type Tool = CellKind | 'erase' | 'start' | 'end';

const SVG = 'http://www.w3.org/2000/svg';
const HEX_SIZE = 22; // editor hex radius in px
const css = (hex: number) => `#${hex.toString(16).padStart(6, '0')}`;
const KIND_COLOR = Object.fromEntries(CELL_KINDS.map((k) => [k, css(CELL_STYLE[k].color)])) as Record<CellKind, string>;
const KIND_LABEL: Record<CellKind, string> = {
  leaf: 'Leaf',
  mouth: 'Mouth',
  root: 'Root',
  fat: 'Fat',
  spike: 'Spike',
  decomposer: 'Decomposer',
  jet: 'Jet',
  lightSensor: 'Light sensor',
  nutrientSensor: 'Nutrient sensor',
  temperatureSensor: 'Temp sensor',
  touchSensor: 'Touch sensor',
  proximitySensor: 'Proximity sensor',
  neuron: 'Neuron',
};
const INPUT_LABEL: Record<NeuronInput, string> = {
  forward: 'Forward speed',
  sideways: 'Sideways speed',
  turning: 'Turning speed',
  eaten: 'Being eaten',
  energy: 'Energy',
  nutrient: 'Nutrient',
  size: 'Size',
  noise: 'Noise',
};
/** Circle style for a cell kind: translucent fill, bright rim, soft glow. */
const cellStyle = (k: CellKind) =>
  `fill:${KIND_COLOR[k]}55;stroke:${KIND_COLOR[k]};filter:drop-shadow(0 0 4px ${css(CELL_STYLE[k].glow)})`;
const GROWTH_INFO: Record<GrowthType, string> = {
  form: 'Grows the exact body you designed, cell by cell in the order you placed them, then stops.',
  blob: 'Grows the body, then adds cells at random free spots on its edge, up to max cells. New cells follow the mix of cell types in the body.',
  pattern:
    'Repeats the body as a motif. Each repeat attaches its start cell to an end point of the previous one, continuing from start to end. One end point makes a chain; several make it branch.',
};
const REPRO_INFO: Record<ReproductionType, string> = {
  split: 'Divides into two halves.',
  bud: 'Releases a single starter cell that grows the full design from scratch.',
  fragment: `Breaks into ${DESIGN.fragmentPieces} pieces that each keep growing.`,
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

const hexPx = (q: number, r: number, spacing: number) => {
  const [x, y] = hexToLocal(q, r);
  return [x * spacing, y * spacing] as const;
};

function hexPoints(cx: number, cy: number, size: number): string {
  const pts: string[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 180) * (60 * k - 30);
    pts.push(`${cx + size * Math.cos(a)},${cy + size * Math.sin(a)}`);
  }
  return pts.join(' ');
}

/** The organism editor: one per player, local to this browser. */
export class Editor {
  private design: Design = singleCellDesign('New organism', 'leaf');
  private saved: Design[] = loadDesigns();
  private tab: Tab = 'body';
  private tool: Tool = 'leaf';
  /** Behavior tab: the source (sensor or neuron) picked first, waiting for a target. */
  private pendingSensor: number | null = null;
  /** Neuron settings sections left open (by body index). */
  private openNeurons = new Set<number>();
  private message = '';
  private previewTimer = 0;
  private root = document.getElementById('editor')!;

  /** Called with the full saved list whenever it changes. */
  onDesignsChanged: (designs: Design[]) => void = () => {};

  constructor() {
    document.getElementById('editor-btn')!.addEventListener('click', () => this.open());
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
      e.stopPropagation();
    });
  }

  get designs(): Design[] {
    return this.saved;
  }

  /**
   * Saves a copy of an organism's genome (body, growth, reproduction, wiring,
   * mutation rate, settings) as a new design, then opens it for renaming or editing.
   */
  saveAsNew(design: Design, name: string): void {
    let unique = name;
    for (let n = 2; this.saved.some((d) => d.name === unique); n++) unique = `${name} ${n}`;
    this.design = structuredClone(design);
    this.design.name = unique;
    this.saved.push(structuredClone(this.design));
    const ok = storeDesigns(this.saved);
    this.onDesignsChanged(this.saved);
    this.pendingSensor = null;
    this.tab = 'body';
    this.tool = 'leaf';
    this.message = ok ? `Saved "${unique}". Rename or edit it here.` : `Saved "${unique}" for this session (browser storage is unavailable).`;
    this.open();
  }

  open(): void {
    this.root.classList.remove('hidden');
    document.body.classList.add('editor-open');
    this.render();
  }

  close(): void {
    this.root.classList.add('hidden');
    document.body.classList.remove('editor-open');
    clearInterval(this.previewTimer);
  }

  private update(change: (d: Design) => void): void {
    change(this.design);
    // Keep the reproduction type legal for the growth type.
    const allowed = ALLOWED_REPRODUCTION[this.design.growth];
    if (!allowed.includes(this.design.reproduction)) this.design.reproduction = allowed[0];
    this.render();
  }

  // ------------------------------------------------------------- layout

  private render(): void {
    const r = this.root;
    r.innerHTML = '';
    const panel = el('div', { class: 'editor-panel' });
    r.appendChild(panel);

    // Header: name, save, load, close.
    const head = el('div', { class: 'editor-head' });
    head.appendChild(el('div', { class: 'editor-title' }, 'Organism editor'));
    const name = el('input', { type: 'text', maxlength: '32', value: this.design.name, 'aria-label': 'Design name' });
    name.addEventListener('input', () => (this.design.name = name.value));
    const save = el('button', {}, 'Save');
    save.addEventListener('click', () => this.save());
    const load = el('select', { 'aria-label': 'Saved designs' });
    load.appendChild(el('option', { value: '' }, this.saved.length ? 'Load a design…' : 'No saved designs'));
    this.saved.forEach((d, i) => load.appendChild(el('option', { value: String(i) }, d.name)));
    load.addEventListener('change', () => {
      if (load.value === '') return;
      this.design = structuredClone(this.saved[Number(load.value)]);
      this.pendingSensor = null;
      this.message = `Loaded "${this.design.name}".`;
      this.render();
    });
    const del = el('button', {}, 'Delete');
    del.title = 'Delete the saved design with this name';
    del.addEventListener('click', () => this.remove());
    const fresh = el('button', {}, 'New');
    fresh.addEventListener('click', () => {
      this.design = singleCellDesign('New organism', 'leaf');
      this.message = '';
      this.render();
    });
    const close = el('button', { class: 'editor-close', 'aria-label': 'Close editor' }, '×');
    close.addEventListener('click', () => this.close());
    head.append(name, save, load, del, fresh, close);
    panel.appendChild(head);

    // Tabs.
    const tabs = el('div', { class: 'editor-tabs' });
    for (const t of ['body', 'growth', 'reproduction', 'behavior'] as Tab[]) {
      const b = el('button', { class: t === this.tab ? 'active' : '' }, t[0].toUpperCase() + t.slice(1));
      b.addEventListener('click', () => {
        this.tab = t;
        this.tool = t === 'growth' && this.design.growth === 'pattern' ? 'start' : t === 'body' ? 'leaf' : this.tool;
        this.render();
      });
      tabs.appendChild(b);
    }
    panel.appendChild(tabs);

    const main = el('div', { class: 'editor-main' });
    const left = el('div', { class: 'editor-left' });
    const right = el('div', { class: 'editor-right' });
    main.append(left, right);
    panel.appendChild(main);

    if (this.tab === 'body') this.renderBodyTab(left);
    else if (this.tab === 'growth') this.renderGrowthTab(left);
    else if (this.tab === 'reproduction') this.renderReproductionTab(left);
    else this.renderBehaviorTab(left);

    right.appendChild(el('div', { class: 'editor-label' }, 'Preview'));
    const preview = svg('svg', { class: 'editor-preview', viewBox: '-150 -150 300 300' });
    right.appendChild(preview);
    this.animatePreview(preview);
    right.appendChild(this.renderStats());

    const invalid = validateDesign(this.design);
    save.disabled = invalid !== null;
    const status = el('div', { class: invalid ? 'editor-status error' : 'editor-status' }, invalid ?? this.message);
    panel.appendChild(status);
  }

  private toolbar(tools: [Tool, string][]): HTMLElement {
    const bar = el('div', { class: 'editor-tools' });
    for (const [t, label] of tools) {
      const b = el('button', { class: t === this.tool ? 'active' : '' }, label);
      if ((CELL_KINDS as readonly string[]).includes(t)) {
        const color = KIND_COLOR[t as CellKind];
        b.prepend(el('span', { class: 'swatch', style: `background:${color};color:${color}` }));
      }
      b.addEventListener('click', () => {
        this.tool = t;
        this.render();
      });
      bar.appendChild(b);
    }
    return bar;
  }

  private renderBodyTab(left: HTMLElement): void {
    left.appendChild(this.toolbar([...CELL_KINDS.map((k) => [k, KIND_LABEL[k]] as [Tool, string]), ['erase', 'Erase']]));
    left.appendChild(this.grid('body'));
    // One strength slider per Jet; the arrow on each Jet shows the way it pushes.
    const jets = this.design.cells.map((c, i) => [c, i] as const).filter(([c]) => c.kind === 'jet');
    if (jets.length) {
      const box = el('div', { class: 'editor-settings' });
      box.appendChild(el('div', { class: 'editor-label' }, 'Jet strength'));
      for (const [c, i] of jets) {
        const label = jetBlocked(this.design.cells, i) ? `Jet ${i + 1} ⚠ blocked` : `Jet ${i + 1}`;
        const row = this.slider(label, c.strength ?? JET.defaultStrength, 0, 1, 0.05, (v) => (c.strength = v));
        if (jetBlocked(this.design.cells, i)) row.classList.add('blocked');
        box.appendChild(row);
      }
      left.appendChild(box);
    }
    // Settings per neuron: bias, speed, internal inputs, being-eaten range.
    const neurons = this.design.cells.map((c, i) => [c, i] as const).filter(([c]) => c.kind === 'neuron');
    if (neurons.length) {
      const box = el('div', { class: 'editor-settings' });
      box.appendChild(el('div', { class: 'editor-label' }, 'Neurons'));
      for (const [c, i] of neurons) {
        const section = el('details', { class: 'neuron-settings' });
        section.open = this.openNeurons.has(i);
        section.addEventListener('toggle', () => (section.open ? this.openNeurons.add(i) : this.openNeurons.delete(i)));
        section.appendChild(el('summary', {}, `Neuron ${i + 1}`));
        section.appendChild(this.slider('Bias', neuronBias(c), -1, 1, 0.05, (v) => (c.bias = v)));
        section.appendChild(this.slider('Speed', neuronSpeed(c), 0, 1, 0.05, (v) => (c.speed = v)));
        section.appendChild(el('div', { class: 'editor-hint' }, 'Internal inputs (weight each, -1 to 1):'));
        for (const key of NEURON_INPUT_KEYS) {
          section.appendChild(
            this.slider(INPUT_LABEL[key], c.inputs?.[key] ?? 0, -1, 1, 0.05, (v) => {
              c.inputs = { ...(c.inputs ?? {}), [key]: v };
            }),
          );
        }
        section.appendChild(
          this.slider('Eaten range', c.eatenRange ?? NEURON_INPUTS.eatenRangeMax, 1, NEURON_INPUTS.eatenRangeMax, 1, (v) => (c.eatenRange = v)),
        );
        section.appendChild(el('div', { class: 'editor-hint' }, `Being-eaten range in cells around the neuron; ${NEURON_INPUTS.eatenRangeMax} = the whole organism.`));
        box.appendChild(section);
      }
      left.appendChild(box);
    }
    // One type filter per Proximity sensor.
    const prox = this.design.cells.map((c, i) => [c, i] as const).filter(([c]) => c.kind === 'proximitySensor');
    if (prox.length) {
      const box = el('div', { class: 'editor-settings' });
      box.appendChild(el('div', { class: 'editor-label' }, 'Proximity sensors count'));
      for (const [c, i] of prox) {
        const row = el('label', { class: 'editor-slider' });
        const select = el('select', { 'aria-label': `Proximity sensor ${i + 1} filter` });
        select.appendChild(el('option', { value: '' }, 'Any cell'));
        for (const k of CELL_KINDS) select.appendChild(el('option', { value: k }, `${KIND_LABEL[k]} cells`));
        select.value = c.filter ?? '';
        select.addEventListener('change', () => {
          c.filter = (select.value || undefined) as CellKind | undefined;
          if (!c.filter) delete c.filter;
          this.render();
        });
        row.append(el('span', {}, `Proximity ${i + 1}`), select);
        box.appendChild(row);
      }
      left.appendChild(box);
    }
    const hint =
      this.design.growth === 'form'
        ? 'The first cell is the starter. Numbers show the growth order. Each new cell must touch one placed before it.'
        : this.design.growth === 'pattern'
          ? 'The body is the motif. Mark its start cell and end points on the Growth tab.'
          : 'The first cell is the starter. Blob grows this body first, then adds cells from the cell mix.';
    left.appendChild(el('div', { class: 'editor-hint' }, hint));
  }

  private renderGrowthTab(left: HTMLElement): void {
    const d = this.design;
    const choices = el('div', { class: 'editor-choices' });
    for (const g of ['form', 'blob', 'pattern'] as GrowthType[]) {
      choices.appendChild(this.choice('growth', g, g === d.growth, GROWTH_INFO[g], false, () => this.update((x) => (x.growth = g))));
    }
    left.appendChild(choices);

    const settings = el('div', { class: 'editor-settings' });
    settings.appendChild(this.slider('Energy per new cell', d.growEnergy, DESIGN.growEnergyMin, DESIGN.growEnergyMax, 1, (v) => (d.growEnergy = v)));
    settings.appendChild(this.slider('Nutrient per new cell', d.growNutrient, CELL.bodyNutrient, DESIGN.growNutrientMax, 1, (v) => (d.growNutrient = v)));
    if (d.growth === 'blob') {
      settings.appendChild(this.slider('Max cells', d.blob.maxCells, Math.max(1, d.cells.length), DESIGN.maxCells, 1, (v) => (d.blob.maxCells = v)));
      const mix = bodyMix(d);
      const parts = CELL_KINDS.filter((k) => mix[k] > 0).map((k) => `${Math.round((mix[k] / d.cells.length) * 100)}% ${KIND_LABEL[k]}`);
      settings.appendChild(el('div', { class: 'editor-hint' }, `Cell mix from the body: ${parts.join(', ')}. Change it on the Body tab.`));
    }
    if (d.growth === 'pattern') {
      settings.appendChild(this.slider('Max repeats', d.pattern.maxRepeats, 1, DESIGN.patternMaxRepeatsMax, 1, (v) => (d.pattern.maxRepeats = v)));
    }
    left.appendChild(settings);

    if (d.growth === 'pattern') {
      left.appendChild(el('div', { class: 'editor-label' }, 'Motif'));
      left.appendChild(this.toolbar([['start', 'Start cell'], ['end', 'End point']]));
      left.appendChild(this.grid('motif'));
      left.appendChild(el('div', { class: 'editor-hint' }, 'Click a cell to mark the start, or to toggle an end point. Edit the motif shape on the Body tab.'));
    }
  }

  private renderReproductionTab(left: HTMLElement): void {
    const d = this.design;
    const choices = el('div', { class: 'editor-choices' });
    const allowed = ALLOWED_REPRODUCTION[d.growth];
    for (const t of ['split', 'bud', 'fragment'] as ReproductionType[]) {
      const disabled = !allowed.includes(t);
      const info = disabled ? `${REPRO_INFO[t]} (Not available for Form.)` : REPRO_INFO[t];
      choices.appendChild(this.choice('reproduction', t, t === d.reproduction, info, disabled, () => this.update((x) => (x.reproduction = t))));
    }
    left.appendChild(choices);
    left.appendChild(el('div', { class: 'editor-hint' }, 'An organism reproduces once it reaches its max size and has enough stored energy and nutrient.'));
    const settings = el('div', { class: 'editor-settings' });
    settings.appendChild(this.slider('Launch offspring', d.launch ?? 0, 0, 1, 0.05, (v) => (d.launch = v)));
    settings.appendChild(el('div', { class: 'editor-hint' }, 'How hard a new bud or split-off piece is shot away from the parent. 0 = no launch.'));
    settings.appendChild(this.slider('Mutation rate', d.mutationRate ?? MUTATION.defaultRate, 0, 1, 0.05, (v) => (d.mutationRate = v)));
    settings.appendChild(
      el('div', { class: 'editor-hint' }, 'Scales every mutation chance for this design and its offspring. The middle is the normal rate; 0 means offspring are exact copies.'),
    );
    left.appendChild(settings);
  }

  private choice(group: string, value: string, checked: boolean, info: string, disabled: boolean, onPick: () => void): HTMLElement {
    const label = el('label', { class: `editor-choice${checked ? ' active' : ''}${disabled ? ' disabled' : ''}` });
    const input = el('input', { type: 'radio', name: group, value });
    input.checked = checked;
    input.disabled = disabled;
    input.addEventListener('change', onPick);
    const text = el('div');
    text.append(el('strong', {}, value[0].toUpperCase() + value.slice(1)), el('div', { class: 'editor-hint' }, info));
    label.append(input, text);
    return label;
  }

  private slider(label: string, value: number, min: number, max: number, step: number, set: (v: number) => void, unit = ''): HTMLElement {
    const row = el('label', { class: 'editor-slider' });
    const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
    const out = el('output', {}, `${value}${unit}`);
    input.addEventListener('input', () => {
      out.textContent = `${input.value}${unit}`;
      set(Number(input.value));
    });
    input.addEventListener('change', () => this.render());
    row.append(el('span', {}, label), input, out);
    return row;
  }

  // ------------------------------------------------------------- hex grid

  private grid(mode: 'body' | 'motif' | 'wire'): SVGSVGElement {
    const d = this.design;
    const R = DESIGN.gridRadius;
    const spacing = HEX_SIZE * Math.sqrt(3);
    const extent = (R + 1) * spacing;
    const root = svg('svg', { class: 'editor-grid', viewBox: `${-extent} ${-extent} ${extent * 2} ${extent * 2}` });
    const byKey = new Map(d.cells.map((c, i) => [hexKey(c.q, c.r), i]));

    for (let q = -R; q <= R; q++) {
      for (let r = Math.max(-R, -q - R); r <= Math.min(R, -q + R); r++) {
        const [cx, cy] = hexPx(q, r, spacing);
        const idx = byKey.get(hexKey(q, r));
        const placeable = idx === undefined && (d.cells.length === 0 || d.cells.some((c) => areNeighbors(c.q, c.r, q, r)));
        const g = svg('g', { class: `hex${placeable && mode === 'body' ? ' placeable' : ''}` });
        g.appendChild(svg('polygon', { points: hexPoints(cx, cy, HEX_SIZE - 1) }));
        if (idx !== undefined) {
          const c = d.cells[idx];
          g.appendChild(svg('circle', { cx, cy, r: HEX_SIZE * 0.72, class: 'cell', style: cellStyle(c.kind) }));
          if (c.kind === 'jet') {
            const blocked = jetBlocked(d.cells, idx);
            g.appendChild(this.jetArrow(cx, cy, attachDirection(d.cells, idx), spacing, blocked));
            if (blocked) {
              g.appendChild(svg('circle', { cx, cy, r: HEX_SIZE * 0.92, class: 'jet-blocked' }));
              const t = svg('title');
              t.textContent = "Blocked: a cell sits in this Jet's exhaust, so it won't push.";
              g.appendChild(t);
            }
          }
          if (isSensor(c.kind)) {
            // Sensors face outward from the cell they're attached to.
            const attach = attachDirection(d.cells, idx);
            if (attach >= 0) g.appendChild(this.facingArrow(cx, cy, (attach + 3) % 6, spacing));
          }
          if (mode === 'body' && d.growth === 'form') {
            const t = svg('text', { x: cx, y: cy + 4, class: 'order' });
            t.textContent = String(idx + 1);
            g.appendChild(t);
          }
          if (mode === 'body' && idx === 0 && d.growth !== 'pattern') {
            g.appendChild(svg('circle', { cx, cy, r: HEX_SIZE * 0.88, class: 'starter-ring' }));
          }
          if (mode === 'motif') {
            const mark = idx === d.pattern.start ? 'S' : d.pattern.ends.includes(idx) ? 'E' : '';
            if (mark) {
              const t = svg('text', { x: cx, y: cy + 4, class: `order mark-${mark}` });
              t.textContent = mark;
              g.appendChild(t);
            }
          }
        }
        if (mode === 'wire' && idx !== undefined && idx === this.pendingSensor) {
          g.appendChild(svg('circle', { cx, cy, r: HEX_SIZE * 0.92, class: 'wire-pending' }));
        }
        g.addEventListener('click', () =>
          mode === 'body' ? this.clickBody(q, r) : mode === 'motif' ? this.clickMotif(q, r) : this.clickWire(q, r),
        );
        root.appendChild(g);
      }
    }
    if (mode === 'wire') {
      // Connections: lines from source to target, colored by sign, thicker for
      // stronger weights; dashed for a sensor's change output. A neuron wired to
      // itself shows a loop; Pattern connections into the previous/next repeat are labeled.
      for (const w of d.wiring ?? []) {
        const a = d.cells[w.source];
        const b = d.cells[w.target];
        if (!a || !b) continue;
        const [x1, y1] = hexPx(a.q, a.r, spacing);
        const [x2, y2] = hexPx(b.q, b.r, spacing);
        const cls = `wire ${w.weight >= 0 ? 'positive' : 'negative'}${w.output === 'change' && isSensor(a.kind) ? ' change' : ''}`;
        const width = 2 + Math.abs(w.weight) * 4;
        if (w.source === w.target) {
          root.appendChild(svg('circle', { cx: x1 + HEX_SIZE * 0.55, cy: y1 - HEX_SIZE * 0.55, r: HEX_SIZE * 0.45, class: cls, fill: 'none', 'stroke-width': width }));
        } else {
          root.appendChild(svg('line', { x1, y1, x2, y2, class: cls, 'stroke-width': width }));
        }
        if (d.growth === 'pattern' && w.repeat && w.repeat !== 'same') {
          const t = svg('text', { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 4, class: 'wire-repeat' });
          t.textContent = w.repeat === 'previous' ? 'prev' : 'next';
          root.appendChild(t);
        }
      }
    }
    return root;
  }

  /** Arrow from a sensor's center the way it faces. */
  private facingArrow(cx: number, cy: number, dir: number, spacing: number): SVGGElement {
    const g = svg('g', { class: 'sensor-arrow' });
    const [dx, dy] = hexPx(...HEX_DIRS[dir], spacing);
    const len = Math.hypot(dx, dy);
    const ux = dx / len;
    const uy = dy / len;
    const tip = [cx + ux * HEX_SIZE * 1.05, cy + uy * HEX_SIZE * 1.05];
    const tail = [cx + ux * HEX_SIZE * 0.35, cy + uy * HEX_SIZE * 0.35];
    const head = (side: number) => [tip[0] - ux * 6 - uy * 4 * side, tip[1] - uy * 6 + ux * 4 * side];
    g.appendChild(svg('line', { x1: tail[0], y1: tail[1], x2: tip[0], y2: tip[1] }));
    g.appendChild(svg('polyline', { points: `${head(1).join(',')} ${tip.join(',')} ${head(-1).join(',')}` }));
    return g;
  }

  // ------------------------------------------------------------- behavior

  private renderBehaviorTab(left: HTMLElement): void {
    const d = this.design;
    if (d.growth !== 'form' && d.growth !== 'pattern') {
      left.appendChild(el('div', { class: 'editor-hint' }, 'Behavior wiring applies to Form and Pattern designs. Choose one on the Growth tab.'));
      return;
    }
    left.appendChild(
      el(
        'div',
        { class: 'editor-hint' },
        this.pendingSensor === null
          ? 'Click a sensor or neuron, then a Jet or neuron, to connect them. Click a neuron twice to wire it to itself. ' +
              (d.growth === 'pattern' ? 'Wiring drawn in the motif is copied into every repeat.' : '')
          : 'Now click a Jet or neuron to connect to (click empty space to cancel).',
      ),
    );
    left.appendChild(this.grid('wire'));

    // Steering shortcuts per sensor.
    const sensors = d.cells.map((c, i) => [c, i] as const).filter(([c]) => isSensor(c.kind));
    if (sensors.length) {
      const box = el('div', { class: 'editor-settings' });
      box.appendChild(el('div', { class: 'editor-label' }, 'Steer'));
      for (const [c, i] of sensors) {
        const row = el('div', { class: 'wire-toggle steer-row' });
        row.appendChild(el('span', { class: 'wire-name' }, `${KIND_LABEL[c.kind]} ${i + 1}`));
        for (const [label, toward] of [
          ['Steer toward', true],
          ['Steer away', false],
        ] as const) {
          const b = el('button', {}, label);
          b.title = `Wire this sensor to the Jets so the organism turns ${toward ? 'toward' : 'away from'} its side`;
          b.addEventListener('click', () => this.steer(i, toward));
          row.appendChild(b);
        }
        box.appendChild(row);
      }
      left.appendChild(box);
    }

    const wiring = d.wiring ?? [];
    if (!wiring.length) return;
    const list = el('div', { class: 'editor-settings' });
    list.appendChild(el('div', { class: 'editor-label' }, 'Connections'));
    wiring.forEach((w, k) => {
      const row = el('div', { class: 'wire-row' });
      const name = (i: number) => `${KIND_LABEL[d.cells[i].kind]} ${i + 1}`;
      row.appendChild(el('span', { class: 'wire-name' }, `${name(w.source)} → ${name(w.target)}`));
      row.appendChild(this.slider('Weight', w.weight, -1, 1, 0.05, (v) => (w.weight = v)));
      const toggle = el('div', { class: 'wire-toggle' });
      const choose = <T extends string>(options: readonly T[], current: T, set: (v: T) => void) => {
        for (const opt of options) {
          const b = el('button', { class: current === opt ? 'active' : '' }, opt[0].toUpperCase() + opt.slice(1));
          b.addEventListener('click', () => {
            set(opt);
            this.render();
          });
          toggle.appendChild(b);
        }
      };
      // Sensors have two outputs; neurons have one.
      if (isSensor(d.cells[w.source].kind)) choose(['level', 'change'] as const, w.output, (v) => (w.output = v));
      if (d.growth === 'pattern') {
        toggle.appendChild(el('span', { class: 'wire-sep' }, 'target in'));
        choose(['same', 'previous', 'next'] as const, w.repeat ?? 'same', (v) => (w.repeat = v));
      }
      const remove = el('button', { 'aria-label': 'Remove connection' }, '×');
      remove.addEventListener('click', () => {
        wiring.splice(k, 1);
        this.render();
      });
      toggle.appendChild(remove);
      row.appendChild(toggle);
      list.appendChild(row);
    });
    left.appendChild(list);
  }

  private clickWire(q: number, r: number): void {
    const d = this.design;
    const idx = d.cells.findIndex((c) => c.q === q && c.r === r);
    const kind = idx >= 0 ? d.cells[idx].kind : null;
    const pending = this.pendingSensor;
    if (pending !== null && kind && isTarget(kind)) {
      // Connect (a neuron clicked twice gets a self-connection).
      d.wiring = d.wiring ?? [];
      if (!d.wiring.some((w) => w.source === pending && w.target === idx)) d.wiring.push({ source: pending, target: idx, weight: 0.5, output: 'level' });
      this.pendingSensor = null;
    } else if (kind && isSource(kind)) {
      this.pendingSensor = idx;
    } else if (kind === 'jet') {
      return this.flash('Click a sensor or neuron first, then the Jet.');
    } else {
      this.pendingSensor = null;
    }
    this.render();
  }

  /**
   * Steer toward / away: wires a sensor's level to the Jets so the organism
   * turns toward (or away from) the side the sensor is on. The heading is the
   * Jets' net push; a Jet whose push turns the body that way gets +weight, one
   * that turns it the other way gets -weight. Replaces this sensor's existing
   * Jet connections; the result is ordinary wiring.
   */
  private steer(sensor: number, toward: boolean): void {
    const d = this.design;
    const pos = (i: number) => hexToLocal(d.cells[i].q, d.cells[i].r);
    const jets = d.cells.map((c, i) => [c, i] as const).filter(([c, i]) => c.kind === 'jet' && !jetBlocked(d.cells, i) && attachDirection(d.cells, i) >= 0);
    if (!jets.length) return this.flash('Add Jets that can push (not blocked) first.');
    let cx = 0;
    let cy = 0;
    d.cells.forEach((_, i) => {
      const [x, y] = pos(i);
      cx += x / d.cells.length;
      cy += y / d.cells.length;
    });
    const pushOf = (i: number) => hexToLocal(...HEX_DIRS[attachDirection(d.cells, i)]);
    let hx = 0;
    let hy = 0;
    for (const [, i] of jets) {
      const [ux, uy] = pushOf(i);
      hx += ux;
      hy += uy;
    }
    if (Math.hypot(hx, hy) < 1e-6) [hx, hy] = [1, 0];
    const [sx, sy] = pos(sensor);
    let side = hx * (sy - cy) - hy * (sx - cx);
    if (Math.abs(side) < 1e-6) {
      // Sensor on the body's axis: use the way it faces instead.
      const attach = attachDirection(d.cells, sensor);
      if (attach >= 0) {
        const [fx, fy] = hexToLocal(...HEX_DIRS[(attach + 3) % 6]);
        side = hx * fy - hy * fx;
      }
    }
    if (Math.abs(side) < 1e-6) return this.flash('This sensor is straight ahead or behind, so there is no side to steer toward.');
    const turn = Math.sign(side) * (toward ? 1 : -1);
    d.wiring = (d.wiring ?? []).filter((w) => !(w.source === sensor && d.cells[w.target].kind === 'jet'));
    let added = 0;
    for (const [, i] of jets) {
      const [px, py] = pos(i);
      const [ux, uy] = pushOf(i);
      const torque = (px - cx) * uy - (py - cy) * ux;
      if (Math.abs(torque) < 1e-6) continue;
      const wire: Wire = { source: sensor, target: i, weight: DESIGN.steerWeight * Math.sign(torque) * turn, output: 'level' };
      d.wiring.push(wire);
      added++;
    }
    this.message = added ? `Wired ${added} Jet connection${added === 1 ? '' : 's'} to steer ${toward ? 'toward' : 'away from'} this sensor's side.` : 'No Jet can turn the body.';
    this.render();
  }

  /** Arrow from a Jet toward the cell it's attached to: the way it pushes. */
  private jetArrow(cx: number, cy: number, dir: number, spacing: number, blocked: boolean): SVGGElement {
    const g = svg('g', { class: blocked ? 'jet-arrow blocked' : 'jet-arrow' });
    if (dir < 0) return g;
    const [dx, dy] = hexPx(...HEX_DIRS[dir], spacing);
    const len = Math.hypot(dx, dy);
    const ux = dx / len;
    const uy = dy / len;
    const tip = [cx + ux * HEX_SIZE * 0.95, cy + uy * HEX_SIZE * 0.95];
    const tail = [cx - ux * HEX_SIZE * 0.45, cy - uy * HEX_SIZE * 0.45];
    const head = (side: number) => [tip[0] - ux * 7 - uy * 5 * side, tip[1] - uy * 7 + ux * 5 * side];
    g.appendChild(svg('line', { x1: tail[0], y1: tail[1], x2: tip[0], y2: tip[1] }));
    g.appendChild(svg('polyline', { points: `${head(1).join(',')} ${tip.join(',')} ${head(-1).join(',')}` }));
    return g;
  }

  private clickBody(q: number, r: number): void {
    const d = this.design;
    const idx = d.cells.findIndex((c) => c.q === q && c.r === r);
    if (this.tool === 'erase') {
      if (idx < 0) return;
      const trial = structuredClone(d);
      trial.cells.splice(idx, 1);
      // Keep motif marks pointing at the same cells.
      const shift = (i: number) => (i > idx ? i - 1 : i);
      trial.pattern.ends = trial.pattern.ends.filter((e) => e !== idx).map(shift);
      trial.pattern.start = trial.pattern.start === idx ? 0 : shift(trial.pattern.start);
      trial.wiring = (trial.wiring ?? [])
        .filter((w) => w.source !== idx && w.target !== idx)
        .map((w) => ({ ...w, source: shift(w.source), target: shift(w.target) }));
      if (trial.cells.length && trial.cells.some((c, i) => i > 0 && !trial.cells.slice(0, i).some((p) => areNeighbors(p.q, p.r, c.q, c.r)))) {
        this.message = '';
        this.flash('Removing that cell would leave a later cell unconnected.');
        return;
      }
      this.design = trial;
      this.message = '';
      this.render();
      return;
    }
    const kind = this.tool as CellKind;
    if (idx >= 0) {
      d.cells[idx].kind = kind;
      d.cells[idx].strength = kind === 'jet' ? (d.cells[idx].strength ?? JET.defaultStrength) : undefined;
      if (kind !== 'proximitySensor') delete d.cells[idx].filter;
      // Drop connections that no longer run from a source to a target.
      d.wiring = (d.wiring ?? []).filter((w) => isSource(d.cells[w.source].kind) && isTarget(d.cells[w.target].kind));
      if (kind !== 'neuron') for (const key of ['bias', 'speed', 'inputs', 'eatenRange'] as const) delete d.cells[idx][key];
    } else {
      if (d.cells.length >= DESIGN.maxCells) return this.flash(`A body can have at most ${DESIGN.maxCells} cells.`);
      if (d.cells.length && !d.cells.some((c) => areNeighbors(c.q, c.r, q, r))) return this.flash('New cells must touch the body.');
      d.cells.push(kind === 'jet' ? { q, r, kind, strength: JET.defaultStrength } : { q, r, kind });
      if (d.growth === 'blob') d.blob.maxCells = Math.max(d.blob.maxCells, d.cells.length);
    }
    this.message = '';
    this.render();
  }

  private clickMotif(q: number, r: number): void {
    const p = this.design.pattern;
    const idx = this.design.cells.findIndex((c) => c.q === q && c.r === r);
    if (idx < 0) return;
    if (this.tool === 'start') {
      p.start = idx;
      p.ends = p.ends.filter((e) => e !== idx);
    } else if (idx !== p.start) {
      p.ends = p.ends.includes(idx) ? p.ends.filter((e) => e !== idx) : [...p.ends, idx];
    }
    this.render();
  }

  private flash(text: string): void {
    const status = this.root.querySelector('.editor-status');
    if (status) {
      status.textContent = text;
      status.className = 'editor-status error';
    }
  }

  // ------------------------------------------------------------- preview and stats

  /** Animates the design growing from its starter cell, then loops. */
  private animatePreview(root: SVGSVGElement): void {
    clearInterval(this.previewTimer);
    if (validateDesign(this.design)) return;
    const g = compileGenome(this.design);
    const cells = this.previewCells(g.plan, g.maxCells);
    const spacing = 2 * CELL.radius * 1.5;
    const [minX, maxX, minY, maxY] = cells.reduce(
      ([a, b, c, dd], s) => {
        const [x, y] = hexPx(s.q, s.r, spacing);
        return [Math.min(a, x), Math.max(b, x), Math.min(c, y), Math.max(dd, y)];
      },
      [Infinity, -Infinity, Infinity, -Infinity],
    );
    const pad = spacing;
    const w = Math.max(maxX - minX + 2 * pad, 60);
    const h = Math.max(maxY - minY + 2 * pad, 60);
    const size = Math.max(w, h);
    root.setAttribute('viewBox', `${(minX + maxX) / 2 - size / 2} ${(minY + maxY) / 2 - size / 2} ${size} ${size}`);
    // Bonds sit under the cells.
    const bondLayer = svg('g');
    const cellLayer = svg('g');
    root.append(bondLayer, cellLayer);
    let shown = 0;
    const holdFrames = 6;
    this.previewTimer = window.setInterval(() => {
      if (shown > cells.length + holdFrames) {
        shown = 0;
        bondLayer.replaceChildren();
        cellLayer.replaceChildren();
      }
      if (shown < cells.length) {
        const c = cells[shown];
        const [x, y] = hexPx(c.q, c.r, spacing);
        // Bonds to already-shown neighbors, then the cell.
        for (let k = 0; k < shown; k++) {
          const o = cells[k];
          if (!areNeighbors(o.q, o.r, c.q, c.r)) continue;
          const [ox, oy] = hexPx(o.q, o.r, spacing);
          bondLayer.appendChild(svg('line', { x1: ox, y1: oy, x2: x, y2: y, class: 'bond' }));
        }
        cellLayer.appendChild(svg('circle', { cx: x, cy: y, r: CELL.radius * 1.35, class: 'cell pop', style: cellStyle(c.kind) }));
      }
      shown++;
    }, 220);
  }

  /** The plan, plus (for Blob) a sample of random edge growth from the cell mix. */
  private previewCells(plan: { q: number; r: number; kind: CellKind }[], maxCells: number) {
    const out = plan.map((c) => ({ ...c }));
    if (this.design.growth !== 'blob') return out;
    const rng = createRng(1234);
    const taken = new Set(out.map((c) => hexKey(c.q, c.r)));
    const mix = bodyMix(this.design);
    const pick = (): CellKind => {
      let roll = rng() * CELL_KINDS.reduce((sum, k) => sum + mix[k], 0);
      for (const k of CELL_KINDS) if ((roll -= mix[k]) < 0) return k;
      return this.design.cells[0].kind;
    };
    for (let tries = 0; out.length < maxCells && tries < 2000; tries++) {
      const from = out[Math.floor(rng() * out.length)];
      const [dq, dr] = HEX_DIRS[Math.floor(rng() * 6)];
      const q = from.q + dq;
      const r = from.r + dr;
      if (taken.has(hexKey(q, r))) continue;
      taken.add(hexKey(q, r));
      out.push({ q, r, kind: pick() });
    }
    return out;
  }

  private renderStats(): HTMLElement {
    const box = el('div', { class: 'editor-stats' });
    if (validateDesign(this.design)) return box;
    const s = designStats(this.design);
    // Decomposers pay a reduced upkeep.
    const upkeepCells = s.cells - s.kinds.decomposer * (1 - METABOLISM.decomposerUpkeep);
    const perTick = (m: number) => ((upkeepCells * METABOLISM.upkeep * m) / SIM.tickHz).toFixed(2);
    const rows: [string, string][] = [
      [
        'Cells',
        `${s.cells} (${CELL_KINDS.filter((k) => s.kinds[k] > 0)
          .map((k) => `${s.kinds[k]} ${KIND_LABEL[k]}`)
          .join(', ')})`,
      ],
      ['Upkeep per tick', `${perTick(METABOLISM.coldMultiplier)}–${perTick(METABOLISM.warmMultiplier)} energy (cold–warm)`],
      ['Nutrient to grow', `${s.growNutrient}`],
      ['Nutrient to reproduce', `${s.reproduceNutrient}`],
      ['Release cost', `${releaseCost(this.design)} DNA`],
    ];
    for (const [k, v] of rows) {
      const row = el('div', { class: 'editor-stat' });
      row.append(el('span', {}, k), el('span', {}, v));
      box.appendChild(row);
    }
    return box;
  }

  // ------------------------------------------------------------- save / load

  private save(): void {
    const name = this.design.name.trim();
    if (!name) return this.flash('Name the design before saving.');
    this.design.name = name;
    const copy = structuredClone(this.design);
    const i = this.saved.findIndex((d) => d.name === name);
    if (i >= 0) this.saved[i] = copy;
    else this.saved.push(copy);
    const ok = storeDesigns(this.saved);
    this.message = ok ? `Saved "${name}".` : `Saved "${name}" for this session (browser storage is unavailable).`;
    this.onDesignsChanged(this.saved);
    this.render();
  }

  private remove(): void {
    const name = this.design.name.trim();
    const i = this.saved.findIndex((d) => d.name === name);
    if (i < 0) return this.flash(`No saved design is named "${name}".`);
    this.saved.splice(i, 1);
    storeDesigns(this.saved);
    this.message = `Deleted "${name}".`;
    this.onDesignsChanged(this.saved);
    this.render();
  }
}
