import { useState, useRef, useEffect, useCallback, useMemo, type CSSProperties, type ReactNode } from "react";
import {
  usePluginData,
  usePluginAction,
  type PluginWidgetProps,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RepoKpi {
  repo: string;
  openPRs: number;
  mergedPRsThisWeek: number;
  avgPRCycleMinutes: number;
  commitsThisWeek: number;
  linesChanged: number;
  openIssues: number;
  closedIssuesThisWeek: number;
  deploysThisWeek: number;
  latestRelease: string | null;
  contributors: Array<{ login: string; commits: number }>;
  ciRuns: number;
  ciPassed: number;
  ciFailed: number;
  ciPassRate: number;
}

interface CicdKpis {
  totalRuns: number;
  passed: number;
  failed: number;
  cancelled: number;
  passRate: number;
  avgDurationMinutes: number;
  mttrMinutes: number;
  failuresByAuthor: Array<{ login: string; failures: number }>;
  failuresByWorkflow: Array<{ name: string; repo: string; failures: number; total: number; passRate: number }>;
  recentFailures: Array<{
    repo: string;
    workflow: string;
    branch: string;
    actor: string;
    conclusion: string;
    createdAt: string;
    runNumber: number;
  }>;
}

interface KpiSnapshot {
  syncedAt: string;
  org: string;
  repoCount: number;
  commitsThisWeek: number;
  commitActivitySpark: number[];
  linesChangedThisWeek: number;
  openPRs: number;
  mergedPRsThisWeek: number;
  avgPRCycleMinutes: number;
  openIssues: number;
  closedIssuesThisWeek: number;
  avgIssueResolutionHours: number;
  contributorsThisMonth: number;
  topContributors: Array<{ login: string; commits: number }>;
  deploysThisWeek: number;
  latestRelease: string | null;
  velocityMultiplier: number;
  throughputPerDev: number;
  cicd: CicdKpis;
  repos: RepoKpi[];
}

interface KpiSummaryResult {
  status: "ok" | "pending";
  message?: string;
  snapshot?: KpiSnapshot;
}

interface PRRow {
  number: number;
  title: string;
  repo: string;
  author: string;
  branch: string;
  ageHours: number;
  draft: boolean;
  reviewers: string[];
  additions: number;
  deletions: number;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const card: CSSProperties = {
  padding: "12px 14px",
  borderRadius: 8,
  border: "1px solid var(--border, #2a2a2a)",
  background: "var(--card, #111)",
};

function Metric({ label, value, detail, accent }: { label: string; value: string | number; detail?: ReactNode; accent?: string }) {
  return (
    <div style={card}>
      <div style={{ fontSize: 11, color: "var(--muted-foreground, #888)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.1, fontVariantNumeric: "tabular-nums", color: accent }}>{value}</div>
      {detail && <div style={{ fontSize: 11, color: "var(--muted-foreground, #999)", marginTop: 4 }}>{detail}</div>}
    </div>
  );
}

function SparkLine({ data, height = 32, color }: { data: number[]; height?: number; color?: string }) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const w = 100;
  const pad = 2;
  const stepX = (w - pad * 2) / (data.length - 1);
  const pts = data.map((v, i) => ({ x: pad + i * stepX, y: pad + (1 - v / max) * (height - pad * 2) }));
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const area = `${line} L${pts[pts.length - 1]!.x},${height} L${pts[0]!.x},${height} Z`;
  const c = color ?? "var(--primary, #3b82f6)";
  const id = `sf-${Math.random().toString(36).slice(2, 6)}`;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} preserveAspectRatio="none">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={c} stopOpacity="0.3" />
          <stop offset="100%" stopColor={c} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={c} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function LineChart({ data, labels, height = 220, color = "#3b82f6" }: {
  data: number[];
  labels?: string[];
  height?: number;
  color?: string;
}) {
  if (data.length < 2) return <div style={{ color: "#888", fontSize: 13 }}>Not enough data</div>;
  const max = Math.max(...data, 1);
  const W = 620;
  const H = height;
  const padL = 40;
  const padR = 14;
  const padT = 16;
  const padB = 28;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const stepX = chartW / (data.length - 1);

  const gridLines = 4;
  const gridVals = Array.from({ length: gridLines + 1 }, (_, i) => Math.round((max / gridLines) * (gridLines - i)));

  const pts = data.map((v, i) => ({ x: padL + i * stepX, y: padT + (1 - v / max) * chartH }));
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1]!.x.toFixed(1)},${padT + chartH} L${pts[0]!.x.toFixed(1)},${padT + chartH} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: "block" }}>
      <defs>
        <linearGradient id="lc-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.2" />
          <stop offset="100%" stopColor={color} stopOpacity="0.01" />
        </linearGradient>
      </defs>
      {gridVals.map((val, i) => {
        const y = padT + (i / gridLines) * chartH;
        return (
          <g key={`g${i}`}>
            <line x1={padL} y1={y} x2={padL + chartW} y2={y} stroke="#333" strokeWidth="0.5" strokeDasharray="3,3" />
            <text x={padL - 6} y={y + 3} textAnchor="end" fill="#666" fontSize="9" fontFamily="monospace">{val}</text>
          </g>
        );
      })}
      <path d={area} fill="url(#lc-fill)" />
      <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {pts.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r="3.5" fill="#0a0a0a" stroke={color} strokeWidth="1.5" />
          <text x={p.x} y={p.y - 8} textAnchor="middle" fill="#ccc" fontSize="8" fontFamily="monospace" fontWeight="600">{data[i]}</text>
        </g>
      ))}
      {labels && labels.map((lbl, i) => (
        <text key={i} x={padL + i * stepX} y={H - 6} textAnchor="middle" fill="#666" fontSize="9" fontFamily="monospace">{lbl}</text>
      ))}
    </svg>
  );
}

