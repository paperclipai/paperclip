// Orbiting 3D paperclip — the animated backdrop behind the onboarding auth
// screens. Ported from the Paperclip graphic generator's 3D tab
// (paperclip-gen.vercel.app) with its default settings plus auto-orbit on:
// the same SVG-derived clip path, tube/cap geometry, "soft" gradient shader,
// and orbit math, so the motif matches the generator exactly.
//
// three.js is heavy, so this module is loaded lazily (see OnboardingBackdrop).
import { useEffect, useRef } from "react";
import * as THREE from "three";

// ── Generator defaults (3D tab) ───────────────────────────────────────────
const TUBE_RADIUS = 0.225;
const TUBE_SEG = 48; // radial segments
const PATH_SEG = 300; // segments along the clip path
const CAPS = true; // hemispherical caps
const LIGHT_SOFT = 0;
const LIGHT_ANGLE = 3.87;
const EMISSIVE = 1;
const CAM_DIST = 5;
const FOV = 45;
/** Auto-orbit speed. 0.5 was the generator default; slowed 25% to 0.375. */
const ROT_SPEED = 0.375;
/** Tilt oscillation rate. Slowed 25% alongside ROT_SPEED so the orbit's
 *  rotation and tilt stay in the same relationship, just 25% calmer. */
const TILT_RATE = 0.2625;
/** Tilt amplitude of the orbit. Pace is set by the sin() frequency below, so
 *  raising this swings further without speeding the motion up. */
const AXIS_TILT = 1.2;
/** Clip is scaled up 30% from the generator's default framing. */
const CLIP_UPSCALE = 1.3;

// Colour: instead of the generator's "animate gradient" (which scrolls the
// gradient ALONG the clip), the gradient stops hold their position and the two
// stops slowly crossfade through this palette, so the whole clip cycles hue as
// it orbits. Drawn from the brand agent-gradient stops, limited to the
// saturated ones — the brand pastels (cream/peach/lavender) read as washed-out
// grey against the dark backdrop.
const PALETTE: Array<[string, string]> = [
  ["#4fbcba", "#3aa35c"], // teal → green (the reference comp's colourway)
  ["#3aa35c", "#f2d95f"], // green → yellow
  ["#e3a21a", "#e94b27"], // amber → orange-red
  ["#ee79a1", "#bd7ff0"], // pink → purple
  ["#7eb6e3", "#3355ff"], // light blue → blue
  ["#3355ff", "#cc3388"], // blue → magenta (generator default)
];
/** Seconds each palette pair holds before crossfading into the next. */
const PALETTE_CYCLE_SECONDS = 9;
/**
 * Static gradient position along the path (no scrolling — "animate gradient" is
 * off). Must stay 0: the shader wraps the gradient with mod(t, 1.0), and any
 * non-zero shift puts that wrap seam partway along the clip, which makes the
 * end caps (whose gradient-t is pinned to the path ends) sample across the seam
 * and read as a different colour from the tube beside them.
 */
const GRADIENT_SHIFT = 0;

// The clip motif: an SVG path sampled into a Catmull-Rom curve. Scale + center
// come from the generator so proportions match.
const CLIP_PATH_D =
  "M5.00146 4.99569V21.005C5.00146 22.1084 5.89689 23.0028 7.00146 23.0028C8.10603 23.0028 9.00147 22.1084 9.00147 21.005L9 4.99569C9 2.78893 7.20914 1 5 1C2.79086 1 1 2.78893 1 4.99569V21.005C1 24.3159 3.68695 27 7.00146 27C10.316 27 13.0029 24.3159 13.0029 21.005L13.0029 4.99569";
const CLIP_CENTER = { cx: 7, cy: 14 };
const CLIP_SCALE = 1 / 6.5;
const CURVE_SAMPLES = 200;

