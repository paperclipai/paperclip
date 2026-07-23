function EdgeStack() {
  const [active, setActive] = useState("compute");

  const groups = {
    compute: {
      label: "Compute",
      sub: "Run logic where users live — 330+ POPs, no cold starts.",
      items: [
        ["Workers", "JavaScript / Wasm at the edge", "p99 12ms"],
        ["Pages", "JAMstack with Functions baked in", "global · auto"],
        ["Workers AI", "GPU-backed inference at the edge", "llama, mistral"],
        ["Containers", "OCI workloads, scheduled regionally", "beta-ready"],
        ["Cron Triggers", "Reliable scheduled jobs", "minute-grain"],
        ["Browser Rendering", "Headless Chromium for screenshots & PDF", "isolated"],
      ],
    },
    storage: {
      label: "Storage & Data",
      sub: "Object, KV, SQL, vector — all globally addressable, zero egress.",
      items: [
        ["R2", "S3-compatible object store · $0 egress", "primary or mirror"],
        ["KV", "Eventually-consistent key-value", "≤ 5ms read"],
        ["D1", "SQLite at the edge, replicated", "serverless sql"],
        ["Durable Objects", "Strongly-consistent stateful actors", "globally unique"],
        ["Hyperdrive", "Pooled connections to your origin DB", "postgres / mysql"],
        ["Vectorize", "Vector DB for RAG and search", "embeddings native"],
      ],
    },
    network: {
      label: "Network & Zero Trust",
      sub: "Replace the VPN, the WAF, and the bastion host with one fabric.",
      items: [
        ["Magic Transit", "BGP-anycast IP transit for on-prem", "L3 ddos absorbed"],
        ["Tunnel", "Outbound-only links to private origins", "no public IPs"],
        ["Access", "Identity-aware proxy for every app", "okta · azure · scim"],
        ["Gateway", "Secure web egress + DNS filtering", "swg · DLP"],
        ["WARP", "Device-level zero-trust client", "byod-friendly"],
        ["Load Balancing", "Health-aware traffic across origins", "active/active"],
      ],
    },
    security: {
      label: "Security & Compliance",
      sub: "DDoS, bots, secrets, and audit — all in front of your origin.",
      items: [
        ["WAF", "Managed + custom rules, OWASP-aligned", "tuned per-app"],
        ["Bot Management", "ML-graded bot scores per request", "credential stuffing"],
        ["DDoS", "Unmetered L3/L4/L7 absorption", "260+ Tbps cap"],
        ["API Shield", "Schema-validated, mTLS, sequence rules", "openapi native"],
        ["Page Shield", "Client-side script tampering detection", "csp + reporting"],
        ["Email Security", "Phishing + BEC for any mail provider", "google · m365"],
      ],
    },
    media: {
      label: "Media & Delivery",
      sub: "Stream, image, and asset pipelines that never touch origin twice.",
      items: [
        ["Stream", "Adaptive video ingest + delivery", "live + vod"],
        ["Images", "On-the-fly resize, format, signed URLs", "avif / webp"],
        ["CDN + Cache Reserve", "Tiered cache, 100% hit on hot paths", "global"],
        ["Argo Smart Routing", "Real-time TCP path optimisation", "p99 -33%"],
        ["Speed", "Web Vitals tuning + analytics", "lcp + inp"],
        ["Workers Static Assets", "Compute + assets co-located", "single deploy"],
      ],
    },
  };

  return (
    <section id="platform">
      <div className="wrap">
        <SectionLabel>§02 / 06 — platform</SectionLabel>
        <H2 kicker="Platform" index="§02 / 06" lede="The edge is where modern applications win or lose. We've been shipping on it since the WAF was new — and we know the entire developer platform cold.">
          The edge stack,<br/><em>fully understood.</em>
        </H2>

        <div style={{ marginTop: 32, display: "flex", gap: 4, borderBottom: "1px solid var(--line)", flexWrap: "wrap" }}>
          {Object.entries(groups).map(([k, g]) => (
            <button key={k} onClick={() => setActive(k)}
              style={{
                padding: "12px 18px", border: "none", cursor: "pointer", background: "transparent",
                borderBottom: "2px solid " + (active === k ? "var(--accent)" : "transparent"),
                color: active === k ? "var(--fg-0)" : "var(--fg-2)",
                fontFamily: "var(--font-mono)", fontSize: 12, letterSpacing: ".06em",
                marginBottom: -1,
              }}>
              <span style={{ color: active === k ? "var(--accent)" : "var(--fg-3)", marginRight: 8 }}>
                {String(Object.keys(groups).indexOf(k) + 1).padStart(2, "0")}
              </span>
              {g.label}
            </button>
          ))}
        </div>

        <div style={{ marginTop: 28, display: "grid", gridTemplateColumns: "1fr 2fr", gap: 32, alignItems: "start" }}>
          <div>
            <div className="caps">scope · {groups[active].label.toLowerCase()}</div>
            <p className="serif" style={{ fontSize: 26, fontStyle: "italic", color: "var(--fg-0)", marginTop: 8, lineHeight: 1.3 }}>
              {groups[active].sub}
            </p>
            <div style={{ marginTop: 20, padding: "14px 16px", border: "1px solid var(--line)", background: "var(--bg-1)", display: "grid", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span className="caps">years deployed</span>
                <span className="mono" style={{ color: "var(--accent)", fontSize: 13 }}>14+</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span className="caps">products in production</span>
                <span className="mono" style={{ color: "var(--fg-0)", fontSize: 13 }}>{groups[active].items.length} / {groups[active].items.length}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span className="caps">white-label engagements</span>
                <span className="mono" style={{ color: "var(--fg-0)", fontSize: 13 }}>available</span>
              </div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 0, border: "1px solid var(--line)" }}>
            {groups[active].items.map(([n, d, m], i) => (
              <div key={n} className="lift" style={{
                padding: "18px 18px",
                borderRight: i % 2 === 0 ? "1px solid var(--line)" : "none",
                borderBottom: i < groups[active].items.length - 2 ? "1px solid var(--line)" : "none",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span className="mono" style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-0)" }}>{n}</span>
                  <span className="caps">{m}</span>
                </div>
                <div style={{ marginTop: 6, fontSize: 13, color: "var(--fg-1)", lineHeight: 1.5 }}>{d}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
Object.assign(window, { EdgeStack });
