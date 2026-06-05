import { useEffect, useRef } from "react";

/**
 * GLASSHOUSE auth atlas — an interactive Obsidian-style knowledge graph for the
 * sign-in screen. A force-directed graph of "notes" clustered around amber
 * "lobes": it settles, then gently breathes. You can drag a node (the cluster
 * reacts), drag empty space to pan, scroll to zoom, and hover to focus a node
 * and its neighbours (the rest dims). When idle it eases back to a centered,
 * composed frame. Self-contained canvas, no dependencies. Honors
 * prefers-reduced-motion (settles once, statically, with no interaction).
 */
const TEAL: [number, number, number] = [79, 184, 168]; // --status-running
const AMBER: [number, number, number] = [240, 162, 60]; // --primary (sodium)
const N = 150;
const HUBS = 7;

// Amber lobes = the kinds of company the OS runs. Focusing one reveals the
// teal agent/task nodes (LEAF_LABELS) that make that company run itself.
const HUB_LABELS = ["Tech Founder", "Small Business", "Agency", "Creator", "E-commerce", "Consultant", "Local Shop"];
const LEAF_LABELS = [
  "CEO", "Engineer", "Designer", "Marketing", "Sales", "Support", "Bookkeeping",
  "Research", "Outreach", "Content", "QA", "Deploy", "Invoicing", "Analytics",
  "Hiring", "Ops", "Social", "SEO", "Email", "Roadmap", "Payroll", "Inventory",
  "CRM", "Reports", "Standup", "Ads", "Pricing", "Onboarding",
];

