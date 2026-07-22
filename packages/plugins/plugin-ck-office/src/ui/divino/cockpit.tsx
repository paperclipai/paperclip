import { useEffect, useMemo, useState } from "react";
import {
  usePluginData,
  usePluginAction,
  usePluginToast,
  DataTable,
  StatusBadge,
  MetricCard,
  Spinner,
  type PluginPageProps,
  type DataTableColumn,
  type StatusBadgeVariant,
} from "@paperclipai/plugin-sdk/ui";

// ── Types mirroring divino-ops /status and /listings ────────────────────────────
interface PlatformRow {
  channel: string;
  label: string;
  live: number;
  deleted: number;
  unlisted: number;
  total: number;
  last_posted: string | null;
  last_checked: string | null;
  blocked: boolean;
  rules?: { daily_post_cap?: number | null; edit_per_day?: number | null; notes?: string; profile_url?: string };
  refresh_today?: number;
  refresh_cap?: number;
  post_today?: number;
  post_cap?: number;
  can_post?: boolean;
}
interface Job {
  id: string;
  kind: string;
  channel: string | null;
  dry_run: boolean;
  status: "running" | "done" | "failed";
  exit_code: number | null;
  started_at: string;
  ended_at: string | null;
  cmd: string;
  tail: string;
}
interface Persona {
  name: string;
  email: string;
  provider: string;
  status: string;
  recovery: string;
}
interface Alert {
  level: "error" | "warn" | "info";
  text: string;
}
interface Status {
  generated_at: string;
  totals: { live: number; deleted: number; entries: number; platforms_with_live: number };
  last_post: string | null;
  last_check: string | null;
  browser_up: boolean;
  stale_count: number;
  platforms: PlatformRow[];
  personas: Persona[];
  catalog_size: number;
}
interface Listing {
  product: string;
  product_name: string;
  channel: string;
  status: string;
  health: string;
  price_chf: string;
  listing_id: string | null;
  url: string | null;
  posted_at: string | null;
  last_checked: string | null;
  category: string;
  image_url?: string;
  stale: boolean;
}

// Small product thumbnail (public webshop image); hides itself if the image fails to load.
function Thumb({ url, size = 40 }: { url?: string; size?: number }) {
  if (!url) return <div style={{ width: size, height: size, borderRadius: 6, background: "#f1f5f9", flex: "none" }} />;
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      style={{ width: size, height: size, objectFit: "cover", borderRadius: 6, background: "#f1f5f9", flex: "none" }}
      onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }}
    />
  );
}

// ── Styles (mobile-first: single column, tables scroll inside their own box) ─────
const page: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 14, padding: 16 };
const headRow: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" };
const tabsRow: React.CSSProperties = { display: "flex", gap: 6, flexWrap: "wrap" };
const cardsRow: React.CSSProperties = { display: "flex", gap: 12, flexWrap: "wrap" };
const gridRow: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 12 };
const scrollBox: React.CSSProperties = { width: "100%", overflowX: "auto" };
const muted: React.CSSProperties = { opacity: 0.65, fontSize: 13 };

function tabBtn(active: boolean): React.CSSProperties {
  return {
    padding: "6px 12px", borderRadius: 8, border: "1px solid #e2e8f0",
    background: active ? "#6366f1" : "#ffffff", color: active ? "#ffffff" : "#0f172a",
    cursor: "pointer", fontSize: 13, fontWeight: 600,
  };
}
function healthVariant(h: string): StatusBadgeVariant {
  if (h === "live") return "ok";
  if (h === "deleted") return "error";
  if (h === "unlisted") return "info";
  return "warning";
}
function alertColor(level: string): string {
  return level === "error" ? "#dc2626" : level === "warn" ? "#d97706" : "#0369a1";
}
function alertBg(level: string): string {
  return level === "error" ? "#fef2f2" : level === "warn" ? "#fffbeb" : "#f0f9ff";
}
function fmtDate(s: string | null): string {
  if (!s) return "—";
  // Always show Swiss wall-clock (Europe/Zurich), regardless of the viewer's
  // device timezone — this is a Swiss operation. Date-only strings pass through.
  return s.length > 10 ? new Date(s).toLocaleString("de-CH", { timeZone: "Europe/Zurich" }) : s;
}

