import { useState } from "react";
import type { PluginPageProps } from "@paperclipai/plugin-sdk/ui";

// Resolve the embedded apps' URLs from how Paperclip itself is being reached, so the iframes work
// from ANY access path: tailnet hostname (quita-divino / *.ts.net), raw tailnet IP (100.x…), or
// on-box localhost. We deliberately do NOT depend on `tailscale serve` port mappings here —
// serve is Host-header-keyed, so requests by raw IP get its "404 page not found". Instead the
// iframes use the SAME host the GUI was reached on with the services' direct ports; tailscaled
// (userspace/netstack) forwards inbound tailnet connections to the box's loopback on the same
// port — which is exactly how the GUI itself (:3100/:8080) is being reached.
// NOTE: if you reach the GUI through an SSH tunnel (browser shows "localhost" but you are NOT on
// the box), also tunnel 8085 and 3000 or the embeds cannot load — they'd point at YOUR machine.
function appUrls(): { crm: string; divino: string } {
  const host = typeof window !== "undefined" ? window.location.hostname : "localhost";
  return { crm: `http://${host}:8085/`, divino: `http://${host}:3000` };
}

const wrap: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 10, padding: 12, height: "100%" };
const frame: React.CSSProperties = {
  border: "1px solid #e2e8f0",
  width: "100%",
  height: "calc(100vh - 130px)",
  borderRadius: 8,
  background: "#ffffff",
};
const headRow: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" };
const linkOut: React.CSSProperties = { fontSize: 12, color: "#6366f1", alignSelf: "center", textDecoration: "none" };

// CRM — a full window onto EspoCRM (it has its own nav inside).
export function CkCrmPage(_props: PluginPageProps) {
  const { crm } = appUrls();
  return (
    <div style={wrap}>
      <div style={headRow}>
        <h1 style={{ margin: 0, fontSize: 18, color: "#0f172a" }}>CRM · EspoCRM</h1>
        <a href={crm} target="_blank" rel="noreferrer" style={linkOut}>open full ↗</a>
      </div>
      <iframe src={crm} style={frame} title="EspoCRM" />
    </div>
  );
}

// Divino — a window onto divinocigars.ch. Two REAL views:
//  • Shop  = the live customer site (public, no login) — a preview of what customers see.
//  • Admin = the /admin management dashboard (orders, products, revenue) — password-protected.
// (The old dashboard/settings/studio/account tabs were removed: the site is a customer-shop SPA
//  that ignores those paths, so they rendered nothing.)
const DIVINO_VIEWS = [
  { key: "", label: "Shop" },
  { key: "admin", label: "Admin" },
];

export function CkDivinoPage(_props: PluginPageProps) {
  const { divino } = appUrls();
  const [view, setView] = useState("");
  const src = `${divino}/${view}`;
  const adminUrl = `${divino}/admin`;
  return (
    <div style={wrap}>
      <div style={headRow}>
        <h1 style={{ margin: 0, fontSize: 18, color: "#0f172a" }}>Divino · divinocigars.ch</h1>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {DIVINO_VIEWS.map((v) => (
            <button
              key={v.key}
              onClick={() => setView(v.key)}
              style={{
                padding: "5px 10px",
                borderRadius: 8,
                border: "1px solid #e2e8f0",
                background: view === v.key ? "#6366f1" : "#ffffff",
                color: view === v.key ? "#ffffff" : "#0f172a",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {v.label}
            </button>
          ))}
          <a href={src || divino} target="_blank" rel="noreferrer" style={linkOut}>open ↗</a>
        </div>
      </div>
      {view === "admin" && (
        <div style={{ fontSize: 12, color: "#64748b", padding: "2px 2px 0" }}>
          The admin is password-protected. If it doesn’t prompt for login in this window (some browsers
          block that inside an embed), use <a href={adminUrl} target="_blank" rel="noreferrer" style={{ color: "#6366f1" }}>Open ↗</a>.
        </div>
      )}
      <iframe key={view} src={src} style={frame} title={`Divino ${view || "shop"}`} />
    </div>
  );
}