function RatioBar({ a, b, colorA, colorB, labelA, labelB }: {
  a: number; b: number; colorA: string; colorB: string; labelA: string; labelB: string;
}) {
  const total = a + b || 1;
  const pctA = Math.round((a / total) * 100);
  return (
    <div>
      <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", marginBottom: 6 }}>
        <div style={{ width: `${pctA}%`, background: colorA, transition: "width 0.3s" }} />
        <div style={{ flex: 1, background: colorB }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
        <span style={{ color: colorA }}>{labelA}: {a} ({pctA}%)</span>
        <span style={{ color: colorB }}>{labelB}: {b} ({100 - pctA}%)</span>
      </div>
    </div>
  );
}

function Badge({ children, color }: { children: ReactNode; color: string }) {
  return (
    <span style={{ display: "inline-block", padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 600, background: color, color: "#fff" }}>
      {children}
    </span>
  );
}

function Spinner({ label }: { label?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--muted-foreground, #888)" }}>
      <svg width="16" height="16" viewBox="0 0 16 16" style={{ animation: "spin 1s linear infinite" }}>
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="8" />
      </svg>
      {label && <span style={{ fontSize: 13 }}>{label}</span>}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Force-directed Graph (Obsidian-style) with repo drill-down
// ---------------------------------------------------------------------------

interface GNode {
  id: string;
  type: "repo" | "contributor";
  label: string;
  r: number;
  color: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number | null;
  fy: number | null;
  commits: number;
  ciPassRate?: number;
  nodeKind?: "contributor" | "pr" | "ci-failure";
  draft?: boolean;
  ageHours?: number;
  prNumber?: number;
  prTitle?: string;
  workflow?: string;
}

interface GLink {
  sourceId: string;
  targetId: string;
  weight: number;
  dashed?: boolean;
  linkColor?: string;
}

// ── Org-level graph builder ────────────────────────────────

function buildOrgGraph(repos: RepoKpi[], allContributors: Array<{ login: string; commits: number }>): { nodes: GNode[]; links: GLink[] } {
  const maxCommitsRepo = Math.max(...repos.map((r) => r.commitsThisWeek), 1);
  const maxCommitsContrib = Math.max(...allContributors.map((c) => c.commits), 1);

  const nodes: GNode[] = [];
  const links: GLink[] = [];
  const contribSet = new Set<string>();

  repos.forEach((r) => {
    const intensity = r.commitsThisWeek / maxCommitsRepo;
    nodes.push({
      id: `repo:${r.repo}`,
      type: "repo",
      label: r.repo,
      r: 14 + intensity * 18,
      color: ciColor(r.ciPassRate),
      x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null,
      commits: r.commitsThisWeek,
      ciPassRate: r.ciPassRate,
    });

    (r.contributors ?? []).forEach((c) => {
      if (!contribSet.has(c.login)) {
        contribSet.add(c.login);
        const global = allContributors.find((g) => g.login === c.login);
        const totalCommits = global?.commits ?? c.commits;
        const cIntensity = totalCommits / maxCommitsContrib;
        nodes.push({
          id: `contrib:${c.login}`,
          type: "contributor",
          label: c.login,
          r: 4 + cIntensity * 8,
          color: "#60a5fa",
          x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null,
          commits: totalCommits,
        });
      }
      links.push({
        sourceId: `contrib:${c.login}`,
        targetId: `repo:${r.repo}`,
        weight: Math.min(c.commits / 20, 3),
      });
    });
  });

  scatterCircle(nodes);
  return { nodes, links };
}

// ── Repo-level graph builder ───────────────────────────────

function prAgeColor(hours: number): string {
  if (hours < 4) return "#22c55e";
  if (hours < 24) return "#eab308";
  if (hours < 72) return "#f97316";
  return "#ef4444";
}

function buildRepoGraph(
  repoName: string,
  repos: RepoKpi[],
  prs: PRRow[],
  cicd: CicdKpis,
): { nodes: GNode[]; links: GLink[] } {
  const repo = repos.find((r) => r.repo === repoName);
  if (!repo) return { nodes: [], links: [] };

  const nodes: GNode[] = [];
  const links: GLink[] = [];
  const contribSet = new Set<string>();
  const repoPrs = prs.filter((p) => p.repo === repoName);
  const repoFailures = cicd.recentFailures.filter((f) => f.repo === repoName);

  const maxCommits = Math.max(...(repo.contributors ?? []).map((c) => c.commits), 1);

  // contributor nodes
  (repo.contributors ?? []).forEach((c) => {
    contribSet.add(c.login);
    const intensity = c.commits / maxCommits;
    nodes.push({
      id: `contrib:${c.login}`,
      type: "contributor",
      label: c.login,
      r: 6 + intensity * 10,
      color: "#60a5fa",
      x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null,
      commits: c.commits,
      nodeKind: "contributor",
    });
  });

  // PR nodes
  const maxChange = Math.max(...repoPrs.map((p) => p.additions + p.deletions), 1);
  repoPrs.forEach((pr) => {
    const changeMag = (pr.additions + pr.deletions) / maxChange;
    nodes.push({
      id: `pr:${pr.number}`,
      type: "repo",
      label: `#${pr.number}`,
      r: 8 + changeMag * 12,
      color: prAgeColor(pr.ageHours),
      x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null,
      commits: pr.additions + pr.deletions,
      nodeKind: "pr",
      draft: pr.draft,
      ageHours: pr.ageHours,
      prNumber: pr.number,
      prTitle: pr.title,
    });

    // author edge
    if (contribSet.has(pr.author)) {
      links.push({ sourceId: `contrib:${pr.author}`, targetId: `pr:${pr.number}`, weight: 2 });
    } else {
      contribSet.add(pr.author);
      nodes.push({
        id: `contrib:${pr.author}`,
        type: "contributor",
        label: pr.author,
        r: 5,
        color: "#60a5fa",
        x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null,
        commits: 0,
        nodeKind: "contributor",
      });
      links.push({ sourceId: `contrib:${pr.author}`, targetId: `pr:${pr.number}`, weight: 2 });
    }

    // reviewer edges (dashed)
    pr.reviewers.forEach((rev) => {
      if (!contribSet.has(rev)) {
        contribSet.add(rev);
        nodes.push({
          id: `contrib:${rev}`,
          type: "contributor",
          label: rev,
          r: 5,
          color: "#60a5fa",
          x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null,
          commits: 0,
          nodeKind: "contributor",
        });
      }
      links.push({ sourceId: `contrib:${rev}`, targetId: `pr:${pr.number}`, weight: 1, dashed: true, linkColor: "#818cf8" });
    });
  });

  // CI failure nodes
  repoFailures.forEach((f, i) => {
    const fId = `fail:${f.runNumber}-${i}`;
    nodes.push({
      id: fId,
      type: "repo",
      label: f.workflow,
      r: 7,
      color: "#ef4444",
      x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null,
      commits: 0,
      nodeKind: "ci-failure",
      workflow: f.workflow,
    });

    // link failure to PR on the same branch
    const matchPr = repoPrs.find((p) => p.branch === f.branch);
    if (matchPr) {
      links.push({ sourceId: `pr:${matchPr.number}`, targetId: fId, weight: 1.5, linkColor: "#ef4444" });
    }

    // link failure to the actor
    if (contribSet.has(f.actor)) {
      links.push({ sourceId: `contrib:${f.actor}`, targetId: fId, weight: 1, dashed: true, linkColor: "#ef4444" });
    }
  });

  scatterCircle(nodes);
  return { nodes, links };
}

function scatterCircle(nodes: GNode[]) {
  nodes.forEach((n, i) => {
    const angle = (i / nodes.length) * Math.PI * 2;
    const spread = n.nodeKind === "pr" ? 100 : n.type === "repo" ? 120 : 180;
    n.x = Math.cos(angle) * spread + (Math.random() - 0.5) * 60;
    n.y = Math.sin(angle) * spread + (Math.random() - 0.5) * 60;
  });
}

// ── ForceGraph component ───────────────────────────────────

interface ForceGraphProps {
  repos: RepoKpi[];
  contributors: Array<{ login: string; commits: number }>;
  prs: PRRow[];
  cicd: CicdKpis;
  orgName?: string;
}

function ForceGraph({ repos, contributors, prs, cicd, orgName }: ForceGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<{
    nodes: GNode[];
    links: GLink[];
    nodeMap: Map<string, GNode>;
    transform: { x: number; y: number; k: number };
    hovered: GNode | null;
    dragging: GNode | null;
    dragStart: { mx: number; my: number; ox: number; oy: number; t: number } | null;
    panning: boolean;
    panStart: { mx: number; my: number; tx: number; ty: number } | null;
    animId: number;
    alpha: number;
    w: number;
    h: number;
    onClick: ((node: GNode) => void) | null;
  } | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.round(entry.contentRect.width);
        if (w > 0) setContainerW(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Escape key returns to org view
  useEffect(() => {
    if (!selectedRepo) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setSelectedRepo(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedRepo]);

  const graph = useMemo(() => {
    if (selectedRepo) return buildRepoGraph(selectedRepo, repos, prs, cicd);
    return buildOrgGraph(repos, contributors);
  }, [repos, contributors, prs, cicd, selectedRepo]);

  const toGraph = useCallback((mx: number, my: number) => {
    const s = stateRef.current;
    if (!s) return { gx: 0, gy: 0 };
    return {
      gx: (mx - s.w / 2 - s.transform.x) / s.transform.k,
      gy: (my - s.h / 2 - s.transform.y) / s.transform.k,
    };
  }, []);

  const hitTest = useCallback((gx: number, gy: number): GNode | null => {
    const s = stateRef.current;
    if (!s) return null;
    for (let i = s.nodes.length - 1; i >= 0; i--) {
      const n = s.nodes[i]!;
      const dx = gx - n.x, dy = gy - n.y;
      if (dx * dx + dy * dy <= (n.r + 4) * (n.r + 4)) return n;
    }
    return null;
  }, []);

  // Handle click on nodes
  const handleNodeClick = useCallback((node: GNode) => {
    if (!selectedRepo && node.type === "repo" && !node.nodeKind) {
      setSelectedRepo(node.label);
    }
  }, [selectedRepo]);

  useEffect(() => {
    const cvs = canvasRef.current;
    const container = containerRef.current;
    if (!cvs || !container) return;
    const canvas: HTMLCanvasElement = cvs;

    const w = containerW || container.clientWidth;
    if (w < 10) return;
    const h = 520;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);

    const nodeMap = new Map<string, GNode>();
    graph.nodes.forEach((n) => nodeMap.set(n.id, n));

    const isRepoView = !!selectedRepo;

    const state = {
      nodes: graph.nodes,
      links: graph.links,
      nodeMap,
      transform: { x: 0, y: 0, k: 1 },
      hovered: null as GNode | null,
      dragging: null as GNode | null,
      dragStart: null as { mx: number; my: number; ox: number; oy: number; t: number } | null,
      panning: false,
      panStart: null as { mx: number; my: number; tx: number; ty: number } | null,
      animId: 0,
      alpha: 1,
      w,
      h,
      onClick: handleNodeClick,
    };
    stateRef.current = state;

    // ── Force simulation tick ────────────────────────────────
    function tick() {
      const { nodes, links, nodeMap } = state;
      const repulsion = isRepoView ? 2200 : 2800;
      const attraction = isRepoView ? 0.008 : 0.006;
      const centerPull = 0.01;
      const damping = 0.88;

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]!, b = nodes[j]!;
          let dx = b.x - a.x, dy = b.y - a.y;
          let dist = Math.sqrt(dx * dx + dy * dy) || 1;
          if (dist < 1) dist = 1;
          const force = repulsion / (dist * dist);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.vx -= fx; a.vy -= fy;
          b.vx += fx; b.vy += fy;
        }
      }

      links.forEach((link) => {
        const s = nodeMap.get(link.sourceId);
        const t = nodeMap.get(link.targetId);
        if (!s || !t) return;
        const dx = t.x - s.x, dy = t.y - s.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const idealDist = isRepoView ? 80 + (s.r + t.r) : 100 + (s.r + t.r);
        const force = (dist - idealDist) * attraction * (1 + link.weight * 0.3);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        s.vx += fx; s.vy += fy;
        t.vx -= fx; t.vy -= fy;
      });

      nodes.forEach((n) => {
        n.vx -= n.x * centerPull;
        n.vy -= n.y * centerPull;
      });

      const maxV = 12;
      nodes.forEach((n) => {
        if (n.fx !== null) { n.x = n.fx; n.y = n.fy!; n.vx = 0; n.vy = 0; return; }
        n.vx *= damping;
        n.vy *= damping;
        const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
        if (speed > maxV) { n.vx = (n.vx / speed) * maxV; n.vy = (n.vy / speed) * maxV; }
        n.x += n.vx;
        n.y += n.vy;
      });

      state.alpha *= 0.997;
    }

    // ── Render helpers ───────────────────────────────────────
    function drawDiamond(cx: number, cy: number, r: number) {
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
    }

    // ── Render ──────────────────────────────────────────────
    function render() {
      const { nodes, links, nodeMap, transform, hovered } = state;
      const { x: tx, y: ty, k } = transform;

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#060610";
      ctx.fillRect(0, 0, w, h);

      ctx.save();
      ctx.translate(w / 2 + tx, h / 2 + ty);
      ctx.scale(k, k);

      const connectedIds = new Set<string>();
      if (hovered) {
        connectedIds.add(hovered.id);
        links.forEach((l) => {
          if (l.sourceId === hovered.id) connectedIds.add(l.targetId);
          if (l.targetId === hovered.id) connectedIds.add(l.sourceId);
        });
      }

      // edges
      links.forEach((link) => {
        const s = nodeMap.get(link.sourceId);
        const t = nodeMap.get(link.targetId);
        if (!s || !t) return;
        const highlighted = hovered && (connectedIds.has(s.id) && connectedIds.has(t.id));
        const dimmed = hovered && !highlighted;

        ctx.save();
        if (link.dashed) ctx.setLineDash([4, 3]);

        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);

        const baseColor = link.linkColor ?? "rgba(255,255,255,0.10)";
        ctx.strokeStyle = highlighted
          ? (link.linkColor ?? `rgba(96, 165, 250, ${0.5 + link.weight * 0.15})`)
          : dimmed
            ? "rgba(255,255,255,0.03)"
            : baseColor;
        ctx.lineWidth = highlighted ? 1.2 + link.weight * 0.4 : 0.5 + link.weight * 0.2;
        ctx.globalAlpha = dimmed ? 0.3 : 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.restore();
      });

      // nodes
      nodes.forEach((n) => {
        const highlighted = !hovered || connectedIds.has(n.id);
        const nodeAlpha = highlighted ? 1 : 0.15;

        if (n.nodeKind === "ci-failure") {
          // diamond shape for CI failures
          ctx.globalAlpha = nodeAlpha;
          drawDiamond(n.x, n.y, n.r);
          ctx.fillStyle = "#3b1111";
          ctx.fill();
          drawDiamond(n.x, n.y, n.r);
          ctx.strokeStyle = "#ef4444";
          ctx.lineWidth = n === hovered ? 2.5 : 1.2;
          ctx.stroke();

          if (highlighted) {
            drawDiamond(n.x, n.y, n.r + 4);
            const grad = ctx.createRadialGradient(n.x, n.y, n.r * 0.3, n.x, n.y, n.r + 8);
            grad.addColorStop(0, "#ef444444");
            grad.addColorStop(1, "#ef444400");
            ctx.fillStyle = grad;
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        } else {
          // glow for repo / PR nodes
          if (highlighted && (n.type === "repo" || n.nodeKind === "pr")) {
            ctx.beginPath();
            ctx.arc(n.x, n.y, n.r + 6, 0, Math.PI * 2);
            const grad = ctx.createRadialGradient(n.x, n.y, n.r * 0.5, n.x, n.y, n.r + 10);
            grad.addColorStop(0, n.color + "44");
            grad.addColorStop(1, n.color + "00");
            ctx.fillStyle = grad;
            ctx.fill();
          }

          // body circle
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
          ctx.globalAlpha = nodeAlpha;

          if (n.nodeKind === "pr") {
            ctx.fillStyle = n.color + "33";
            ctx.fill();
            ctx.save();
            if (n.draft) ctx.setLineDash([3, 2]);
            ctx.strokeStyle = n.color;
            ctx.lineWidth = n === hovered ? 2.5 : 1.8;
            ctx.stroke();
            ctx.restore();
          } else {
            ctx.fillStyle = n.type === "repo" ? n.color : "#1e3a5f";
            ctx.fill();
            ctx.strokeStyle = n.color;
            ctx.lineWidth = n === hovered ? 2.5 : 1;
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
        }

        // label
        const showLabel = k > 0.5 || n.type === "repo" || n.nodeKind === "pr" || n.nodeKind === "ci-failure";
        if (showLabel) {
          ctx.globalAlpha = highlighted ? 0.92 : 0.12;
          const isLargeNode = n.type === "repo" && !n.nodeKind;
          ctx.font = isLargeNode
            ? `bold ${Math.max(9, Math.round(10 / Math.sqrt(k)))}px monospace`
            : `${Math.max(7, Math.round(8 / Math.sqrt(k)))}px monospace`;
          ctx.fillStyle = "#e2e8f0";
          ctx.textAlign = "center";
          ctx.fillText(n.label, n.x, n.y + n.r + 12);
          ctx.globalAlpha = 1;
        }
      });

      ctx.restore();

      // tooltip
      if (hovered && tooltipRef.current) {
        const sx = (hovered.x * k) + w / 2 + tx;
        const sy = (hovered.y * k) + h / 2 + ty - hovered.r * k - 12;
        const tt = tooltipRef.current;
        tt.style.display = "block";
        tt.style.left = `${sx}px`;
        tt.style.top = `${sy}px`;

        if (hovered.nodeKind === "pr") {
          const title = hovered.prTitle ?? "";
          const truncTitle = title.length > 40 ? title.slice(0, 40) + "..." : title;
          const ageStr = hovered.ageHours != null ? (hovered.ageHours < 1 ? "<1h" : `${Math.round(hovered.ageHours)}h`) : "";
          tt.innerHTML = `<b>#${hovered.prNumber}</b> ${truncTitle}<br/>+${fmtK(hovered.commits)} changes · ${ageStr} old${hovered.draft ? " · Draft" : ""}`;
        } else if (hovered.nodeKind === "ci-failure") {
          tt.innerHTML = `<b>CI Failure</b><br/>${hovered.workflow ?? hovered.label}`;
        } else if (hovered.type === "repo" && !hovered.nodeKind) {
          tt.innerHTML = `<b>${hovered.label}</b><br/>${hovered.commits} commits · CI ${hovered.ciPassRate ?? 100}%<br/><span style="font-size:9px;color:#888">Click to explore</span>`;
        } else {
          const repoLinks = links.filter((l) => l.sourceId === hovered.id).length;
          tt.innerHTML = `<b>${hovered.label}</b><br/>${hovered.commits} commits · ${repoLinks} connection${repoLinks !== 1 ? "s" : ""}`;
        }
      } else if (tooltipRef.current) {
        tooltipRef.current.style.display = "none";
      }
    }

    // ── Loop ────────────────────────────────────────────────
    function loop() {
      tick();
      render();
      state.animId = requestAnimationFrame(loop);
    }
    state.animId = requestAnimationFrame(loop);

    // ── Mouse handlers ──────────────────────────────────────
    function onMouseMove(e: MouseEvent) {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      if (state.dragging && state.dragStart) {
        const { gx, gy } = toGraph(mx, my);
        state.dragging.fx = gx;
        state.dragging.fy = gy;
        return;
      }
      if (state.panning && state.panStart) {
        state.transform.x = state.panStart.tx + (mx - state.panStart.mx);
        state.transform.y = state.panStart.ty + (my - state.panStart.my);
        return;
      }

      const { gx, gy } = toGraph(mx, my);
      state.hovered = hitTest(gx, gy);
      const isClickable = state.hovered?.type === "repo" && !state.hovered?.nodeKind;
      canvas.style.cursor = state.hovered ? (isClickable ? "pointer" : "grab") : "default";
    }

    function onMouseDown(e: MouseEvent) {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const { gx, gy } = toGraph(mx, my);
      const hit = hitTest(gx, gy);

      if (hit) {
        state.dragging = hit;
        state.dragStart = { mx, my, ox: hit.x, oy: hit.y, t: Date.now() };
        hit.fx = hit.x;
        hit.fy = hit.y;
        canvas.style.cursor = "grabbing";
      } else {
        state.panning = true;
        state.panStart = { mx, my, tx: state.transform.x, ty: state.transform.y };
      }
    }

    function onMouseUp(e: MouseEvent) {
      if (state.dragging && state.dragStart) {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const dx = mx - state.dragStart.mx;
        const dy = my - state.dragStart.my;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const elapsed = Date.now() - state.dragStart.t;

        // click detection: short distance + short time
        if (dist < 5 && elapsed < 300 && state.onClick) {
          state.onClick(state.dragging);
        }

        state.dragging.fx = null;
        state.dragging.fy = null;
        state.dragging = null;
        state.dragStart = null;
      }
      state.panning = false;
      state.panStart = null;
      canvas.style.cursor = state.hovered ? "grab" : "default";
    }

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.92 : 1.08;
      state.transform.k = Math.max(0.2, Math.min(4, state.transform.k * factor));
    }

    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("mouseleave", onMouseUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      cancelAnimationFrame(state.animId);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("mouseleave", onMouseUp);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [graph, toGraph, hitTest, containerW, handleNodeClick, selectedRepo]);

  const repoData = selectedRepo ? repos.find((r) => r.repo === selectedRepo) : null;

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%", borderRadius: 10, overflow: "hidden", border: "1px solid var(--border, #2a2a2a)" }}>
      {/* Breadcrumb */}
      {selectedRepo && (
        <div style={{
          position: "absolute", top: 0, left: 0, right: 0, zIndex: 20,
          display: "flex", alignItems: "center", gap: 6, padding: "8px 14px",
          background: "rgba(6,6,16,0.92)", borderBottom: "1px solid #222",
          fontSize: 12, color: "#e2e8f0",
        }}>
          <span
            onClick={() => setSelectedRepo(null)}
            style={{ cursor: "pointer", color: "#60a5fa", fontWeight: 500 }}
          >{orgName ?? "org"}</span>
          <span style={{ color: "#555" }}>/</span>
          <span style={{ fontFamily: "monospace", fontWeight: 600 }}>{selectedRepo}</span>
          {repoData && (
            <span style={{ marginLeft: "auto", fontSize: 10, color: "#888" }}>
              {repoData.commitsThisWeek} commits · {repoData.openPRs} open PRs · CI{" "}
              <span style={{ color: ciColor(repoData.ciPassRate) }}>{repoData.ciPassRate}%</span>
            </span>
          )}
          <button
            onClick={() => setSelectedRepo(null)}
            style={{
              marginLeft: repoData ? 8 : "auto",
              padding: "2px 8px", borderRadius: 4, border: "1px solid #333",
              background: "transparent", color: "#888", cursor: "pointer", fontSize: 10,
            }}
          >Esc</button>
        </div>
      )}

      <canvas ref={canvasRef} style={{ display: "block" }} />
      <div
        ref={tooltipRef}
        style={{
          display: "none",
          position: "absolute",
          transform: "translate(-50%, -100%)",
          padding: "6px 10px",
          borderRadius: 6,
          background: "rgba(0,0,0,0.88)",
          border: "1px solid #333",
          color: "#e2e8f0",
          fontSize: 11,
          lineHeight: 1.4,
          pointerEvents: "none",
          whiteSpace: "nowrap",
          zIndex: 10,
        }}
      />
      {/* Legend */}
      <div style={{ position: "absolute", bottom: 10, left: 12, display: "flex", gap: 12, fontSize: 10, color: "#888", flexWrap: "wrap" }}>
        {!selectedRepo ? (
          <>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e", display: "inline-block" }} /> Healthy repo
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#eab308", display: "inline-block" }} /> Needs attention
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#ef4444", display: "inline-block" }} /> Failing
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#60a5fa", border: "1px solid #60a5fa", display: "inline-block" }} /> Contributor
            </span>
          </>
        ) : (
          <>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", border: "2px solid #22c55e", display: "inline-block" }} /> Fresh PR
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", border: "2px solid #eab308", display: "inline-block" }} /> Aging PR
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", border: "2px solid #ef4444", display: "inline-block" }} /> Stale PR
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 7, height: 7, background: "#ef4444", display: "inline-block", transform: "rotate(45deg)" }} /> CI failure
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#60a5fa", display: "inline-block" }} /> Contributor
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 12, borderTop: "1px dashed #818cf8", display: "inline-block" }} /> Review
            </span>
          </>
        )}
      </div>
      <div style={{ position: "absolute", bottom: 10, right: 12, fontSize: 9, color: "#555" }}>
        {selectedRepo ? "Esc to go back · " : "Click repo to explore · "}Drag · Scroll to zoom · Pan
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = {
  widget: { display: "flex", flexDirection: "column", gap: 12 } as CSSProperties,
  widgetHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } as CSSProperties,
  widgetTitle: { fontSize: 14, fontWeight: 600, margin: 0, display: "flex", alignItems: "center", gap: 6 } as CSSProperties,
  metricsGrid: { display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 } as CSSProperties,
  pageMetrics: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 } as CSSProperties,
  section: { marginTop: 20 } as CSSProperties,
  sectionTitle: { fontSize: 12, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.06em", color: "var(--muted-foreground, #888)", marginBottom: 10 } as CSSProperties,
  repoLabel: { fontSize: 11, color: "var(--muted-foreground, #888)", fontFamily: "monospace" } as CSSProperties,
  syncTime: { fontSize: 10, color: "var(--muted-foreground, #999)" } as CSSProperties,
  contributorRow: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", borderBottom: "1px solid var(--border, #2a2a2a)", fontSize: 13 } as CSSProperties,
  pending: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--muted-foreground, #888)", fontSize: 13 } as CSSProperties,
  errorBox: { padding: 12, borderRadius: 6, border: "1px solid var(--destructive, #e55)", color: "var(--destructive, #e55)", fontSize: 13 } as CSSProperties,
  page: { display: "flex", flexDirection: "column", gap: 16, maxWidth: 1200 } as CSSProperties,
  pageHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" } as CSSProperties,
  pageTitle: { fontSize: 20, fontWeight: 700, margin: 0, display: "flex", alignItems: "center", gap: 8 } as CSSProperties,
  twoCol: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 } as CSSProperties,
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: 13 } as CSSProperties,
  th: { textAlign: "left" as const, padding: "8px 10px", borderBottom: "2px solid var(--border, #2a2a2a)", fontSize: 10, fontWeight: 700, textTransform: "uppercase" as const, color: "var(--muted-foreground, #888)", letterSpacing: "0.06em" } as CSSProperties,
  td: { padding: "8px 10px", borderBottom: "1px solid var(--border, #2a2a2a)", verticalAlign: "top" as const } as CSSProperties,
  btn: { padding: "6px 14px", borderRadius: 6, border: "1px solid var(--border, #333)", background: "var(--card, #111)", color: "var(--foreground, #eee)", cursor: "pointer", fontSize: 12, fontWeight: 500 } as CSSProperties,
  btnPrimary: { padding: "6px 14px", borderRadius: 6, border: "none", background: "var(--primary, #3b82f6)", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 500 } as CSSProperties,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function fmtDuration(mins: number): string {
  if (mins < 60) return `${Math.round(mins)}m`;
  if (mins < 1440) return `${(mins / 60).toFixed(1)}h`;
  return `${(mins / 1440).toFixed(1)}d`;
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function ciColor(rate: number): string {
  if (rate >= 95) return "#22c55e";
  if (rate >= 80) return "#eab308";
  return "#ef4444";
}

// ---------------------------------------------------------------------------
// Dashboard Widget
// ---------------------------------------------------------------------------

export function GitHubKpiDashboardWidget({ context }: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<KpiSummaryResult>("kpi-summary", {
    companyId: context.companyId ?? "",
  });

  if (loading) return <div style={styles.pending}><Spinner label="Loading org velocity" /></div>;
  if (error) return <div style={styles.errorBox}>{error.message}</div>;
  if (!data || data.status === "pending" || !data.snapshot) {
    return <div style={styles.pending}><GithubIcon /><div style={{ fontSize: 11 }}>{data?.message ?? "Waiting for first sync…"}</div></div>;
  }

  const s = data.snapshot;

  return (
    <div style={styles.widget}>
      <div style={styles.widgetHeader}>
        <h3 style={styles.widgetTitle}><GithubIcon /> Org Velocity</h3>
        <span style={styles.repoLabel}>{s.org} · {s.repoCount} repos</span>
      </div>
      <div style={styles.metricsGrid}>
        <Metric label="Velocity" value={`${s.velocityMultiplier}x`} accent="#22c55e" detail="vs. baseline" />
        <Metric label="Cycle Time" value={fmtDuration(s.avgPRCycleMinutes)} detail="open → merge" />
        <Metric label="Commits (7d)" value={s.commitsThisWeek} detail={<SparkLine data={s.commitActivitySpark} height={22} />} />
        <Metric
          label="CI Pass Rate"
          value={s.cicd.totalRuns > 0 ? `${s.cicd.passRate}%` : "—"}
          accent={s.cicd.totalRuns > 0 ? ciColor(s.cicd.passRate) : undefined}
          detail={s.cicd.totalRuns > 0 ? `${s.cicd.totalRuns} runs · MTTR ${s.cicd.mttrMinutes}m` : "no runs"}
        />
      </div>
      <div style={styles.syncTime}>
        Synced {timeAgo(s.syncedAt)} · {s.repoCount} repos · {fmtK(s.linesChangedThisWeek)} lines · {s.deploysThisWeek} deploys
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full Page
// ---------------------------------------------------------------------------

export function GitHubKpiPage({ context }: PluginPageProps) {
  const { data, loading, error, refresh } = usePluginData<KpiSummaryResult>("kpi-summary", { companyId: context.companyId ?? "" });
  const { data: prList, loading: prLoading } = usePluginData<PRRow[]>("pr-list", { companyId: context.companyId ?? "" });
  const [syncing, setSyncing] = useState(false);
  const syncNow = usePluginAction("sync-now");

  async function handleSync() {
    setSyncing(true);
    try { await syncNow({ companyId: context.companyId ?? "" }); refresh(); } finally { setSyncing(false); }
  }

  if (loading) return <div style={styles.pending}><Spinner label="Loading org velocity" /></div>;
  if (error) return <div style={styles.errorBox}>{error.message}</div>;
  if (!data || data.status === "pending" || !data.snapshot) {
    return (
      <div style={styles.page}>
        <div style={styles.pageHeader}><h2 style={styles.pageTitle}><GithubIcon size={22} /> Org Velocity</h2></div>
        <div style={styles.pending}>
          <div>{data?.message ?? "No data yet."}</div>
          <button onClick={handleSync} disabled={syncing} style={styles.btnPrimary}>{syncing ? "Syncing…" : "Sync Now"}</button>
        </div>
      </div>
    );
  }

  const s = data.snapshot;
  const prs = prList ?? [];

  const weekLabels = s.commitActivitySpark.map((_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (s.commitActivitySpark.length - 1 - i) * 7);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  });

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.pageHeader}>
        <h2 style={styles.pageTitle}>
          <GithubIcon size={22} />
          Org Velocity — <span style={{ fontWeight: 400, fontFamily: "monospace" }}>{s.org}</span>
          <span style={{ fontSize: 12, fontWeight: 400, color: "#888", marginLeft: 8 }}>{s.repoCount} repos</span>
        </h2>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={styles.syncTime}>Synced {timeAgo(s.syncedAt)}</span>
          <button onClick={handleSync} disabled={syncing} style={styles.btn}>{syncing ? "Syncing…" : "Sync Now"}</button>
        </div>
      </div>

      {/* Hero metrics */}
      <div style={styles.pageMetrics}>
        <Metric label="Velocity Multiplier" value={`${s.velocityMultiplier}x`} accent="#22c55e" detail="vs. baseline" />
        <Metric label="PR Cycle Time" value={fmtDuration(s.avgPRCycleMinutes)} detail="open → merge (median)" />
        <Metric label="Throughput / Dev" value={`${s.throughputPerDev}`} detail="commits / contributor / wk" />
        <Metric label="Lines Changed (7d)" value={fmtK(s.linesChangedThisWeek)} />
        <Metric label="Commits (7d)" value={s.commitsThisWeek} detail={<SparkLine data={s.commitActivitySpark} height={22} />} />
        <Metric label="PRs Merged (7d)" value={s.mergedPRsThisWeek} />
        <Metric label="Issues Closed (7d)" value={s.closedIssuesThisWeek} detail={`avg resolve: ${s.avgIssueResolutionHours.toFixed(1)}h`} />
        <Metric label="Deploys (7d)" value={s.deploysThisWeek} />
      </div>

      {/* Ecosystem Graph */}
      <div>
        <h4 style={styles.sectionTitle}>Org Ecosystem Graph</h4>
        <ForceGraph repos={s.repos} contributors={s.topContributors} prs={prs} cicd={s.cicd} orgName={s.org} />
      </div>

      {/* Commit velocity */}
      <div>
        <h4 style={styles.sectionTitle}>Commit Velocity (Org Aggregate)</h4>
        <div style={{ ...card, padding: "20px 16px 12px" }}>
          <LineChart data={s.commitActivitySpark} labels={weekLabels} height={200} />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 10, color: "#888" }}>
            <span>Weekly across {s.repoCount} repos over {s.commitActivitySpark.length} weeks</span>
            <span>Latest: {s.commitActivitySpark[s.commitActivitySpark.length - 1] ?? 0} commits ({s.velocityMultiplier}x)</span>
          </div>
        </div>
      </div>

      {/* CI/CD Health */}
      {s.cicd.totalRuns > 0 && (
        <div style={styles.section}>
          <h4 style={styles.sectionTitle}>CI/CD Pipeline Health (Org-wide)</h4>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 16 }}>
            <Metric label="Build Pass Rate" value={`${s.cicd.passRate}%`} accent={ciColor(s.cicd.passRate)} detail={`${s.cicd.passed} / ${s.cicd.totalRuns} runs`} />
            <Metric label="Total Runs (7d)" value={s.cicd.totalRuns} detail={`${s.cicd.failed} failed · ${s.cicd.cancelled} cancelled`} />
            <Metric label="Avg Duration" value={fmtDuration(s.cicd.avgDurationMinutes)} detail="pipeline run time" />
            <Metric label="MTTR" value={s.cicd.mttrMinutes > 0 ? fmtDuration(s.cicd.mttrMinutes) : "—"} detail="mean time to recovery" accent={s.cicd.mttrMinutes > 0 && s.cicd.mttrMinutes <= 30 ? "#22c55e" : undefined} />
          </div>

          <div style={{ ...card, padding: 16, marginBottom: 16 }}>
            <RatioBar a={s.cicd.passed} b={s.cicd.failed + s.cicd.cancelled} colorA="#22c55e" colorB="#ef4444" labelA="Passed" labelB="Failed/Cancelled" />
          </div>

          <div style={styles.twoCol}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#888", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>Failing Workflows</div>
              <div style={{ ...card, padding: "6px 12px" }}>
                {s.cicd.failuresByWorkflow.length === 0 ? (
                  <div style={{ color: "#22c55e", fontSize: 13, padding: 8 }}>All green</div>
                ) : (
                  s.cicd.failuresByWorkflow.map((w) => (
                    <div key={`${w.repo}::${w.name}`} style={{ ...styles.contributorRow, gap: 8 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 500 }}>{w.name}</div>
                        <div style={{ fontSize: 10, color: "#666", fontFamily: "monospace" }}>{w.repo}</div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <span style={{ color: "#ef4444", fontFamily: "monospace", fontSize: 12 }}>{w.failures}F</span>
                        <span style={{ color: "#666", fontSize: 10, marginLeft: 4 }}>/ {w.total} ({w.passRate}%)</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#888", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>Build Breakers</div>
              <div style={{ ...card, padding: "6px 12px" }}>
                {s.cicd.failuresByAuthor.length === 0 ? (
                  <div style={{ color: "#22c55e", fontSize: 13, padding: 8 }}>No failures</div>
                ) : (
                  s.cicd.failuresByAuthor.map((a) => (
                    <div key={a.login} style={styles.contributorRow}>
                      <span>{a.login}</span>
                      <span style={{ fontFamily: "monospace", fontSize: 12, color: "#ef4444" }}>{a.failures} failures</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {s.cicd.recentFailures.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#888", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>Recent Failures</div>
              <div style={{ overflowX: "auto" }}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Repo</th>
                      <th style={styles.th}>Workflow</th>
                      <th style={styles.th}>Branch</th>
                      <th style={styles.th}>Triggered By</th>
                      <th style={styles.th}>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.cicd.recentFailures.map((f, i) => (
                      <tr key={i}>
                        <td style={styles.td}><span style={{ fontFamily: "monospace", fontSize: 11, color: "#888" }}>{f.repo}</span></td>
                        <td style={styles.td}>{f.workflow}</td>
                        <td style={styles.td}><span style={{ fontFamily: "monospace", fontSize: 11 }}>{f.branch}</span></td>
                        <td style={styles.td}>{f.actor}</td>
                        <td style={styles.td}><span style={{ fontSize: 11, color: "#888" }}>{timeAgo(f.createdAt)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Per-repo breakdown */}
      <div style={styles.section}>
        <h4 style={styles.sectionTitle}>Per-Repository Breakdown</h4>
        <div style={{ overflowX: "auto" }}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Repository</th>
                <th style={{ ...styles.th, textAlign: "right" }}>Commits</th>
                <th style={{ ...styles.th, textAlign: "right" }}>Lines</th>
                <th style={{ ...styles.th, textAlign: "right" }}>PRs Merged</th>
                <th style={{ ...styles.th, textAlign: "right" }}>Open PRs</th>
                <th style={{ ...styles.th, textAlign: "right" }}>Cycle</th>
                <th style={{ ...styles.th, textAlign: "right" }}>Issues</th>
                <th style={{ ...styles.th, textAlign: "right" }}>Deploys</th>
                <th style={{ ...styles.th, textAlign: "right" }}>CI</th>
              </tr>
            </thead>
            <tbody>
              {s.repos.map((r) => (
                <tr key={r.repo}>
                  <td style={styles.td}><span style={{ fontFamily: "monospace", fontWeight: 500 }}>{r.repo}</span></td>
                  <td style={{ ...styles.td, textAlign: "right", fontFamily: "monospace" }}>{r.commitsThisWeek}</td>
                  <td style={{ ...styles.td, textAlign: "right", fontFamily: "monospace" }}>{fmtK(r.linesChanged)}</td>
                  <td style={{ ...styles.td, textAlign: "right", fontFamily: "monospace" }}>{r.mergedPRsThisWeek}</td>
                  <td style={{ ...styles.td, textAlign: "right", fontFamily: "monospace" }}>{r.openPRs}</td>
                  <td style={{ ...styles.td, textAlign: "right", fontFamily: "monospace" }}>{r.avgPRCycleMinutes > 0 ? fmtDuration(r.avgPRCycleMinutes) : "—"}</td>
                  <td style={{ ...styles.td, textAlign: "right", fontFamily: "monospace" }}>
                    <span style={{ color: "#888" }}>{r.openIssues}</span>
                    {r.closedIssuesThisWeek > 0 && <span style={{ color: "#22c55e", marginLeft: 4 }}>+{r.closedIssuesThisWeek}</span>}
                  </td>
                  <td style={{ ...styles.td, textAlign: "right", fontFamily: "monospace" }}>{r.deploysThisWeek}</td>
                  <td style={{ ...styles.td, textAlign: "right", fontFamily: "monospace" }}>
                    {r.ciRuns > 0 ? <span style={{ color: ciColor(r.ciPassRate) }}>{r.ciPassRate}%</span> : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Contributors — single unified list */}
      <div>
        <h4 style={styles.sectionTitle}>Top Contributors (30d)</h4>
        <div style={{ ...card, padding: "8px 14px", maxWidth: 480 }}>
          {s.topContributors.length === 0 ? (
            <div style={{ color: "#888", fontSize: 13, padding: 8 }}>No recent contributors</div>
          ) : (
            s.topContributors.map((c) => (
              <div key={c.login} style={styles.contributorRow}>
                <span>{c.login}</span>
                <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--muted-foreground, #aaa)" }}>{c.commits}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Open PRs table */}
      <div style={styles.section}>
        <h4 style={styles.sectionTitle}>Open Pull Requests (Org-wide)</h4>
        {prLoading ? <Spinner label="Loading PRs" /> : prs.length === 0 ? (
          <div style={{ ...card, textAlign: "center", padding: 24, color: "#888" }}>No open pull requests</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Repo</th>
                  <th style={styles.th}>#</th>
                  <th style={styles.th}>Title</th>
                  <th style={styles.th}>Author</th>
                  <th style={styles.th}>Age</th>
                  <th style={styles.th}>Changes</th>
                  <th style={styles.th}>Reviewers</th>
                </tr>
              </thead>
              <tbody>
                {prs.map((pr) => (
                  <tr key={`${pr.repo}-${pr.number}`}>
                    <td style={styles.td}><span style={{ fontFamily: "monospace", fontSize: 11, color: "#888" }}>{pr.repo}</span></td>
                    <td style={styles.td}><span style={{ fontFamily: "monospace" }}>{pr.number}</span></td>
                    <td style={styles.td}>
                      {pr.draft && <Badge color="#555">Draft</Badge>}
                      {" "}{pr.title}
                    </td>
                    <td style={styles.td}>{pr.author}</td>
                    <td style={styles.td}>{fmtDuration(pr.ageHours * 60)}</td>
                    <td style={styles.td}>
                      <span style={{ color: "#22c55e" }}>+{fmtK(pr.additions)}</span>
                      {" / "}
                      <span style={{ color: "#ef4444" }}>-{fmtK(pr.deletions)}</span>
                    </td>
                    <td style={styles.td}>
                      {pr.reviewers.length > 0 ? pr.reviewers.join(", ") : <span style={{ color: "#666" }}>none</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar Link
// ---------------------------------------------------------------------------

export function GitHubKpiSidebarLink({ context }: PluginSidebarProps) {
  const href = context.companyPrefix ? `/${context.companyPrefix}/github-kpi` : "/github-kpi";
  const isActive = typeof window !== "undefined" && window.location.pathname === href;
  return (
    <a
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={[
        "flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors",
        isActive
          ? "bg-accent text-foreground"
          : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
      ].join(" ")}
    >
      <span className="relative shrink-0">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
        </svg>
      </span>
      <span className="flex-1 truncate">GitHub KPIs</span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function GithubIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}