interface Node { x: number; y: number; vx: number; vy: number; hub: boolean; r: number; tw: number; label: string; }

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
    let s = 20260604;
    const rng = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

    // ---- build a clustered knowledge graph (amber lobes + teal notes) ----
    const nodes: Node[] = [];
    const edges: [number, number][] = [];
    const adj: number[][] = Array.from({ length: N }, () => []);
    for (let i = 0; i < N; i++) {
      const hub = i < HUBS;
      nodes.push({
        x: (rng() - 0.5) * 600, y: (rng() - 0.5) * 440,
        vx: 0, vy: 0, hub, r: 0, tw: rng() * 6.28,
        label: hub ? HUB_LABELS[i] : LEAF_LABELS[(i - HUBS) % LEAF_LABELS.length],
      });
    }
    const link = (a: number, b: number) => {
      if (a === b || adj[a].includes(b)) return;
      const idx = edges.length; edges.push([a, b]); adj[a].push(b); adj[b].push(a);
      return idx;
    };
    const deg = new Array(N).fill(0);
    const countDeg = (a: number, b: number) => { deg[a]++; deg[b]++; };
    for (let i = HUBS; i < N; i++) {
      const hub = (rng() * HUBS) | 0; if (link(i, hub) !== undefined) countDeg(i, hub);
      const k = (rng() < 0.5 ? 1 : 0) + (rng() < 0.25 ? 1 : 0);
      for (let n = 0; n < k; n++) { const j = HUBS + ((rng() * (N - HUBS)) | 0); if (link(i, j) !== undefined) countDeg(i, j); }
    }
    for (let h = 0; h < HUBS; h++) { const t = (rng() * HUBS) | 0; if (link(h, t) !== undefined) countDeg(h, t); }
    for (let i = 0; i < N; i++) nodes[i].r = (nodes[i].hub ? 4.5 : 2.2) + Math.min(4, Math.sqrt(deg[i]) * 0.9);

    // ---- canvas sizing + camera ----
    let W = 0, H = 0, DPR = 1;
    const cam = { x: 0, y: 0, k: 1 };
    const home = { x: 0, y: 0, k: 1 };
    const resize = () => {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      W = wrap.clientWidth; H = wrap.clientHeight;
      cv.width = W * DPR; cv.height = H * DPR;
      cv.style.width = W + "px"; cv.style.height = H + "px";
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      home.k = Math.max(0.5, Math.min(W, H) / 660); // graph fills the panel
    };
    resize();
    cam.k = home.k;
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // ---- force sim ----
    const CHARGE = 260, SPRING = 0.022, LINKLEN = 46, GRAVITY = 0.018, FRICTION = 0.84;
    let alpha = 1;
    let drag: Node | null = null, hover = -1, mx = 0, my = 0;
    let panning = false, panSX = 0, panSY = 0, panCX = 0, panCY = 0;
    let lastInteract = -1e9; // timestamp of last user input
    // Auto-tour: cycle through the persona lobes, focusing each one.
    const TOUR_ORDER = Array.from({ length: HUBS }, (_, i) => i);
    let tourStep = -1, tourNextAt = 0, tourNode = 0;
    const IDLE_MS = 4000; // resume the tour this long after the last input

    const tick = () => {
      if (alpha > 0.045) alpha *= 0.992; else alpha = 0.045; // floor keeps it gently alive
      for (let i = 0; i < N; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < N; j++) {
          const b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy; if (d2 < 1) d2 = 1;
          const d = Math.sqrt(d2), f = (CHARGE * alpha) / d2, fx = (dx / d) * f, fy = (dy / d) * f;
          a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
        }
      }
      for (const [i, j] of edges) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y; const d = Math.hypot(dx, dy) || 1;
        const l = ((d - LINKLEN) / d) * SPRING * alpha; dx *= l; dy *= l;
        a.vx += dx; a.vy += dy; b.vx -= dx; b.vy -= dy;
      }
      for (const n of nodes) {
        if (n === drag) { n.x = mx; n.y = my; n.vx = 0; n.vy = 0; continue; }
        n.vx -= n.x * GRAVITY * alpha; n.vy -= n.y * GRAVITY * alpha;
        n.x += n.vx; n.y += n.vy; n.vx *= FRICTION; n.vy *= FRICTION;
      }
    };

    const draw = (ts: number) => {
      tick();
      // Auto-tour: when idle, fly node-to-node and focus each persona lobe so a
      // viewer sees how the graph works without touching it. Any input pauses it.
      const idle = !drag && !panning && ts - lastInteract > IDLE_MS;
      if (idle) {
        if (ts > tourNextAt) {
          tourStep = (tourStep + 1) % TOUR_ORDER.length;
          tourNode = TOUR_ORDER[tourStep];
          tourNextAt = ts + 5200;
          alpha = Math.max(alpha, 0.18); // a little life on each move
        }
        const t = nodes[tourNode], tk = home.k * 1.55;
        cam.x += (-t.x - cam.x) * 0.03;
        cam.y += (-t.y - cam.y) * 0.03;
        cam.k += (tk - cam.k) * 0.03;
        hover = tourNode; // reveal its label + neighbours
      }

      ctx.clearRect(0, 0, W, H);
      const grad = ctx.createRadialGradient(W * 0.5, H * 0.46, 0, W * 0.5, H * 0.46, Math.max(W, H) * 0.55);
      grad.addColorStop(0, "rgba(79,184,168,0.05)"); grad.addColorStop(1, "rgba(10,11,13,0)");
      ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);

      ctx.save();
      ctx.translate(W / 2, H / 2); ctx.scale(cam.k, cam.k); ctx.translate(cam.x, cam.y);

      const hi = hover >= 0 ? new Set<number>([hover, ...adj[hover]]) : null;

      // edges
      for (const [i, j] of edges) {
        const a = nodes[i], b = nodes[j];
        const lit = hover >= 0 && (i === hover || j === hover);
        const on = hi ? hi.has(i) && hi.has(j) : true;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.lineWidth = (lit ? 1.4 : 0.7) / cam.k;
        ctx.strokeStyle = `rgba(79,184,168,${hi ? (on ? (lit ? 0.5 : 0.14) : 0.035) : 0.12})`;
        ctx.stroke();
      }
      // nodes
      for (let i = 0; i < N; i++) {
        const n = nodes[i];
        const focus = hi ? hi.has(i) : true;
        const tw = 0.72 + 0.28 * Math.sin(ts / 720 + n.tw);
        const col = n.hub ? AMBER : TEAL;
        const a = (hi ? (focus ? 1 : 0.2) : 0.85) * tw;
        ctx.beginPath();
        ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${a.toFixed(3)})`;
        ctx.shadowColor = `rgba(${col[0]},${col[1]},${col[2]},0.9)`;
        ctx.shadowBlur = (n.hub ? 12 : 6) * (focus ? 1 : 0.3);
        ctx.arc(n.x, n.y, Math.max(0.5, n.r / Math.sqrt(cam.k)), 0, 6.28); ctx.fill();
      }
      ctx.shadowBlur = 0;

      // labels: persona lobes are always named; agent/task nodes reveal their
      // names only when their lobe is in focus (hover or auto-tour).
      ctx.textBaseline = "middle";
      ctx.font = `${(12 / cam.k).toFixed(2)}px "JetBrains Mono", ui-monospace, monospace`;
      for (let i = 0; i < N; i++) {
        const n = nodes[i];
        const focus = hi ? hi.has(i) : false;
        if (!n.hub && !focus) continue;
        let a = 0;
        if (focus) a = i === hover ? 0.95 : 0.6;
        else a = hi ? 0.2 : 0.4; // persona label, dimmed when another is focused
        if (a <= 0) continue;
        ctx.fillStyle = n.hub ? `rgba(240,200,150,${a})` : `rgba(232,230,225,${a})`;
        ctx.fillText(n.label, n.x + (n.r + 6) / cam.k, n.y);
      }

      ctx.restore();
    };

    let raf = 0;
    const loop = (ts: number) => { draw(ts); raf = requestAnimationFrame(loop); };

    // ---- interaction ----
    const toWorld = (sx: number, sy: number) => ({ x: (sx - W / 2) / cam.k - cam.x, y: (sy - H / 2) / cam.k - cam.y });
    const local = (e: MouseEvent) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const pick = (sx: number, sy: number) => {
      const w = toWorld(sx, sy); let best = -1, bd = 1e9;
      for (let i = 0; i < N; i++) {
        const n = nodes[i], d = Math.hypot(n.x - w.x, n.y - w.y), rr = n.r / Math.sqrt(cam.k) + 7 / cam.k;
        if (d < rr && d < bd) { bd = d; best = i; }
      }
      return best;
    };
    const onMove = (e: MouseEvent) => {
      const p = local(e); const w = toWorld(p.x, p.y); mx = w.x; my = w.y;
      if (drag) { alpha = Math.max(alpha, 0.3); lastInteract = performance.now(); return; }
      if (panning) { cam.x = panCX + (p.x - panSX) / cam.k; cam.y = panCY + (p.y - panSY) / cam.k; lastInteract = performance.now(); return; }
      hover = pick(p.x, p.y);
    };
    const onDown = (e: MouseEvent) => {
      const p = local(e); const hit = pick(p.x, p.y); lastInteract = performance.now();
      if (hit >= 0) { drag = nodes[hit]; alpha = 0.5; cv.style.cursor = "grabbing"; }
      else { panning = true; panSX = p.x; panSY = p.y; panCX = cam.x; panCY = cam.y; cv.style.cursor = "grabbing"; }
    };
    const onUp = () => { drag = null; panning = false; cv.style.cursor = "grab"; };
    const onLeave = () => { hover = -1; };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); lastInteract = performance.now();
      const p = local(e);
      const f = Math.exp(-e.deltaY * 0.0015);
      const nk = Math.min(home.k * 3.5, Math.max(home.k * 0.4, cam.k * f));
      const wx = (p.x - W / 2) / cam.k - cam.x, wy = (p.y - H / 2) / cam.k - cam.y;
      cam.k = nk; cam.x = (p.x - W / 2) / cam.k - wx; cam.y = (p.y - H / 2) / cam.k - wy;
    };

    if (reduce) {
      for (let i = 0; i < 420; i++) tick(); // settle synchronously
      alpha = 0; draw(performance.now());
    } else {
      cv.style.cursor = "grab";
      cv.addEventListener("mousemove", onMove);
      cv.addEventListener("mousedown", onDown);
      cv.addEventListener("mouseleave", onLeave);
      cv.addEventListener("wheel", onWheel, { passive: false });
      window.addEventListener("mouseup", onUp);
      raf = requestAnimationFrame(loop);
    }

    return () => {
      cancelAnimationFrame(raf); ro.disconnect();
      cv.removeEventListener("mousemove", onMove);
      cv.removeEventListener("mousedown", onDown);
      cv.removeEventListener("mouseleave", onLeave);
      cv.removeEventListener("wheel", onWheel);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 block" />
      {/* serif tagline + live marker, GLASSHOUSE — pointer-events-none so the
          graph stays draggable underneath it */}
      {showTagline && (
        <div className="pointer-events-none absolute bottom-10 left-9 right-9">
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