// ── Cockpit tab ─────────────────────────────────────────────────────────────────
function Cockpit({ status }: { status: Status }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={cardsRow}>
        <MetricCard label="Listings live" value={status.totals.live} />
        <MetricCard label="Platforms live" value={status.totals.platforms_with_live} />
        <MetricCard label="Removed by platforms" value={status.totals.deleted} />
        <MetricCard label="Stale (>14d)" value={status.stale_count} />
        <MetricCard label="Catalog SKUs" value={status.catalog_size} />
      </div>

      <div style={cardsRow}>
        <StatusBadge label={status.browser_up ? "Stealth browser UP" : "Stealth browser DOWN"} status={status.browser_up ? "ok" : "error"} />
        <StatusBadge label={`Last post ${fmtDate(status.last_post)}`} status="info" />
        <StatusBadge label={`Last health-check ${fmtDate(status.last_check)}`} status="info" />
      </div>

      {status.personas?.length ? (
        <div style={muted}>
          Persona: {status.personas.map((p) => `${p.name.replace(/^Persona\s*\d+\s*[—-]\s*/, "")} (${p.email})`).join(" · ")}
        </div>
      ) : null}

      {status.platforms.some((p) => p.blocked || p.deleted > 0) || !status.browser_up || status.stale_count > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <h3 style={{ margin: "4px 0 0", fontSize: 14 }}>Alerts</h3>
          {(buildAlerts(status)).map((a, i) => (
            <div key={i} style={{ background: alertBg(a.level), border: `1px solid ${alertColor(a.level)}33`, color: alertColor(a.level), padding: "8px 10px", borderRadius: 8, fontSize: 13 }}>
              {a.text}
            </div>
          ))}
        </div>
      ) : null}

      <h3 style={{ margin: "6px 0 0", fontSize: 14 }}>Platform coverage</h3>
      <div style={gridRow}>
        {status.platforms.map((p) => (
          <PlatformCard key={p.channel} p={p} />
        ))}
      </div>
    </div>
  );
}

// The bridge already emits alerts, but /status shapes them differently across versions; rebuild
// a stable client view so the cockpit never depends on server alert wording.
function buildAlerts(status: Status): Alert[] {
  const out: Alert[] = [];
  if (!status.browser_up) out.push({ level: "error", text: "Stealth browser DOWN — Camofox not responding on :9377. Posting/refresh/health-check will fail until it recovers." });
  for (const p of status.platforms) {
    if (p.deleted > 0 && p.deleted >= p.live && p.deleted > 1) {
      out.push({ level: "warn", text: `${p.label}: ${p.deleted} listings removed by the platform (${p.live} still live).` });
    }
    if (p.blocked && p.total === 0) {
      out.push({ level: "info", text: `${p.label}: 0 listings — ${p.rules?.notes ?? "blocked"}` });
    }
    if (p.blocked && p.unlisted > 0 && p.live === 0) {
      out.push({ level: "info", text: `${p.label}: ${p.unlisted} prepared but unlisted — ${p.rules?.notes ?? "blocked"}` });
    }
  }
  if (status.stale_count > 0) out.push({ level: "warn", text: `${status.stale_count} live listings not health-checked in >14 days.` });
  return out;
}

function PlatformCard({ p }: { p: PlatformRow }) {
  const pct = p.total ? Math.round((p.live / p.total) * 100) : 0;
  const healthColor = p.blocked ? "#94a3b8" : p.live === 0 ? "#dc2626" : p.deleted >= p.live && p.deleted > 1 ? "#d97706" : "#16a34a";
  return (
    <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 6, background: "#ffffff" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ fontSize: 14, color: "#0f172a" }}>{p.label}</strong>
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: healthColor, display: "inline-block" }} />
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: "#0f172a" }}>
        {p.live}<span style={{ fontSize: 13, fontWeight: 400, opacity: 0.6 }}> / {p.total} live</span>
      </div>
      <div style={{ height: 5, background: "#f1f5f9", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: healthColor }} />
      </div>
      <div style={{ fontSize: 11, ...muted }}>
        {p.deleted > 0 ? `${p.deleted} removed · ` : ""}{p.unlisted > 0 ? `${p.unlisted} unlisted · ` : ""}checked {fmtDate(p.last_checked)}
      </div>
      {p.blocked ? <StatusBadge label="BLOCKED" status="error" /> : null}
      {p.rules?.notes ? <div style={{ fontSize: 11, ...muted }}>{p.rules.notes}</div> : null}
    </div>
  );
}

// ── Listings tab ────────────────────────────────────────────────────────────────
const listingColumns: DataTableColumn<Listing>[] = [
  { key: "image_url", header: "", width: "48px", render: (v) => <Thumb url={v as string | undefined} size={38} /> },
  { key: "product_name", header: "Product", width: "18%" },
  { key: "channel", header: "Platform", render: (v) => <StatusBadge label={String(v)} status="pending" /> },
  { key: "category", header: "Category", render: (v) => <span style={{ fontSize: 12, opacity: 0.8 }}>{String(v)}</span> },
  { key: "status", header: "Status", render: (v) => <StatusBadge label={String(v)} status={healthVariant(String(v))} /> },
  { key: "price_chf", header: "CHF", render: (v) => (v ? <span>{String(v)}.–</span> : <span style={{ opacity: 0.4 }}>—</span>) },
  { key: "posted_at", header: "Posted" },
  { key: "last_checked", header: "Checked", render: (v) => <span>{fmtDate(v as string | null)}</span> },
  {
    key: "url", header: "Ad",
    render: (v) => (v ? <a href={String(v)} target="_blank" rel="noreferrer" style={{ color: "#6366f1" }}>open ↗</a> : <span style={{ opacity: 0.4 }}>—</span>),
  },
];

