import { useEffect, useRef } from "react";

/**
 * GLASSHOUSE auth atlas — a live 3D knowledge-graph "brain" for the sign-in
 * screen. A node cloud tumbles on all three axes; signals fire continuously,
 * chaining branch to branch; each node flashes on its own clock. Replaces the
 * inherited Paperclip ASCII animation. Self-contained canvas, no dependencies.
 * Honors prefers-reduced-motion (renders a single static frame).
 */
const TEAL: [number, number, number] = [79, 184, 168]; // --status-running
const AMBER: [number, number, number] = [240, 162, 60]; // --primary (sodium)
const N = 210;

interface Node {
  x: number; y: number; z: number; hub: boolean; base: number;
  freq: number; phase: number; amp: number;
  sx: number; sy: number; sz: number; ss: number;
}
interface Pulse { from: number; to: number; t: number; sp: number }

export function AuthAtlas({ showTagline = true }: { showTagline?: boolean } = {}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const cv = canvasRef.current;
    if (!wrap || !cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    // deterministic PRNG so the graph is stable across mounts
    let s = 1337;
    const rng = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

    // build node cloud
    const nodes: Node[] = [];
    for (let i = 0; i < N; i++) {
      const u = rng(), v = rng(), w = Math.cbrt(rng());
      const theta = u * Math.PI * 2, phi = Math.acos(2 * v - 1);
      const x = w * Math.sin(phi) * Math.cos(theta) * 1.25;
      const y = w * Math.sin(phi) * Math.sin(theta) * 0.95;
      const z = w * Math.cos(phi);
      const hub = rng() < 0.11;
      const fast = rng() < 0.35;
      nodes.push({
        x, y, z, hub, base: (hub ? 2.1 : 0.95) + rng() * 0.8,
        freq: fast ? 1.8 + rng() * 2.2 : 0.3 + rng() * 0.8,
        phase: rng() * 6.28, amp: 0.35 + rng() * 0.45,
        sx: 0, sy: 0, sz: 0, ss: 1,
      });
    }
    // nearest-neighbour edges (stable graph) + adjacency
    const edges: [number, number][] = [];
    for (let i = 0; i < N; i++) {
      const d: [number, number][] = [];
      for (let j = 0; j < N; j++) if (i !== j) {
        const dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y, dz = nodes[i].z - nodes[j].z;
        d.push([dx * dx + dy * dy + dz * dz, j]);
      }
      d.sort((a, b) => a[0] - b[0]);
      const k = 3 + (rng() < 0.4 ? 1 : 0);
      for (let n = 0; n < k; n++) { const j = d[n][1]; if (j > i) edges.push([i, j]); }
    }
    const adj: number[][] = Array.from({ length: N }, () => []);
    edges.forEach((e, idx) => { adj[e[0]].push(idx); adj[e[1]].push(idx); });

    const pulses: Pulse[] = [];
    const newPulseFrom = (i: number): Pulse | null => {
      const es = adj[i]; if (!es.length) return null;
      const e = edges[es[(rng() * es.length) | 0]];
      return { from: i, to: e[0] === i ? e[1] : e[0], t: 0, sp: 0.7 + rng() * 1.0 };
    };
    const seedPulse = () => { const p = newPulseFrom((rng() * N) | 0); if (p) pulses.push(p); };

    let W = 0, H = 0, DPR = 1;
    const FOCAL = 2.6;
    let SCALE = 1;
    const resize = () => {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      W = wrap.clientWidth; H = wrap.clientHeight;
      cv.width = W * DPR; cv.height = H * DPR;
      cv.style.width = W + "px"; cv.style.height = H + "px";
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      SCALE = Math.min(W, H);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let angX = 0, angY = 0, angZ = 0, last = 0, raf = 0;
    let cax = 1, sax = 0, cay = 1, say = 0, caz = 1, saz = 0;

    const project = (n: Node, cx: number, cy: number, sc: number) => {
      let x = n.x, y = n.y, z = n.z;
      let x1 = x * caz - y * saz, y1 = x * saz + y * caz; x = x1; y = y1;
      let x2 = x * cay - z * say, z2 = x * say + z * cay; x = x2; z = z2;
      let y3 = y * cax - z * sax, z3 = y * sax + z * cax; y = y3; z = z3;
      const persp = FOCAL / (FOCAL + z);
      n.sx = cx + x * sc * persp; n.sy = cy + y * sc * persp; n.sz = z; n.ss = persp;
    };

    const frame = (ts: number) => {
      const dt = last ? Math.min((ts - last) / 1000, 0.05) : 0.016; last = ts;
      if (!reduce) { angY += dt * 0.17; angX += dt * 0.09; angZ += dt * 0.05; }
      cax = Math.cos(angX); sax = Math.sin(angX);
      cay = Math.cos(angY); say = Math.sin(angY);
      caz = Math.cos(angZ); saz = Math.sin(angZ);
      if (!reduce) { let g = 0; while (pulses.length < 32 && g++ < 40) seedPulse(); }

      ctx.clearRect(0, 0, W, H);
      const grad = ctx.createRadialGradient(W * 0.5, H * 0.46, 0, W * 0.5, H * 0.46, Math.max(W, H) * 0.55);
      grad.addColorStop(0, "rgba(79,184,168,0.05)"); grad.addColorStop(1, "rgba(10,11,13,0)");
      ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);

      const cx = W * 0.5, cy = H * 0.46, sc = SCALE * 0.34;
      for (const n of nodes) project(n, cx, cy, sc);

      ctx.lineWidth = 1;
      for (const [i, j] of edges) {
        const a = nodes[i], b = nodes[j];
        const al = 0.06 + ((a.ss + b.ss) * 0.5) * 0.16;
        ctx.strokeStyle = `rgba(79,184,168,${al.toFixed(3)})`;
        ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
      }
      for (let p = pulses.length - 1; p >= 0; p--) {
        const pu = pulses[p]; pu.t += dt * pu.sp;
        if (pu.t >= 1) {
          if (!reduce && rng() < 0.85) {
            const es = adj[pu.to];
            const e = edges[es[(rng() * es.length) | 0]];
            const nxt = e[0] === pu.to ? e[1] : e[0];
            if (nxt !== pu.from || es.length === 1) { pu.from = pu.to; pu.to = nxt; pu.t = 0; pu.sp = 0.7 + rng() * 1.0; }
            else pulses.splice(p, 1);
          } else pulses.splice(p, 1);
          continue;
        }
        const a = nodes[pu.from], b = nodes[pu.to];
        const px = a.sx + (b.sx - a.sx) * pu.t, py = a.sy + (b.sy - a.sy) * pu.t;
        const depth = 0.5 + 0.5 * ((a.ss + b.ss) * 0.5);
        ctx.beginPath(); ctx.fillStyle = `rgba(150,240,220,${0.85 * depth})`;
        ctx.shadowColor = "rgba(79,184,168,0.95)"; ctx.shadowBlur = 10;
        ctx.arc(px, py, 1.7 * depth, 0, 6.28); ctx.fill(); ctx.shadowBlur = 0;
      }
      const order = [...nodes].sort((a, b) => a.sz - b.sz);
      for (const n of order) {
        const tw = Math.max(0.15, 0.55 + n.amp * Math.sin(ts * 0.001 * n.freq * 6.283 + n.phase));
        const col = n.hub ? AMBER : TEAL;
        const rad = n.base * n.ss * (n.hub ? 1.3 : 1);
        ctx.beginPath();
        ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${((0.55 + 0.35 * n.ss) * tw).toFixed(3)})`;
        ctx.shadowColor = `rgba(${col[0]},${col[1]},${col[2]},0.9)`;
        ctx.shadowBlur = (n.hub ? 14 : 8) * n.ss;
        ctx.arc(n.sx, n.sy, Math.max(0.4, rad), 0, 6.28); ctx.fill();
      }
      ctx.shadowBlur = 0;
      if (!reduce) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 block" />
      {/* serif tagline + live marker, GLASSHOUSE */}
      {showTagline && (
      <div className="absolute bottom-10 left-9 right-9">
        <p className="font-serif text-2xl leading-snug text-foreground max-w-sm">
          The company that <em className="not-italic text-primary italic">runs itself</em>. Watch it work.
        </p>
        <span className="mt-3 inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          <span className="h-[7px] w-[7px] rounded-full bg-status-running shadow-[0_0_8px_var(--status-running)]" />
          4 agents working now
        </span>
      </div>
      )}
    </div>
  );
}