const VERTEX_SHADER = `
  attribute float aPathT;
  attribute float aCapT;   // -1.0 for tube verts; explicit gradient-t for cap verts
  varying vec3  vWorldNormal;
  varying float vPathT;
  varying float vCapT;
  void main() {
    vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    vPathT = aPathT;
    vCapT  = aCapT;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  #define MAX_COLORS 8
  uniform vec3  uColors[MAX_COLORS];
  uniform int   uNColors;
  uniform float uShift;
  uniform float uSoftness;
  uniform vec3  uLightDir;
  uniform float uEmissive;
  varying vec3  vWorldNormal;
  varying float vPathT;
  varying float vCapT;

  vec3 sampleGradAt(float t) {
    float n   = float(uNColors);
    float nc  = n;
    float pos = clamp(t * (n - 1.0), 0.0, n - 1.0001);
    int   idx = int(pos);
    float f   = smoothstep(0.0, 1.0, pos - float(idx));
    vec3 cols[MAX_COLORS];
    cols[0]=uColors[0];cols[1]=uColors[1];cols[2]=uColors[2];cols[3]=uColors[3];
    cols[4]=uColors[4];cols[5]=uColors[5];cols[6]=uColors[6];cols[7]=uColors[7];
    int i0 = int(mod(float(idx),   nc));
    int i1 = int(mod(float(idx+1), nc));
    return mix(cols[i0], cols[i1], f);
  }

  void main() {
    float shiftT = uShift / (2.0 * 3.14159265);
    float rawT   = (vCapT >= 0.0) ? vCapT : vPathT;
    float nCols  = float(uNColors);
    float scaled = rawT * (nCols - 1.0) / nCols;
    float t      = mod(scaled + shiftT, 1.0);
    vec3 baseColor = sampleGradAt(t);

    vec3  nor   = normalize(vWorldNormal);
    float wrap  = mix(0.0, 0.6, uSoftness);
    float NdotL = dot(nor, normalize(uLightDir));
    float diff  = smoothstep(0.0, 1.0, clamp((NdotL + wrap) / (1.0 + wrap), 0.0, 1.0));
    float ambient = mix(0.3, 0.6, uSoftness);
    vec3  lit   = baseColor * (ambient + diff * (1.0 - ambient));
    lit = mix(lit, baseColor, uEmissive * 0.85);
    lit = pow(max(lit, vec3(0.0)), vec3(1.0 / 2.2));
    gl_FragColor = vec4(lit, 1.0);
  }
`;

/** Sample the clip SVG path into a centered, scaled Catmull-Rom curve. */
function buildClipCurve(): THREE.CatmullRomCurve3 {
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  const path = document.createElementNS(svgNS, "path");
  path.setAttribute("d", CLIP_PATH_D);
  svg.appendChild(path);
  document.body.appendChild(svg);

  const total = path.getTotalLength();
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= CURVE_SAMPLES; i++) {
    const p = path.getPointAtLength((i / CURVE_SAMPLES) * total);
    points.push(
      new THREE.Vector3(
        (p.x - CLIP_CENTER.cx) * CLIP_SCALE,
        -(p.y - CLIP_CENTER.cy) * CLIP_SCALE,
        0,
      ),
    );
  }
  document.body.removeChild(svg);
  return new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.1);
}

/** Hemispherical end cap oriented along `normal`, tagged with its gradient t. */
function buildCap(
  center: THREE.Vector3,
  normal: THREE.Vector3,
  radius: number,
  radialSeg: number,
  pathT: number,
): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(
    radius,
    radialSeg,
    Math.ceil(radialSeg / 2),
    0,
    Math.PI * 2,
    0,
    Math.PI / 2,
  );
  const count = geo.attributes.position.count;
  geo.setAttribute("aPathT", new THREE.BufferAttribute(new Float32Array(count).fill(pathT), 1));
  geo.setAttribute("aCapT", new THREE.BufferAttribute(new Float32Array(count).fill(pathT), 1));
  const up = new THREE.Vector3(0, 1, 0);
  const quat = new THREE.Quaternion().setFromUnitVectors(up, normal.clone().normalize());
  geo.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(quat));
  geo.translate(center.x, center.y, center.z);
  return geo;
}