const CHANNELS = ["", "tutti", "anibis", "inseriere", "locanto", "fundort", "ricardo"];
const STATUSES = ["", "live", "deleted", "unlisted"];
const CATEGORIES = ["", "cigar", "accessory", "gift-set", "spirit", "other"];

function selStyle(): React.CSSProperties {
  return { padding: "5px 8px", borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12, background: "#fff" };
}

function Listings() {
  const [channel, setChannel] = useState("");
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [staleOnly, setStaleOnly] = useState(false);
  const params = useMemo(
    () => ({ channel, status, category, ...(staleOnly ? { stale: "1" } : {}) }),
    [channel, status, category, staleOnly],
  );
  const { data, loading } = usePluginData<{ listings: Listing[] }>("ck-divino-listings", params);
  const rows = data?.listings ?? [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select style={selStyle()} value={channel} onChange={(e) => setChannel(e.target.value)}>
          {CHANNELS.map((c) => <option key={c} value={c}>{c || "all platforms"}</option>)}
        </select>
        <select style={selStyle()} value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => <option key={s} value={s}>{s || "all statuses"}</option>)}
        </select>
        <select style={selStyle()} value={category} onChange={(e) => setCategory(e.target.value)}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c || "all categories"}</option>)}
        </select>
        <label style={{ fontSize: 12, display: "flex", gap: 4, alignItems: "center" }}>
          <input type="checkbox" checked={staleOnly} onChange={(e) => setStaleOnly(e.target.checked)} /> stale &gt;14d
        </label>
        <span style={muted}>{rows.length} listings</span>
      </div>
      <div style={scrollBox}>
        <DataTable
          columns={listingColumns as unknown as DataTableColumn[]}
          rows={rows as unknown as Record<string, unknown>[]}
          loading={loading}
          emptyMessage="No listings match these filters."
        />
      </div>
    </div>
  );
}

