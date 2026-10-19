import { BufferImageSource, Geometry, Mesh, Shader } from 'pixi.js';
import { DEPTH, LIGHT, NUTRIENT, OVERLAY, TEMPERATURE, WATER, WORLD } from '../config';

export const OVERLAYS = ['none', 'currents', 'nutrient', 'temperature', 'depth', 'light'] as const;
export type Overlay = (typeof OVERLAYS)[number];

// GLSL ES 3.0 explicitly: the overlays need fwidth().
const vertex = /* glsl */ `#version 300 es
in vec2 aPosition;
out vec2 vWorld;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vWorld = aPosition;
}`;

const fragment = /* glsl */ `#version 300 es
precision highp float;
in vec2 vWorld;
out vec4 finalColor;
// Per tile: r = depth high byte, a = depth low byte (0 shallow..1 deep),
// g = temperature (0 edge..1 center), b = water nutrient
uniform sampler2D uField;
uniform vec2 uFieldSize;
uniform float uTileSize;
uniform float uDaylight;
uniform float uDepthMin;
uniform float uDepthMax;
uniform float uLightK;
uniform float uTempCenter;
uniform float uTempEdge;
uniform float uOverlay;
uniform float uShallowPower;
uniform float uNightFloor;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform float uDimArt;
uniform vec3 uNutrientColor;
uniform float uNutrientStrength;
uniform float uNutrientDepletedDim;
uniform vec3 uCoolColor;
uniform vec3 uWarmColor;
uniform float uTemperatureAlpha;
uniform float uIsothermStep;
uniform float uIsothermAlpha;
uniform float uContourMinor;
uniform float uContourMajor;
uniform vec3 uContourColor;
uniform float uContourMinorAlpha;
uniform float uContourMajorAlpha;
uniform vec3 uLightColor;
uniform float uLightStrength;


// The world is a grid: every tile is drawn as one flat value, exactly what the
// sim uses. No interpolation between tiles.
vec4 tileAt(ivec2 t) {
  return texelFetch(uField, clamp(t, ivec2(0), ivec2(uFieldSize) - 1), 0);
}

float depthOf(vec4 f) {
  return mix(uDepthMin, uDepthMax, clamp(f.r + f.a / 255.0, 0.0, 1.0));
}

float tempOf(vec4 f) {
  return mix(uTempEdge, uTempCenter, f.g);
}

float valueOf(vec4 f, int which) {
  return which == 0 ? depthOf(f) : tempOf(f);
}

// ~1px lines along tile edges where the value crosses a multiple of step
// between this tile and its neighbor (stair-step contours that follow the grid).
float tileContours(ivec2 t, vec2 inTile, vec2 px, int which, float step) {
  float band = floor(valueOf(tileAt(t), which) / step);
  float line = 0.0;
  if (floor(valueOf(tileAt(t + ivec2(-1, 0)), which) / step) != band) line = max(line, 1.0 - smoothstep(0.0, px.x, inTile.x));
  if (floor(valueOf(tileAt(t + ivec2(1, 0)), which) / step) != band) line = max(line, 1.0 - smoothstep(0.0, px.x, 1.0 - inTile.x));
  if (floor(valueOf(tileAt(t + ivec2(0, -1)), which) / step) != band) line = max(line, 1.0 - smoothstep(0.0, px.y, inTile.y));
  if (floor(valueOf(tileAt(t + ivec2(0, 1)), which) / step) != band) line = max(line, 1.0 - smoothstep(0.0, px.y, 1.0 - inTile.y));
  return line;
}

void main() {
  vec2 tilePos = vWorld / uTileSize;
  ivec2 t = ivec2(floor(tilePos));
  vec2 inTile = tilePos - vec2(t);
  vec2 px = fwidth(tilePos);
  vec4 f = tileAt(t);
  float depthN = clamp(f.r + f.a / 255.0, 0.0, 1.0);
  float depth = depthOf(f);
  float light = uDaylight * exp(-uLightK * depth);
  float temp = tempOf(f);
  float tempN = f.g;

  // Base art: flat per-tile color from depth, dimmed at night. Static.
  vec3 col = mix(uDeep, uShallow, pow(1.0 - depthN, uShallowPower)) * mix(uNightFloor, 1.0, uDaylight);

  if (uOverlay > 4.5) {
    // Light: soft pale glow.
    col = col * mix(uDimArt, 1.0, light) + uLightColor * light * uLightStrength;
  } else if (uOverlay > 3.5) {
    // Depth: nautical chart contours.
    col *= uDimArt;
    float minor = tileContours(t, inTile, px, 0, uContourMinor);
    float major = tileContours(t, inTile, px, 0, uContourMajor);
    col = mix(col, uContourColor, max(minor * uContourMinorAlpha, major * uContourMajorAlpha));
  } else if (uOverlay > 2.5) {
    // Temperature: translucent cool-to-warm wash with isotherms.
    col = mix(col, mix(uCoolColor, uWarmColor, tempN), uTemperatureAlpha);
    col = mix(col, vec3(1.0), tileContours(t, inTile, px, 1, uIsothermStep) * uIsothermAlpha);
  } else if (uOverlay > 1.5) {
    // Nutrient: amber haze; f.b = 0.5 is the even starting share.
    float n = clamp(f.b, 0.0, 1.0);
    col *= mix(uNutrientDepletedDim, 1.0, smoothstep(0.0, 0.5, n));
    col += uNutrientColor * n * n * uNutrientStrength;
  } else if (uOverlay > 0.5) {
    // Currents: art is dimmed; streaks are drawn on top.
    col *= uDimArt;
  }
  finalColor = vec4(col, 1.0);
}`;

