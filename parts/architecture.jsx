function Architecture() {
  const [step, setStep] = useState(0);
  const steps = [
    { tag: "01", t: "Audit", d: "Map every dependency, contract, and dollar of egress in your current stack — racks, clouds, edge. Output: portability score per workload." },
    { tag: "02", t: "Design", d: "Co-author a target architecture: edge for what users touch, multi-cloud origin where it earns its keep, bare-metal where math demands." },
    { tag: "03", t: "Migrate", d: "Cutovers run on weekends, with chaos drills the week before. Rollback is one DNS flip away — Magic Transit, Tunnel, all of it." },
    { tag: "04", t: "Operate", d: "We run the platform under SLA. Slack channel, quarterly cost review, WAF & rate-limit tuning, and the keys whenever you want them back." },
  ];
  useEffect(() => {
    const id = setInterval(() => setStep((s) => (s + 1) % steps.length), 4200);
    return () => clearInterval(id);
  }, []);
  return (
    <section id="architecture">
      <div className="wrap">
        <SectionLabel>§04 / 06 — method</SectionLabel>
        <H2 kicker="Method" index="§04 / 06" lede="No 60-page strategy decks. We audit, draft, migrate, operate — and then get out of your way.">
          How an engagement <em>actually</em> runs.
        </H2>

        <div style={{ marginTop: 40, border: "1px solid var(--line)", display: "grid", gridTemplateColumns: "repeat(4,1fr)" }}>
          {steps.map((s, i) => (
            <button key={s.tag} onMouseEnter={() => setStep(i)}
              style={{
                textAlign: "left", padding: "22px 20px",
                background: step === i ? "var(--accent-bg)" : "var(--bg-1)",
                color: "var(--fg-0)",
                borderRight: i < 3 ? "1px solid var(--line)" : "none",
                borderTop: "2px solid " + (step === i ? "var(--accent)" : "transparent"),
                cursor: "pointer", transition: "all .25s ease",
              }}>
              <div className="caps" style={{ color: step === i ? "var(--accent)" : "var(--fg-2)" }}>step · {s.tag}</div>
              <div className="display" style={{ fontSize: 32, marginTop: 6, fontStyle: step === i ? "italic" : "normal" }}>{s.t}</div>
              <div style={{ marginTop: 12, fontSize: 13, color: "var(--fg-1)", lineHeight: 1.55, minHeight: "5.4em" }}>{s.d}</div>
            </button>
          ))}
        </div>

        <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 16 }}>
          <span className="caps">progress · auto</span>
          <div style={{ flex: 1, height: 4, background: "var(--bg-2)", border: "1px solid var(--line)", overflow: "hidden" }}>
            <div style={{ width: `${((step+1)/steps.length)*100}%`, height: "100%", background: "var(--accent)", transition: "width .4s ease" }} />
          </div>
          <span className="caps">{step+1} / {steps.length}</span>
        </div>

        <div style={{ marginTop: 32, display: "grid", gridTemplateColumns: "1.2fr .8fr", gap: 24 }}>
          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">fig.02 — reference topology · multi-region</span>
              <span className="caps">e-commerce</span>
            </div>
            <div className="panel-body">
              <svg viewBox="0 0 600 320" style={{ width: "100%" }}>
                <defs>
                  <pattern id="dotbg" width="10" height="10" patternUnits="userSpaceOnUse">
                    <circle cx="1" cy="1" r="0.7" fill="var(--line-2)" />
                  </pattern>
                </defs>
                <rect width="600" height="320" fill="url(#dotbg)" />

                {/* USER */}
                <g>
                  <text x="30" y="22" fontFamily="var(--font-mono)" fontSize="10" fill="var(--fg-2)">USER</text>
                  <circle cx="30" cy="160" r="10" fill="var(--bg-2)" stroke="var(--fg-2)" />
                  <text x="30" y="184" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="9" fill="var(--fg-2)">any geo</text>
                </g>

                {/* EDGE */}
                <g>
                  <text x="160" y="22" fontFamily="var(--font-mono)" fontSize="10" fill="var(--accent)">EDGE · 330+ POPS</text>
                  <rect x="100" y="40" width="160" height="240" fill="none" stroke="var(--accent)" strokeDasharray="4 4" />
                  {[
                    ["workers", 60], ["pages", 90], ["waf + bot", 120], ["zero-trust", 150],
                    ["kv · cache", 180], ["d1 · sql", 210], ["queues + ai", 240]
                  ].map(([l, y], i) => (
                    <g key={i}>
                      <rect x="115" y={y} width="130" height="22" fill={i===0 ? "var(--accent)" : "var(--bg-2)"} stroke="var(--line-2)" />
                      <text x="180" y={y+15} textAnchor="middle" fontFamily="var(--font-mono)" fontSize="10"
                        fill={i===0 ? "var(--bg-0)" : "var(--fg-0)"}>{l}</text>
                    </g>
                  ))}
                </g>

                {/* tunnel */}
                <line x1="40" y1="160" x2="100" y2="160" stroke="var(--accent)" strokeWidth="1.4" />

                {/* ORIGINS */}
                <g>
                  <text x="380" y="22" fontFamily="var(--font-mono)" fontSize="10" fill="var(--fg-2)">ORIGIN · MULTI-CLOUD</text>
                  {[["aws · us-east-1", 60], ["gcp · europe-west", 100], ["hetzner · helsinki", 140], ["bare-metal · dfw", 180], ["on-prem · tunnel", 220]].map(([l, y], i) => (
                    <g key={i}>
                      <line x1="260" y1="160" x2="380" y2={y+11} stroke="var(--line-2)" strokeDasharray="3 3" />
                      <rect x="380" y={y} width="180" height="22" fill="var(--bg-2)" stroke="var(--line-2)" />
                      <text x="470" y={y+15} textAnchor="middle" fontFamily="var(--font-mono)" fontSize="10" fill="var(--fg-0)">{l}</text>
                    </g>
                  ))}
                  <rect x="380" y="248" width="180" height="22" fill="var(--bg-2)" stroke="var(--accent)" strokeDasharray="2 2" />
                  <text x="470" y="263" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="10" fill="var(--accent)">r2 · zero-egress mirror</text>
                </g>
              </svg>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">artifacts shipped</span>
              <span className="caps">06</span>
            </div>
            <div>
              {[
                ["A1", "Architecture RFC (markdown, in your repo)"],
                ["A2", "Terraform / OpenTofu modules"],
                ["A3", "Runbook + on-call rotation"],
                ["A4", "Migration playbook with rollback"],
                ["A5", "Quarterly FinOps review"],
                ["A6", "Exit handover (≤ 14 days)"],
              ].map(([k, v], i, arr) => (
                <div key={k} className="lift" style={{
                  display: "grid", gridTemplateColumns: "44px 1fr 24px", gap: 14, alignItems: "center",
                  padding: "12px 14px", borderBottom: i < arr.length - 1 ? "1px solid var(--line)" : "none",
                }}>
                  <span className="mono" style={{ color: "var(--accent)", fontSize: 12, fontWeight: 600 }}>{k}</span>
                  <span style={{ fontSize: 13 }}>{v}</span>
                  <span className="caps" style={{ color: "var(--fg-3)" }}>↗</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
Object.assign(window, { Architecture });