// ── Platforms tab (rules + blockers, legible operating model) ────────────────────
function Platforms({ status }: { status: Status }) {
  return (
    <div style={gridRow}>
      {status.platforms.map((p) => (
        <div key={p.channel} style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 14, display: "flex", flexDirection: "column", gap: 8, background: "#fff" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong style={{ fontSize: 15 }}>{p.label}</strong>
            {p.blocked ? <StatusBadge label="BLOCKED" status="error" /> : <StatusBadge label={`${p.live} live`} status={p.live ? "ok" : "warning"} />}
          </div>
          <div style={muted}>live {p.live} · removed {p.deleted} · unlisted {p.unlisted} · total {p.total}</div>
          <div style={{ fontSize: 12 }}>
            <div>Daily post cap: {p.rules?.daily_post_cap ?? "—"}</div>
            <div>Edits/day: {p.rules?.edit_per_day ?? "—"}</div>
          </div>
          {p.rules?.notes ? <div style={{ fontSize: 12, ...muted }}>{p.rules.notes}</div> : null}
          <div style={{ fontSize: 11, ...muted }}>last post {fmtDate(p.last_posted)} · last check {fmtDate(p.last_checked)}</div>
          {p.rules?.profile_url ? (
            <a href={p.rules.profile_url} target="_blank" rel="noreferrer"
               style={{ marginTop: 4, alignSelf: "flex-start", ...miniBtn(false), textDecoration: "none", display: "inline-block" }}>
              Open my {p.label} profile ↗
            </a>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// ── Products tab (footprint per SKU, derived client-side from listings) ───────────
function Products() {
  const { data, loading } = usePluginData<{ listings: Listing[] }>("ck-divino-listings", {});
  const products = useMemo(() => {
    const map = new Map<string, { name: string; category: string; price: string; image?: string; live: string[]; dead: string[] }>();
    for (const l of data?.listings ?? []) {
      const key = l.product || l.product_name;
      if (!map.has(key)) map.set(key, { name: l.product_name || key, category: l.category, price: l.price_chf, image: l.image_url, live: [], dead: [] });
      const rec = map.get(key)!;
      if (!rec.image && l.image_url) rec.image = l.image_url;
      if (l.status === "live") rec.live.push(l.channel);
      else if (l.status === "deleted") rec.dead.push(l.channel);
    }
    return [...map.values()].sort((a, b) => b.live.length - a.live.length || a.name.localeCompare(b.name));
  }, [data]);
  if (loading && !data) return <Spinner />;
  return (
    <div style={gridRow}>
      {products.map((p) => (
        <div key={p.name} style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 14, display: "flex", flexDirection: "column", gap: 6, background: "#fff" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Thumb url={p.image} size={48} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                <strong style={{ fontSize: 14 }}>{p.name}</strong>
                <span style={{ fontSize: 12, opacity: 0.7 }}>{p.price ? `CHF ${p.price}` : ""}</span>
              </div>
              <StatusBadge label={p.category} status="pending" />
            </div>
          </div>
          <div style={{ fontSize: 12 }}>
            <span style={{ color: "#16a34a" }}>live: {p.live.length ? p.live.join(", ") : "none"}</span>
          </div>
          {p.dead.length ? <div style={{ fontSize: 12, color: "#dc2626" }}>removed: {p.dead.join(", ")}</div> : null}
        </div>
      ))}
    </div>
  );
}

// ── Webshop tab (keep the live shop/admin window) ────────────────────────────────
function Webshop() {
  const host = typeof window !== "undefined" ? window.location.hostname : "localhost";
  const base = `http://${host}:3000`;
  const [view, setView] = useState("");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={tabsRow}>
        <button style={tabBtn(view === "")} onClick={() => setView("")}>Shop</button>
        <button style={tabBtn(view === "admin")} onClick={() => setView("admin")}>Admin</button>
        <a href={`${base}/${view}`} target="_blank" rel="noreferrer" style={{ ...muted, alignSelf: "center", color: "#6366f1" }}>open ↗</a>
      </div>
      <iframe key={view} src={`${base}/${view}`} title={`Divino ${view || "shop"}`} style={{ border: "1px solid #e2e8f0", width: "100%", height: "calc(100vh - 220px)", borderRadius: 8, background: "#fff" }} />
    </div>
  );
}

// ── Control room (trigger machine tools; live run log; rate-limit meters) ─────────
function jobVariant(s: string): StatusBadgeVariant {
  return s === "running" ? "pending" : s === "done" ? "ok" : "error";
}

function ControlRoom({ status, onActed }: { status: Status; onActed: () => void }) {
  const run = usePluginAction("ck-divino-run");
  const toast = usePluginToast();
  const { data: jobsData, loading, refresh } = usePluginData<{ jobs: Job[] }>("ck-divino-jobs");
  const [dryRun, setDryRun] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const jobs = jobsData?.jobs ?? [];
  const anyRunning = jobs.some((j) => j.status === "running");

  // Poll the run log while a job is in flight (and briefly after triggering).
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => refresh(), 3500);
    return () => clearInterval(t);
  }, [anyRunning, refresh]);

  async function trigger(kind: string, channel: string | null, opts?: { outward?: boolean }) {
    if (opts?.outward && !dryRun) {
      const ok = typeof window !== "undefined" &&
        window.confirm(`Publish new listing(s) to ${channel}? This posts REAL ads to the marketplace.`);
      if (!ok) return;
    }
    const label = `${kind}${channel ? ":" + channel : ""}`;
    setBusy(label);
    try {
      await run({ kind, channel, dry_run: dryRun });
      toast({ title: `Started ${label}${dryRun ? " (dry-run)" : ""}`, tone: "success" });
      setTimeout(() => refresh(), 800);
      onActed();
    } catch (e) {
      toast({ title: "Action failed", body: (e as Error).message, tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  const platforms = status.platforms.filter((p) => p.can_post || p.channel === "ricardo");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button style={{ ...tabBtn(false), opacity: busy ? 0.6 : 1 }} disabled={!!busy} onClick={() => trigger("health-check", null)}>
          ✔ Health-check all
        </button>
        <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          dry-run (fill forms, never publish)
        </label>
        {!status.browser_up ? <StatusBadge label="browser down — actions will try to recover it" status="warning" /> : null}
      </div>

      <div style={gridRow}>
        {platforms.map((p) => {
          const rt = p.refresh_today ?? 0, rc = p.refresh_cap ?? 0;
          const pt = p.post_today ?? 0, pc = p.post_cap ?? 0;
          const refreshMaxed = !dryRun && rc > 0 && rt >= rc;
          const postMaxed = !dryRun && pc > 0 && pt >= pc;
          return (
            <div key={p.channel} style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8, background: "#fff" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong style={{ fontSize: 14 }}>{p.label}</strong>
                {p.blocked ? <StatusBadge label="BLOCKED" status="error" /> : <span style={muted}>{p.live} live</span>}
              </div>
              <div style={{ fontSize: 11, ...muted }}>refresh {rt}/{rc} today · posts {pt}/{pc} today</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button style={miniBtn(false)} disabled={!!busy} onClick={() => trigger("health-check", p.channel)}>Health-check</button>
                <button style={miniBtn(refreshMaxed)} disabled={!!busy || refreshMaxed} onClick={() => trigger("refresh", p.channel)}>Refresh</button>
                {p.can_post ? (
                  <button style={miniBtn(postMaxed, true)} disabled={!!busy || postMaxed} onClick={() => trigger("post-next", p.channel, { outward: true })}>Post next</button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: "6px 0 0", fontSize: 14 }}>Run log {anyRunning ? "· running…" : ""}</h3>
        <button style={miniBtn(false)} onClick={() => refresh()}>↻</button>
      </div>
      {loading && !jobs.length ? <Spinner /> : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {jobs.map((j) => (
          <div key={j.id} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 10, background: "#fff" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <StatusBadge label={j.status} status={jobVariant(j.status)} />
              <strong style={{ fontSize: 13 }}>{j.kind}{j.channel ? ` · ${j.channel}` : ""}</strong>
              {j.dry_run ? <StatusBadge label="dry-run" status="info" /> : null}
              {j.exit_code != null ? <span style={muted}>rc {j.exit_code}</span> : null}
              <span style={{ ...muted, marginLeft: "auto" }}>{fmtDate(j.started_at)}</span>
            </div>
            {j.tail ? (
              <pre style={{ margin: "8px 0 0", fontSize: 11, background: "#0f172a", color: "#cbd5e1", padding: 8, borderRadius: 6, overflowX: "auto", whiteSpace: "pre-wrap" }}>{j.tail.trim()}</pre>
            ) : null}
          </div>
        ))}
        {!jobs.length && !loading ? <div style={muted}>No runs yet. Trigger a health-check or refresh above.</div> : null}
      </div>
    </div>
  );
}

function miniBtn(disabled: boolean, outward = false): React.CSSProperties {
  return {
    padding: "5px 10px", borderRadius: 8, border: "1px solid " + (outward ? "#f59e0b" : "#e2e8f0"),
    background: disabled ? "#f1f5f9" : outward ? "#fffbeb" : "#ffffff",
    color: disabled ? "#94a3b8" : "#0f172a", cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 12, fontWeight: 600,
  };
}

// ── Ask Divino (chat with the warm agent via its gateway api_server) ──────────────
interface ChatMsg { role: "user" | "assistant" | "error"; text: string }

function AskDivino() {
  const ask = usePluginAction("ck-divino-ask");
  const [sid] = useState(() => `cockpit-${Math.floor(Date.now() % 1e9)}`);
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setMsgs((m) => [...m, { role: "user", text }]);
    setBusy(true);
    try {
      const res = (await ask({ message: text, session_id: sid })) as { reply?: string };
      setMsgs((m) => [...m, { role: "assistant", text: res?.reply || "(no reply)" }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "error", text: (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, height: "calc(100vh - 230px)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, ...muted }}>
          Chatting with the live Divino agent — the same one on your Telegram. It can act (post, reply, email) when you ask.
        </div>
        <a href="https://t.me/Divino_cigars_bot" target="_blank" rel="noreferrer" style={{ ...miniBtn(false), textDecoration: "none", display: "inline-block", flex: "none" }}>
          Open in Telegram ↗
        </a>
      </div>
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, padding: 4, border: "1px solid #e2e8f0", borderRadius: 10, background: "#fafafa" }}>
        {msgs.length === 0 ? (
          <div style={{ ...muted, padding: 12 }}>
            Ask Divino anything — e.g. “why did Locanto remove our listings?”, “what should we repost first?”, or “post the next Anibis listing”.
          </div>
        ) : null}
        {msgs.map((m, i) => (
          <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
            <div style={{
              maxWidth: "80%", padding: "8px 12px", borderRadius: 12, fontSize: 13, whiteSpace: "pre-wrap",
              background: m.role === "user" ? "#6366f1" : m.role === "error" ? "#fef2f2" : "#ffffff",
              color: m.role === "user" ? "#ffffff" : m.role === "error" ? "#dc2626" : "#0f172a",
              border: m.role === "assistant" ? "1px solid #e2e8f0" : "none",
            }}>
              {m.text}
            </div>
          </div>
        ))}
        {busy ? <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "4px 12px" }}><Spinner /><span style={muted}>Divino is thinking…</span></div> : null}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          style={{ flex: 1, padding: "9px 12px", borderRadius: 10, border: "1px solid #e2e8f0", fontSize: 13 }}
          placeholder="Message Divino…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          disabled={busy}
        />
        <button style={{ ...tabBtn(true), opacity: busy || !input.trim() ? 0.5 : 1 }} disabled={busy || !input.trim()} onClick={send}>Send</button>
      </div>
    </div>
  );
}

// ── Money (webshop revenue tied to the marketplace effort) ───────────────────────
interface MoneyData {
  connected: boolean;
  reason?: string;
  admin_url?: string;
  currency?: string;
  ordersMonth?: number;
  revenueMonth?: number;
  orders7d?: number;
  revenue7d?: number;
  ordersTotal?: number;
  revenueTotal?: number;
  yourMargin?: number;
  marginPct?: number;
  topProducts?: { name: string; qty: number; rev: number }[];
}

function Money() {
  const { data, loading } = usePluginData<MoneyData>("ck-divino-money");
  if (loading && !data) return <Spinner />;
  if (!data) return null;
  const cur = data.currency || "CHF";
  if (!data.connected) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ background: alertBg("info"), border: `1px solid ${alertColor("info")}33`, color: alertColor("info"), padding: 14, borderRadius: 10, fontSize: 13 }}>
          <strong>Webshop revenue not connected yet.</strong>
          <div style={{ marginTop: 6, opacity: 0.9 }}>{data.reason}</div>
          <div style={{ marginTop: 8, opacity: 0.8 }}>
            Once the webshop deploys the summary endpoint and divino-ops has the admin key, live orders/revenue show here —
            so you can see whether marketplace listings are turning into paid orders.
          </div>
        </div>
        {data.admin_url ? <a href={data.admin_url} target="_blank" rel="noreferrer" style={{ color: "#6366f1", fontSize: 13 }}>Open the webshop admin ↗</a> : null}
      </div>
    );
  }
  const m = (n?: number) => `${cur} ${(n ?? 0).toLocaleString()}`;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={cardsRow}>
        <MetricCard label="Orders this month" value={data.ordersMonth ?? 0} />
        <MetricCard label="Revenue this month" value={m(data.revenueMonth)} />
        <MetricCard label="Last 7 days" value={m(data.revenue7d)} />
        <MetricCard label="Your margin (all time)" value={m(data.yourMargin)} />
        <MetricCard label="Paid orders (all time)" value={data.ordersTotal ?? 0} />
      </div>
      <h3 style={{ margin: "6px 0 0", fontSize: 14 }}>Top products (paid)</h3>
      {data.topProducts?.length ? (
        <div style={gridRow}>
          {data.topProducts.map((p) => (
            <div key={p.name} style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 12, background: "#fff" }}>
              <strong style={{ fontSize: 13 }}>{p.name}</strong>
              <div style={muted}>{p.qty} sold · {cur} {p.rev.toLocaleString()}</div>
            </div>
          ))}
        </div>
      ) : <div style={muted}>No paid sales yet.</div>}
      {data.admin_url ? <a href={data.admin_url} target="_blank" rel="noreferrer" style={{ color: "#6366f1", fontSize: 13 }}>Open the webshop admin ↗</a> : null}
    </div>
  );
}

// ── Access & health (persona / browser / exit node / blocked platforms / vault) ──
interface AccessData {
  personas: Persona[];
  browser_up: boolean;
  api_server_up: boolean;
  exit_node: { device: string | null; egress_ip: string | null };
  tailnet: { ip: string; host: string; exit_node: boolean }[];
  blocked: { channel: string; label: string; notes: string; unlisted: number }[];
}

function Access() {
  const { data, loading } = usePluginData<AccessData>("ck-divino-access");
  if (loading && !data) return <Spinner />;
  if (!data) return null;
  const cleanName = (n: string) => n.replace(/^Persona\s*\d+\s*[—-]\s*/, "");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={cardsRow}>
        <StatusBadge label={data.browser_up ? "Stealth browser UP" : "Stealth browser DOWN"} status={data.browser_up ? "ok" : "error"} />
        <StatusBadge label={data.api_server_up ? "Divino agent UP (chat ready)" : "Divino agent DOWN"} status={data.api_server_up ? "ok" : "error"} />
        <StatusBadge label={data.exit_node.device ? `Exit node: ${data.exit_node.device}` : "No exit node"} status={data.exit_node.device ? "ok" : "warning"} />
        <StatusBadge label={data.exit_node.egress_ip ? `Egress IP ${data.exit_node.egress_ip}` : "Egress IP unknown"} status="info" />
      </div>

      <h3 style={{ margin: "4px 0 0", fontSize: 14 }}>Persona{data.personas.length > 1 ? "s" : ""}</h3>
      <div style={gridRow}>
        {data.personas.map((p) => (
          <div key={p.email} style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 12, background: "#fff" }}>
            <strong style={{ fontSize: 14 }}>{cleanName(p.name)}</strong>
            <div style={muted}>{p.email}</div>
            <div style={muted}>{p.provider}</div>
            {p.status ? <div style={{ fontSize: 12, marginTop: 4 }}>{p.status}</div> : null}
          </div>
        ))}
        <div style={{ border: "1px dashed #cbd5e1", borderRadius: 10, padding: 12, background: "#fff", display: "flex", flexDirection: "column", gap: 6, justifyContent: "center" }}>
          <div style={muted}>All logins &amp; keys live in the vault.</div>
          <a href="/CK/company/settings/secrets" style={{ color: "#6366f1", fontSize: 13, fontWeight: 600 }}>Open the credential Vault ↗</a>
        </div>
      </div>

      {data.blocked.length ? (
        <>
          <h3 style={{ margin: "4px 0 0", fontSize: 14 }}>Blocked platforms — needs you</h3>
          <div style={gridRow}>
            {data.blocked.map((b) => (
              <div key={b.channel} style={{ border: `1px solid ${alertColor("warn")}55`, background: alertBg("warn"), borderRadius: 10, padding: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong style={{ fontSize: 14 }}>{b.label}</strong>
                  <StatusBadge label="BLOCKED" status="error" />
                </div>
                <div style={{ fontSize: 12, marginTop: 6, color: alertColor("warn") }}>{b.notes}</div>
                {b.unlisted > 0 ? <div style={{ fontSize: 12, ...muted, marginTop: 4 }}>{b.unlisted} listings prepared, waiting to go live once unblocked.</div> : null}
              </div>
            ))}
          </div>
        </>
      ) : null}

      <div>
        <h3 style={{ margin: "4px 0 6px", fontSize: 14 }}>Tailnet</h3>
        <div style={muted}>{data.tailnet.map((t) => `${t.host}${t.exit_node ? " (exit node)" : ""}`).join(" · ")}</div>
      </div>
    </div>
  );
}

// ── Divino mailbox (info@divinocigars.ch — read + reply/compose via IMAP/SMTP) ────
interface MailItem { uid: string; from: string; to?: string; subject: string; date: string; unread: boolean }
interface MailFolder { name: string; role: string; label: string }
interface MailMsg { uid: string; from: string; to: string; subject: string; date: string; message_id: string; body: string }

function emailOf(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return m ? m[1] : from.trim();
}

function DivinoMail() {
  const [folder, setFolder] = useState<string>("INBOX");
  const folders = usePluginData<{ folders?: MailFolder[] }>("ck-divino-mail-folders");
  const { data, loading, refresh } = usePluginData<{ address?: string; error?: string; folder?: string; messages: MailItem[] }>("ck-divino-mail", { limit: 30, folder });
  const send = usePluginAction("ck-divino-mail-send");
  const toast = usePluginToast();
  const [openUid, setOpenUid] = useState<string | null>(null);
  const [compose, setCompose] = useState<{ to: string; subject: string; body: string; in_reply_to?: string } | null>(null);
  const [sending, setSending] = useState(false);
  const msg = usePluginData<MailMsg>("ck-divino-mail-msg", openUid ? { uid: openUid, folder } : undefined);

  // Sent/Drafts show who it went TO; every other folder shows the sender.
  const outbound = folder === "Sent" || folders.data?.folders?.some((f) => f.name === folder && (f.role === "sent" || f.role === "drafts"));
  const folderList: MailFolder[] = folders.data?.folders ?? [{ name: "INBOX", role: "inbox", label: "Inbox" }];

  async function doSend() {
    if (!compose || !compose.to.trim() || sending) return;
    if (typeof window !== "undefined" && !window.confirm(`Send this email as info@divinocigars.ch to ${compose.to}?`)) return;
    setSending(true);
    try {
      await send({ to: compose.to, subject: compose.subject, body: compose.body, in_reply_to: compose.in_reply_to });
      toast({ title: "Email sent", body: `to ${compose.to}`, tone: "success" });
      setCompose(null);
    } catch (e) {
      toast({ title: "Send failed", body: (e as Error).message, tone: "error" });
    } finally {
      setSending(false);
    }
  }

  // Composer view
  if (compose) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 720 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>New message · from info@divinocigars.ch</h3>
          <button style={miniBtn(false)} onClick={() => setCompose(null)}>← back</button>
        </div>
        <input style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 13 }} placeholder="To (email)" value={compose.to} onChange={(e) => setCompose({ ...compose, to: e.target.value })} />
        <input style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 13 }} placeholder="Subject" value={compose.subject} onChange={(e) => setCompose({ ...compose, subject: e.target.value })} />
        <textarea style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 13, minHeight: 220, fontFamily: "inherit" }} placeholder="Write your message…" value={compose.body} onChange={(e) => setCompose({ ...compose, body: e.target.value })} />
        <div>
          <button style={{ ...tabBtn(true), opacity: sending || !compose.to.trim() ? 0.5 : 1 }} disabled={sending || !compose.to.trim()} onClick={doSend}>{sending ? "Sending…" : "Send"}</button>
        </div>
      </div>
    );
  }

  // Message reader
  if (openUid) {
    const m = msg.data;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 760 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <button style={miniBtn(false)} onClick={() => setOpenUid(null)}>← {folderList.find((f) => f.name === folder)?.label || "back"}</button>
          {m ? <button style={miniBtn(false)} onClick={() => setCompose({ to: emailOf(m.from), subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`, body: `\n\n----- ${m.from} schrieb -----\n${m.body}`, in_reply_to: m.message_id })}>↩ Reply</button> : null}
        </div>
        {msg.loading && !m ? <Spinner /> : m ? (
          <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 14, background: "#fff" }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{m.subject}</div>
            <div style={{ ...muted, marginTop: 4 }}>{m.from} · {fmtDate(m.date)}</div>
            <pre style={{ whiteSpace: "pre-wrap", fontSize: 13, marginTop: 12, fontFamily: "inherit" }}>{m.body}</pre>
          </div>
        ) : <div style={muted}>Could not load message.</div>}
      </div>
    );
  }

  // Inbox list
  const switchFolder = (name: string) => { setOpenUid(null); setFolder(name); };
  const currentLabel = folderList.find((f) => f.name === folder)?.label || folder;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={muted}>{data?.address || "info@divinocigars.ch"}{data?.messages ? ` · ${currentLabel} · ${data.messages.length}` : ` · ${currentLabel}`}</span>
        <div style={{ display: "flex", gap: 6 }}>
          <button style={miniBtn(false)} onClick={() => { folders.refresh(); refresh(); }}>↻</button>
          <button style={tabBtn(true)} onClick={() => setCompose({ to: "", subject: "", body: "" })}>✉ New</button>
        </div>
      </div>
      {/* Folder switcher (Inbox / Sent / Drafts / Junk / Trash / …) */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {folderList.map((f) => (
          <button key={f.name} onClick={() => switchFolder(f.name)}
            style={{ ...miniBtn(f.name === folder), fontWeight: f.name === folder ? 600 : 400 }}>{f.label}</button>
        ))}
      </div>
      {data?.error ? <div style={{ background: alertBg("error"), color: alertColor("error"), padding: 10, borderRadius: 8, fontSize: 13 }}>Mailbox error: {data.error}</div> : null}
      {loading && !data ? <Spinner /> : null}
      <div style={{ display: "flex", flexDirection: "column", border: "1px solid #e2e8f0", borderRadius: 10, overflow: "hidden", background: "#fff" }}>
        {(data?.messages ?? []).map((mi) => {
          const who = outbound ? (mi.to ? `→ ${mi.to}` : "→ …") : mi.from;
          return (
            <button key={mi.uid} onClick={() => setOpenUid(mi.uid)}
              style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "10px 12px", borderBottom: "1px solid #f1f5f9", background: mi.unread ? "#fafaff" : "#fff", cursor: "pointer", textAlign: "left", border: "none", borderBottomWidth: 1, borderBottomStyle: "solid", borderBottomColor: "#f1f5f9", width: "100%" }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: mi.unread ? "#6366f1" : "transparent", flex: "none" }} />
              <span style={{ width: "26%", minWidth: 120, fontWeight: mi.unread ? 600 : 400, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{who.replace(/<[^>]+>/, "").replace(/"/g, "").trim() || who}</span>
              <span style={{ flex: 1, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: mi.unread ? 600 : 400 }}>{mi.subject}</span>
              <span style={{ ...muted, fontSize: 11, flex: "none" }}>{mi.date.slice(0, 16)}</span>
            </button>
          );
        })}
        {data && !data.messages?.length && !data.error ? <div style={{ ...muted, padding: 16 }}>{currentLabel} is empty.</div> : null}
      </div>
    </div>
  );
}

// ── Root page ────────────────────────────────────────────────────────────────────
type Tab = "cockpit" | "listings" | "platforms" | "products" | "control" | "ask" | "money" | "access" | "mail" | "webshop";
const TABS: { key: Tab; label: string }[] = [
  { key: "cockpit", label: "Cockpit" },
  { key: "listings", label: "Listings" },
  { key: "platforms", label: "Platforms" },
  { key: "products", label: "Products" },
  { key: "control", label: "Control" },
  { key: "ask", label: "Ask Divino" },
  { key: "money", label: "Money" },
  { key: "access", label: "Access" },
  { key: "mail", label: "Mail" },
  { key: "webshop", label: "Webshop" },
];

export function CkDivinoPage(_props: PluginPageProps) {
  const [tab, setTab] = useState<Tab>("cockpit");
  const { data: status, loading, error, refresh } = usePluginData<Status>("ck-divino-status");

  return (
    <div style={page}>
      <div style={headRow}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20 }}>Divino · Marketplace Cockpit</h1>
          <span style={muted}>
            {status ? `${status.totals.live} live across ${status.totals.platforms_with_live} platforms · synced ${fmtDate(status.generated_at)}` : "the auto-listing machine, at a glance"}
          </span>
        </div>
        <button style={tabBtn(false)} onClick={() => refresh()}>↻ Refresh</button>
      </div>

      <div style={tabsRow}>
        {TABS.map((t) => (
          <button key={t.key} style={tabBtn(tab === t.key)} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>

      {error ? (
        <div style={{ background: alertBg("error"), border: `1px solid ${alertColor("error")}33`, color: alertColor("error"), padding: 12, borderRadius: 8 }}>
          Could not reach the divino-ops bridge: {error.message}. Is the service running on the box (127.0.0.1:8899)?
        </div>
      ) : null}

      {loading && !status ? (
        <Spinner />
      ) : status ? (
        <>
          {tab === "cockpit" && <Cockpit status={status} />}
          {tab === "listings" && <Listings />}
          {tab === "platforms" && <Platforms status={status} />}
          {tab === "products" && <Products />}
          {tab === "control" && <ControlRoom status={status} onActed={() => refresh()} />}
          {tab === "ask" && <AskDivino />}
          {tab === "money" && <Money />}
          {tab === "access" && <Access />}
          {tab === "mail" && <DivinoMail />}
          {tab === "webshop" && <Webshop />}
        </>
      ) : null}
    </div>
  );
}
