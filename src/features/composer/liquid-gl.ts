import { INK, SHADOW, frameBounds, lerp, type LiquidFrame } from './liquid-shape';

/**
 * Draws liquid frames (liquid-shape.ts) onto a canvas: in the worker (liquid.worker.ts) or, where
 * there is none, on the page (liquid.ts).
 *
 * WebGL: the ink is a signed distance field evaluated per pixel. The bead, the drop and the sheet
 * are an ellipse and a rounded box; while the bead is joined to the bar they are united with the
 * bar's edge by a smooth minimum, so the meniscus, the neck that thins and parts and what sinks
 * back into the edge are one continuous liquid surface, crisp at any size. On it: the card's ink
 * (with a static grain like the page's), its inner hairline (lit from above while it is a drop) and
 * one soft shadow. Only the region a frame covers is shaded (a scissored quad), and nothing is
 * drawn when nothing is in the air.
 *
 * Canvas 2D (no WebGL): the same shapes as paths, without the meniscus.
 */

export interface LiquidRenderer {
  /** Clears the canvas and draws `frames`; `origin` is where the canvas's top-left stands (page px). */
  draw(frames: LiquidFrame[], origin: { x: number; y: number }): void;
  /** Clears the canvas. */
  clear(): void;
  /** False once the GPU context is gone (the caller falls back). */
  ok(): boolean;
  /** Lets go of the GPU context (a canvas no longer used). */
  dispose(): void;
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uOrigin;
uniform float uScale;
uniform float uH;
uniform vec4 uDrop;
uniform vec3 uDropS;
uniform vec4 uSheet;
uniform vec4 uRadii;
uniform vec3 uEdge;
uniform vec4 uInk;
uniform vec4 uLook;
out vec4 outColor;

float sdBox(vec2 p, vec2 c, vec2 b, vec4 r) {
  vec2 q = p - c;
  float rr = q.x > 0.0 ? (q.y > 0.0 ? r.z : r.y) : (q.y > 0.0 ? r.w : r.x);
  rr = min(rr, min(b.x, b.y));
  vec2 d = abs(q) - b + rr;
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - rr;
}

float sdDrop(vec2 p) {
  vec2 q = p - uDrop.xy;
  float cs = cos(uDropS.z);
  float sn = sin(uDropS.z);
  vec2 l = vec2(cs * q.x + sn * q.y, -sn * q.x + cs * q.y);
  vec2 ab = uDrop.z * uDropS.xy;
  float k0 = length(l / ab);
  float k1 = length(l / (ab * ab));
  return k0 * (k0 - 1.0) / max(k1, 1e-5);
}

float smin(float a, float b, float k) {
  if (k <= 0.0) return min(a, b);
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

float scene(vec2 p) {
  float d = 1e5;
  if (uDrop.w > 0.5) d = sdDrop(p);
  if (uSheet.z > uSheet.x) {
    vec2 c = (uSheet.xy + uSheet.zw) * 0.5;
    vec2 b = (uSheet.zw - uSheet.xy) * 0.5;
    d = min(d, sdBox(p, c, b, uRadii));
  }
  if (uEdge.z > 0.5) d = smin(d, uEdge.x - p.y, uEdge.y);
  return d;
}

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 p = uOrigin + vec2(gl_FragCoord.x, uH - gl_FragCoord.y) / uScale;
  float d = scene(p);
  vec2 g = vec2(dFdx(d), -dFdy(d));
  vec2 n = g / max(length(g), 1e-5);
  // Coverage of the ink and of its 1 px inner hairline, smoothed over one device pixel.
  float cov = clamp(0.5 - d * uScale, 0.0, 1.0);
  float inner = clamp(0.5 - (d + 1.0) * uScale, 0.0, 1.0);
  // Joined to the bar: what is drawn is what the union adds to the bar's edge (the bar itself is
  // the page's), so nothing lines its edge away from the bead; under the meniscus the ink runs on
  // over the bar's own hairline, so the bead rises out of the bar, not onto it.
  float de = uEdge.z > 0.5 ? uEdge.x - p.y : 1e5;
  float ce = clamp(0.5 - de * uScale, 0.0, 1.0);
  float ie = clamp(0.5 - (de + 1.0) * uScale, 0.0, 1.0);
  float foot = 0.0;
  if (uEdge.z > 0.5) {
    float band = clamp((uEdge.x + 1.5 - p.y) * uScale + 0.5, 0.0, 1.0) * ce;
    foot = clamp(0.5 - scene(vec2(p.x, uEdge.x - 0.75)) * uScale, 0.0, 1.0) * band;
  }
  float rim = max((cov - inner) - (ce - ie), 0.0);
  // Lit from above: the top of a drop catches the light, and a little of it comes through to its
  // underside, as through a bead of glass.
  float up = clamp(0.5 - 0.5 * n.y, 0.0, 1.0);
  float down = 1.0 - up;
  float light = uLook.x;
  float rimA = mix(uLook.y, uLook.y + (uLook.z - uLook.y) * (up * up + 0.3 * down * down), light);
  float grain = max(0.0, 0.05 * hash(floor(p)) - 0.036);
  vec3 ink = uInk.rgb + vec3(grain);
  float body = max(max(cov - ce, 0.0), foot);
  float edgeMix = rimA * rim / max(body, 1e-4);
  vec3 col = mix(ink, vec3(0.949, 0.945, 0.933), clamp(edgeMix, 0.0, 1.0));
  float shapeA = body * mix(uInk.a, 1.0, clamp(edgeMix, 0.0, 1.0));
  // One soft shadow, below: the ink's own (not the bar's), and none on the bar.
  vec2 q = p - vec2(0.0, ${SHADOW.y.toFixed(1)});
  float ds = (uEdge.z > 0.5 ? (uDrop.w > 0.5 ? sdDrop(q) : 1e5) : scene(q)) + ${(SHADOW.blur * 0.25).toFixed(1)};
  float sh = (1.0 - smoothstep(-${(SHADOW.blur * 0.5).toFixed(1)}, ${(SHADOW.blur * 0.5).toFixed(1)}, ds)) * ${SHADOW.a.toFixed(2)} * (1.0 - ce);
  float outA = shapeA + sh * (1.0 - shapeA);
  outColor = vec4(col * shapeA, outA) * uLook.w;
}`;

/** A WebGL renderer, or null where WebGL2 is missing. */
function glRenderer(canvas: AnyCanvas, scale: number): LiquidRenderer | null {
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'low-power' }) as WebGL2RenderingContext | null;
  } catch {
    gl = null;
  }
  if (!gl) return null;
  const compile = (type: number, src: string) => {
    const s = gl!.createShader(type);
    if (!s) return null;
    gl!.shaderSource(s, src);
    gl!.compileShader(s);
    if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS)) return null;
    return s;
  };
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u = (name: string) => gl!.getUniformLocation(prog, name);
  const U = { origin: u('uOrigin'), scale: u('uScale'), h: u('uH'), drop: u('uDrop'), dropS: u('uDropS'), sheet: u('uSheet'), radii: u('uRadii'), edge: u('uEdge'), ink: u('uInk'), look: u('uLook') };
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);
  let lost = false;
  const target = canvas as unknown as EventTarget;
  target.addEventListener?.('webglcontextlost', () => (lost = true));

  const clear = () => {
    if (lost || !gl) return;
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
  };
  clear();
  return {
    ok: () => !lost && !!gl && !gl.isContextLost(),
    dispose() {
      lost = true;
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      gl = null;
    },
    clear,
    draw(frames, origin) {
      if (lost || !gl) return;
      clear();
      const W = canvas.width;
      const H = canvas.height;
      gl.enable(gl.SCISSOR_TEST);
      gl.uniform2f(U.origin, origin.x, origin.y);
      gl.uniform1f(U.scale, scale);
      gl.uniform1f(U.h, H);
      for (const f of frames) {
        const b = frameBounds(f);
        if (!b) continue;
        // The frame's region in device px (y up), inside the canvas.
        const x0 = Math.max(0, Math.floor((b.x0 - origin.x) * scale));
        const x1 = Math.min(W, Math.ceil((b.x1 - origin.x) * scale));
        const y0 = Math.max(0, Math.floor((b.y0 - origin.y) * scale));
        const y1 = Math.min(H, Math.ceil((b.y1 - origin.y) * scale));
        if (x1 <= x0 || y1 <= y0) continue;
        gl.scissor(x0, H - y1, x1 - x0, y1 - y0);
        const d = f.drop;
        gl.uniform4f(U.drop, d?.x ?? 0, d?.y ?? 0, d?.r ?? 1, d ? 1 : 0);
        gl.uniform3f(U.dropS, d?.sx ?? 1, d?.sy ?? 1, d?.ang ?? 0);
        const s = f.sheet;
        if (s) {
          gl.uniform4f(U.sheet, s.left, s.top, s.right, s.bottom);
          gl.uniform4f(U.radii, s.radii[0], s.radii[1], s.radii[2], s.radii[3]);
        } else gl.uniform4f(U.sheet, 0, 0, 0, 0);
        gl.uniform3f(U.edge, f.edge?.y ?? 0, f.edge?.k ?? 0, f.edge ? 1 : 0);
        const c = INK.fill.map((v, i) => lerp(v, INK.lift[i], f.light) / 255);
        gl.uniform4f(U.ink, c[0], c[1], c[2], INK.a);
        gl.uniform4f(U.look, f.light, INK.rim, INK.lit, f.alpha);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    },
  };
}

/** The 2D fallback: the same shapes as paths (no meniscus), the ink and its hairline. */
function canvas2d(canvas: AnyCanvas, scale: number): LiquidRenderer | null {
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) return null;
  const clear = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  };
  return {
    ok: () => true,
    dispose() {
      canvas.width = 1;
      canvas.height = 1;
    },
    clear,
    draw(frames, origin) {
      clear();
      ctx.setTransform(scale, 0, 0, scale, -origin.x * scale, -origin.y * scale);
      for (const f of frames) {
        if (f.done || f.alpha <= 0.001) continue;
        const p = new Path2D();
        const d = f.drop;
        if (d) p.ellipse(d.x, d.y, d.r * d.sx, d.r * d.sy, d.ang, 0, Math.PI * 2);
        const s = f.sheet;
        if (s) p.roundRect(s.left, s.top, s.right - s.left, s.bottom - s.top, s.radii);
        ctx.save();
        ctx.globalAlpha = f.alpha;
        if (f.edge) {
          ctx.beginPath();
          ctx.rect(-1e5, -1e5, 2e5, 1e5 + f.edge.y);
          ctx.clip();
        }
        const c = INK.fill.map((v, i) => Math.round(lerp(v, INK.lift[i], f.light)));
        ctx.fillStyle = `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${INK.a})`;
        ctx.fill(p);
        ctx.clip(p);
        ctx.lineWidth = 2;
        ctx.strokeStyle = `rgba(242, 241, 238, ${lerp(INK.rim, INK.lit * 0.6, f.light).toFixed(3)})`;
        ctx.stroke(p);
        ctx.restore();
      }
    },
  };
}

/** A renderer for `canvas` (sized in device px; `scale` device px per page px): WebGL where it can, else 2D. */
export function makeRenderer(canvas: AnyCanvas, scale: number, prefer: 'gl' | '2d' = 'gl'): LiquidRenderer | null {
  return (prefer === 'gl' ? glRenderer(canvas, scale) : null) ?? canvas2d(canvas, scale);
}
