function Pricing() {
  const [workloads, setWorkloads] = useState(4);
  const [providers, setProviders] = useState(2);
  const [regions, setRegions] = useState(3);
  const tiers = [
    { name: "Audit", sub: "One-off architecture review", price: "$19,500", cadence: "fixed-fee · 4 weeks",
      bullets: ["Portability score per workload", "Egress + cost model", "Target architecture RFC", "Two read-out sessions"], cta: "Book audit" },
    { name: "Migrate", sub: "Full re-platforming engagement", price: "from $79k", cadence: "fixed-fee per workload",
      bullets: ["Everything in Audit", "Migration playbooks + drills", "Zero-downtime cutover", "60-day stabilisation"], cta: "Plan migration", featured: true },
    { name: "Operate", sub: "Managed hosting + SRE", price: "from $4,800", cadence: "monthly · 6-mo min.",
      bullets: ["24/7 NOC coverage", "Patch + CVE pipeline", "Quarterly cost review", "14-day exit guarantee"], cta: "Start operating" },
  ];
  return (
    <section id="engagement">
      <div className="wrap">
        <SectionLabel>§06 / 06 — engagement</SectionLabel>
        <H2 kicker="Engagement" index="§06 / 06" lede="Pricing isn't a secret. We publish it because the only argument for hiding it is leverage we don't need.">
          Three doors.<br/><em>Walk through any.</em>
        </H2>

        <div style={{ marginTop: 40, display: "grid", gridTemplateColumns: "repeat(3,1fr)", border: "1px solid var(--line)" }}>
          {tiers.map((t, i) => (
            <div key={t.name} style={{
              padding: 28, borderRight: i < 2 ? "1px solid var(--line)" : "none",
              background: t.featured ? "var(--accent-bg)" : "var(--bg-1)",
              position: "relative",
            }}>
              {t.featured && <div className="caps" style={{ position: "absolute", top: 12, right: 14, color: "var(--accent)", border: "1px solid var(--accent)", padding: "2px 8px" }}>most chosen</div>}
              <div className="caps">tier · 0{i+1}</div>
              <div className="display" style={{ fontSize: 52, marginTop: 10, fontStyle: "italic" }}>{t.name}</div>
              <div style={{ marginTop: 4, fontSize: 14, color: "var(--fg-1)" }}>{t.sub}</div>
              <div style={{ marginTop: 24, display: "flex", alignItems: "baseline", gap: 12, borderTop: "1px solid var(--line)", paddingTop: 18 }}>
                <div className="display" style={{ fontSize: 36 }}>{t.price}</div>
                <div className="caps">{t.cadence}</div>
              </div>
              <ul style={{ marginTop: 20, padding: 0, listStyle: "none", display: "grid", gap: 8 }}>
                {t.bullets.map((b) => (
                  <li key={b} style={{ display: "flex", gap: 10, fontSize: 13, color: "var(--fg-1)" }}>
                    <span style={{ color: "var(--accent)" }}>→</span>{b}
                  </li>
                ))}
              </ul>
              <button className="btn primary" style={{ marginTop: 28, width: "100%", justifyContent: "center" }}>{t.cta} →</button>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 32, display: "grid", gridTemplateColumns: "1fr 1.1fr", gap: 24 }}>
          <div className="panel">
            <div className="panel-head"><span className="panel-title">tool · estimator</span><span className="caps">indicative ±15%</span></div>
            <div className="panel-body" style={{ padding: 24 }}>
              <h3 className="display" style={{ fontSize: 32 }}>Sketch your engagement.</h3>
              <div style={{ marginTop: 22, display: "grid", gap: 18 }}>
                <Slider label="Workloads" min={1} max={20} value={workloads} onChange={setWorkloads} suffix={workloads === 1 ? "service" : "services"} />
                <Slider label="Providers in scope" min={1} max={5} value={providers} onChange={setProviders} suffix={providers === 1 ? "provider" : "providers"} />
                <Slider label="Live regions" min={1} max={8} value={regions} onChange={setRegions} suffix={regions === 1 ? "region" : "regions"} />
              </div>
              <div style={{ marginTop: 24, padding: "16px 18px", border: "1px solid var(--line)", background: "var(--bg-2)" }}>
                <div className="caps">migration · fixed-fee</div>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: 6 }}>
                  <div className="display" style={{ fontSize: 48 }}>${(19 + workloads * 4 + providers * 6 + regions * 3).toLocaleString()}k</div>
                </div>
                <div className="caps" style={{ marginTop: 4 }}>+ ${(2.4 + workloads * .35 + providers * .4 + regions * .25).toFixed(1)}k / month managed</div>
              </div>
            </div>
          </div>

          <div className="panel" style={{ background: "var(--bg-2)" }}>
            <div className="panel-head"><span className="panel-title">form · brief us</span><span className="chip ok"><span className="dot" /> encrypted</span></div>
            <div className="panel-body" style={{ padding: 24 }}>
              <h3 className="display" style={{ fontSize: 36 }}>Tell us where it hurts.</h3>
              <p style={{ marginTop: 8, fontSize: 14, color: "var(--fg-1)", maxWidth: "44ch", lineHeight: 1.55 }}>
                Reply within one US business day. No SDR will call you. The first 30 minutes are with an engineer.
              </p>
              <div style={{ marginTop: 20, display: "grid", gap: 10 }}>
                <div className="field-row">
                  <div className="field"><label>Name</label><input placeholder="Sasha Reinhardt" /></div>
                  <div className="field"><label>Work email</label><input placeholder="sasha@northwind.com" /></div>
                </div>
                <div className="field-row">
                  <div className="field"><label>Company</label><input placeholder="Northwind Capital" /></div>
                  <div className="field"><label>Current providers</label><input placeholder="aws, gcp, on-prem" /></div>
                </div>
                <div className="field"><label>The pain, briefly</label><textarea rows="3" placeholder="We're paying $1.2M/yr to one provider and our CFO has questions." /></div>
              </div>
              <div style={{ marginTop: 18, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="caps">gpg key on request</span>
                <button className="btn primary">Send brief →</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Slider({ label, min, max, value, onChange, suffix }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span className="caps">{label}</span>
        <span className="mono" style={{ fontSize: 12 }}><strong style={{ color: "var(--accent)" }}>{value}</strong> <span style={{ color: "var(--fg-2)" }}>{suffix}</span></span>
      </div>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(+e.target.value)}
        style={{ width: "100%", marginTop: 6, accentColor: "var(--accent)" }} />
    </div>
  );
}
Object.assign(window, { Pricing });