const rgb = (hex: number) => new Float32Array([((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255]);
const f32 = (value: number) => ({ value, type: 'f32' as const });
const vec3 = (hex: number) => ({ value: rgb(hex), type: 'vec3<f32>' as const });

/** Full-world water quad, drawn tile by tile from one RGBA texture of per-tile fields. */
export class Water {
  readonly mesh: Mesh<Geometry, Shader>;
  private field = new Uint8Array(WORLD.width * WORLD.height * 4);
  private fieldTex = new BufferImageSource({
    resource: this.field,
    width: WORLD.width,
    height: WORLD.height,
    scaleMode: 'nearest',
    // Alpha carries data (depth low byte), so it must not premultiply the color channels.
    alphaMode: 'no-premultiply-alpha',
  });
  private uniforms: Record<string, unknown>;

  constructor() {
    const w = WORLD.width * WORLD.tileSize;
    const h = WORLD.height * WORLD.tileSize;
    const geometry = new Geometry({
      attributes: {
        aPosition: [0, 0, w, 0, w, h, 0, h],
      },
      indexBuffer: [0, 1, 2, 0, 2, 3],
    });
    const shader = Shader.from({
      gl: { vertex, fragment },
      resources: {
        uField: this.fieldTex,
        waterUniforms: {
          uFieldSize: { value: new Float32Array([WORLD.width, WORLD.height]), type: 'vec2<f32>' },
          uTileSize: f32(WORLD.tileSize),
          uDaylight: f32(1),
          uDepthMin: f32(DEPTH.min),
          uDepthMax: f32(DEPTH.max),
          uLightK: f32(LIGHT.attenuation),
          uTempCenter: f32(TEMPERATURE.center),
          uTempEdge: f32(TEMPERATURE.edge - TEMPERATURE.depthCooling),
          uOverlay: f32(0),
          uShallowPower: f32(WATER.shallowPower),
          uNightFloor: f32(WATER.nightFloor),
          uDeep: vec3(WATER.deepColor),
          uShallow: vec3(WATER.shallowColor),
          uDimArt: f32(OVERLAY.dimArt),
          uNutrientColor: vec3(OVERLAY.nutrientColor),
          uNutrientStrength: f32(OVERLAY.nutrientStrength),
          uNutrientDepletedDim: f32(OVERLAY.nutrientDepletedDim),
          uCoolColor: vec3(OVERLAY.coolColor),
          uWarmColor: vec3(OVERLAY.warmColor),
          uTemperatureAlpha: f32(OVERLAY.temperatureAlpha),
          uIsothermStep: f32(OVERLAY.isothermStep),
          uIsothermAlpha: f32(OVERLAY.isothermAlpha),
          uContourMinor: f32(OVERLAY.contourMinor),
          uContourMajor: f32(OVERLAY.contourMajor),
          uContourColor: vec3(OVERLAY.contourColor),
          uContourMinorAlpha: f32(OVERLAY.contourMinorAlpha),
          uContourMajorAlpha: f32(OVERLAY.contourMajorAlpha),
          uLightColor: vec3(OVERLAY.lightColor),
          uLightStrength: f32(OVERLAY.lightStrength),
        },
      },
    });
    this.uniforms = shader.resources.waterUniforms.uniforms;
    this.mesh = new Mesh({ geometry, shader });
  }

  setWorld(depth: Float32Array, temperature: Float32Array): void {
    // The coldest water is the deep edge: TEMPERATURE.edge minus the depth cooling.
    const coldest = TEMPERATURE.edge - TEMPERATURE.depthCooling;
    const tempRange = TEMPERATURE.center - coldest;
    for (let i = 0; i < depth.length; i++) {
      this.field[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, (temperature[i] - coldest) / tempRange)) * 255);
      // Depth is split across two bytes (r = high, a = low) for 16-bit precision.
      const d = Math.min(1, Math.max(0, (depth[i] - DEPTH.min) / (DEPTH.max - DEPTH.min))) * 255;
      const hi = Math.floor(d);
      this.field[i * 4] = hi;
      this.field[i * 4 + 3] = Math.round((d - hi) * 255);
    }
    this.fieldTex.update();
  }

  /** Nutrient scale: 0.5 is the even starting share of a tile, 1 is twice that. */
  setNutrient(water: Uint32Array): void {
    const full = (2 * NUTRIENT.total) / water.length;
    for (let i = 0; i < water.length; i++) {
      this.field[i * 4 + 2] = Math.min(255, (water[i] / full) * 255);
    }
    this.fieldTex.update();
  }

  update(daylight: number, overlay: Overlay): void {
    this.uniforms.uDaylight = daylight;
    this.uniforms.uOverlay = OVERLAYS.indexOf(overlay);
  }
}
