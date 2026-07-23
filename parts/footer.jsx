function Footer() {
  return (
    <footer style={{ background: "var(--bg-1)", borderTop: "1px solid var(--line)", padding: "56px 0 24px", position: "relative" }}>
      <div className="wrap">
        <div className="display" style={{ fontSize: "clamp(48px, 10vw, 156px)", lineHeight: .95, letterSpacing: "-.03em" }}>
          <span style={{ display: "block" }}>build it once.</span>
          <span style={{ display: "block" }}><em>run it anywhere.</em></span>
        </div>

        <div style={{ marginTop: 48, display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr", gap: 32, paddingTop: 24, borderTop: "1px solid var(--line)" }}>
          <div>
            <Brand />
            <p style={{ marginTop: 14, fontSize: 13, color: "var(--fg-1)", lineHeight: 1.6, maxWidth: "36ch" }}>
              BitBuilder Cloud, LLC. A vendor-agnostic infrastructure consultancy and managed-hosting practice. US-based. Independent since 2019.
            </p>
            <div style={{ marginTop: 14, display: "flex", gap: 6, flexWrap: "wrap" }}>
              {["ISO 27001", "SOC 2 II", "HIPAA-ready", "FedRAMP-aligned"].map((c) => (
                <span key={c} className="chip"><span className="dot" style={{ background: "var(--accent)" }} />{c}</span>
              ))}
            </div>
          </div>
          <FooterCol title="Practice" items={["Architecture review", "Migration", "Managed hosting", "FinOps", "Security audit"]} />
          <FooterCol title="Company" items={["About", "Engineers", "Writing", "Open positions", "Press"]} />
          <FooterCol title="Contact" items={["hello@bitbuilder.cloud", "+1 (512) 555 0218", "Austin, TX · HQ", "Remote-first US team", "status.bitbuilder.cloud"]} />
        </div>

        <div style={{ marginTop: 40, display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 18, borderTop: "1px solid var(--line)", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-2)" }}>
          <div style={{ display: "flex", gap: 14 }}>
            <span>© 2019—2026 BitBuilder Cloud, LLC</span><span style={{ color: "var(--fg-3)" }}>·</span>
            <span>privacy</span><span style={{ color: "var(--fg-3)" }}>·</span>
            <span>terms</span><span style={{ color: "var(--fg-3)" }}>·</span>
            <span>security.txt</span>
          </div>
          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--pos)" }}>
              <span style={{ width: 6, height: 6, background: "currentColor" }} className="pulse" /> all systems nominal
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
function FooterCol({ title, items }) {
  return (
    <div>
      <div className="caps">{title}</div>
      <ul style={{ listStyle: "none", margin: "12px 0 0", padding: 0, display: "grid", gap: 6 }}>
        {items.map((it) => <li key={it} style={{ fontSize: 13, color: "var(--fg-1)" }}><a href="#">{it}</a></li>)}
      </ul>
    </div>
  );
}
Object.assign(window, { Footer });
