function Services() {
  const [active, setActive] = useState(0);
  const services = [
    { tag: "S—01", title: "Architecture & Advisory", one: "We sit in your war-room.",
      body: "Reference architectures, RFCs, and platform reviews from engineers who've been shipping at the edge since 2012. Outcome-graded — not slide-graded.",
      includes: ["Edge-first architecture review", "Cloud-exit assessment", "Platform RFC drafting", "Hiring + team shape"],
      lead: "from $19,500 / engagement" },
    { tag: "S—02", title: "On-prem → Edge Migration", one: "Move with the lights on.",
      body: "Lift, shift, refactor — from racks and colos to a globally distributed origin behind the world's largest edge network. Zero-downtime cutovers, validated with chaos drills.",
      includes: ["On-prem → cloud + edge", "Workers + Pages roll-out", "Database replication & R2 mirror", "DNS / Magic Transit cutover"],
      lead: "fixed-fee per workload" },
    { tag: "S—03", title: "Managed Hosting & SRE", one: "We run it. You ship.",
      body: "24/7 SRE coverage across edge and origin. Patching, paging, capacity, cost, WAF tuning. Encrypted, observable, and yours to take back any time.",
      includes: ["24/7 NOC + on-call", "WAF & bot management tuning", "Backup + DR drills", "Quarterly cost review"],
      lead: "from $4,800 / month" },
    { tag: "S—04", title: "FinOps & Egress Strategy", one: "Stop paying the lock-in tax.",
      body: "We model your cloud bill the way the providers don't want you to: by portability cost. Then we move the workloads where the math works — usually closer to your users.",
      includes: ["Bill-of-materials audit", "Egress modelling & R2 sizing", "Reserved-capacity broker", "Multi-cloud rate cards"],
      lead: "performance-based" },
  ];

  return (
    <section id="services">
      <div className="wrap">
        <SectionLabel>§03 / 06 — services</SectionLabel>
        <H2 kicker="Services" index="§03 / 06" lede="Engagement is modular. Most clients start with an architecture review and graduate into managed hosting; some hire us only to land a hard migration. No retainers you can't cancel.">
          Four practices.<br/><em>One contract.</em>
        </H2>

        <div style={{ marginTop: 40, display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 24 }}>
          <div className="panel">
            <div className="panel-head"><span className="panel-title">practices</span><span className="caps">04</span></div>
            {services.map((s, i) => (
              <button key={s.tag} onClick={() => setActive(i)}
                style={{
                  display: "block", textAlign: "left", width: "100%",
                  background: active === i ? "var(--accent-bg)" : "transparent",
                  borderLeft: "2px solid " + (active === i ? "var(--accent)" : "transparent"),
                  borderBottom: i < services.length - 1 ? "1px solid var(--line)" : "none",
                  padding: "18px 16px", color: "var(--fg-0)", cursor: "pointer",
                }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span className="mono" style={{ fontSize: 11, letterSpacing: ".1em", color: active === i ? "var(--accent)" : "var(--fg-2)" }}>
                    {active === i ? "▸ " : "  "}{s.tag}
                  </span>
                  <span className="caps">{s.lead}</span>
                </div>
                <div className="serif" style={{ fontSize: 22, marginTop: 4, fontStyle: active === i ? "italic" : "normal" }}>{s.title}</div>
                <div style={{ marginTop: 4, fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 14, color: "var(--fg-1)" }}>— {s.one}</div>
              </button>
            ))}
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">{services[active].tag} · detail</span>
              <span className="chip warn"><span className="dot" /> active</span>
            </div>
            <div className="panel-body" style={{ padding: 28 }}>
              <h3 className="display" style={{ fontSize: 44 }}><em>{services[active].title}</em></h3>
              <p style={{ marginTop: 14, fontSize: 16, lineHeight: 1.6, color: "var(--fg-1)", maxWidth: "52ch" }}>{services[active].body}</p>
              <div style={{ marginTop: 24, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {services[active].includes.map((it) => (
                  <div key={it} style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 12px", border: "1px solid var(--line)", background: "var(--bg-2)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                    <span style={{ color: "var(--accent)" }}>+</span>{it}
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 24, display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--line)", paddingTop: 18 }}>
                <span className="caps">typical kickoff · 5 working days</span>
                <a href="#engagement" className="btn primary">Start with {services[active].tag} →</a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

Object.assign(window, { Services });