export function PaperclipOrbit3D({ className }: { className?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Respect reduced motion: render a single static frame instead of orbiting.
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      return; // No WebGL — the backdrop simply stays empty.
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);

    // ── Material (generator's "soft" mode) ──
    // Two live stops; the render loop crossfades them through PALETTE.
    const uColors = Array.from({ length: 8 }, () => new THREE.Vector3(1, 1, 1));
    const paletteColors = PALETTE.map(
      ([a, b]) => [new THREE.Color(a), new THREE.Color(b)] as const,
    );
    const stopA = new THREE.Color();
    const stopB = new THREE.Color();
    // Stops are declared as [A, B, B] (nColors 3) rather than [A, B]: the
    // shader maps path position through `rawT * (n-1)/n`, so with 2 colours the
    // clip would only reach the A→B midpoint. The repeated final stop lets the
    // gradient complete A→B across the clip while keeping t inside [0,1) — no
    // mod() wrap, so the end caps still match the tube.
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColors: { value: uColors },
        uNColors: { value: 3 },
        uShift: { value: GRADIENT_SHIFT },
        uSoftness: { value: LIGHT_SOFT },
        uLightDir: {
          value: new THREE.Vector3(
            Math.cos(LIGHT_ANGLE) * 0.7,
            0.8,
            Math.sin(LIGHT_ANGLE) * 0.7,
          ).normalize(),
        },
        uEmissive: { value: EMISSIVE },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      side: THREE.DoubleSide,
    });

    // ── Geometry: tube along the clip curve + hemispherical caps ──
    const curve = buildClipCurve();
    const group = new THREE.Group();
    const geometries: THREE.BufferGeometry[] = [];

    const tube = new THREE.TubeGeometry(curve, PATH_SEG, TUBE_RADIUS, TUBE_SEG, false);
    // TubeGeometry lays out (PATH_SEG+1) rings of (TUBE_SEG+1) verts: aPathT is
    // the ring's position along the path; aCapT -1 marks "not a cap".
    {
      const count = tube.attributes.position.count;
      const pathT = new Float32Array(count);
      const capT = new Float32Array(count).fill(-1);
      const ring = TUBE_SEG + 1;
      for (let i = 0; i < count; i++) pathT[i] = Math.floor(i / ring) / PATH_SEG;
      tube.setAttribute("aPathT", new THREE.BufferAttribute(pathT, 1));
      tube.setAttribute("aCapT", new THREE.BufferAttribute(capT, 1));
    }
    geometries.push(tube);

    if (CAPS) {
      const pts = curve.getPoints(PATH_SEG);
      const startNormal = pts[1].clone().sub(pts[0]).normalize().negate();
      const endNormal = pts[pts.length - 1]
        .clone()
        .sub(pts[pts.length - 2])
        .normalize();
      geometries.push(buildCap(pts[0], startNormal, TUBE_RADIUS, TUBE_SEG, 0));
      geometries.push(buildCap(pts[pts.length - 1], endNormal, TUBE_RADIUS, TUBE_SEG, 1));
    }

    geometries.forEach((geo) => group.add(new THREE.Mesh(geo, material)));
    group.scale.setScalar(CLIP_UPSCALE);
    scene.add(group);

    const target = new THREE.Vector3(0, 0, 0);

    function resize() {
      const w = host!.clientWidth;
      const h = host!.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    // ── Orbit + animated gradient (generator's loop, auto-orbit on) ──
    const start = performance.now();
    let raf = 0;
    function frame() {
      const t = reduceMotion ? 0 : (performance.now() - start) / 1000;
      const theta = t * ROT_SPEED * 0.25;
      const phi = Math.PI / 2 + Math.sin(t * TILT_RATE) * AXIS_TILT;
      camera.position.set(
        target.x + CAM_DIST * Math.sin(phi) * Math.sin(theta),
        target.y + CAM_DIST * Math.cos(phi),
        target.z + CAM_DIST * Math.sin(phi) * Math.cos(theta),
      );
      camera.lookAt(target);

      // Slow colour cycle: ease between consecutive palette pairs so the whole
      // clip crossfades hue over time (the gradient itself stays put on the
      // path — the generator's scrolling "animate gradient" is off).
      const pos = (t / PALETTE_CYCLE_SECONDS) % paletteColors.length;
      const idx = Math.floor(pos);
      const raw = pos - idx;
      const f = raw * raw * (3 - 2 * raw); // smoothstep
      const from = paletteColors[idx];
      const to = paletteColors[(idx + 1) % paletteColors.length];
      // lerpHSL rotates hue instead of crossing through grey, so the clip stays
      // saturated mid-transition (plain RGB lerp muddies opposing hues).
      stopA.copy(from[0]).lerpHSL(to[0], f);
      stopB.copy(from[1]).lerpHSL(to[1], f);
      uColors[0].set(stopA.r, stopA.g, stopA.b);
      // Stops 1..7 all hold B (see the [A, B, B] note above).
      for (let i = 1; i < 8; i++) uColors[i].set(stopB.r, stopB.g, stopB.b);

      renderer.render(scene, camera);
      if (!reduceMotion) raf = requestAnimationFrame(frame);
    }
    frame();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      geometries.forEach((g) => g.dispose());
      material.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={hostRef} className={className} aria-hidden="true" />;
}

export default PaperclipOrbit3D;
