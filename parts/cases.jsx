function Cases() {
  const cases = [
    { tag: "C—01", client: "Helix Biosciences", sector: "Genomics · Series C",
      headline: "Cut multi-region inference cost by 41% by moving the API surface to the edge.",
      body: "Helix needed sub-50ms latency for genome variant calls across 9 countries. We pushed the API tier into Workers running at 330+ POPs, kept origin compute on Hetzner bare-metal, and mirrored genome blobs into R2 — wiping out S3 egress entirely. Bill went down. Latency went down further.",
      stats: [["41%", "infra cost ↓"], ["38ms", "p99 latency"], ["6w", "to cutover"]] },
    { tag: "C—02", client: "Northwind Capital", sector: "Quantitative finance",
      headline: "A 4-hour cloud-exit drill, run quarterly, that the regulator now writes about.",
      body: "Northwind was contractually required to demonstrate they could leave any single origin provider in under 24 hours. We built and now operate the drill: a real failover that moves 220 TB and 1,400 services to a parallel stack, behind a single zero-trust gateway, audited live and never seen by clients.",
      stats: [["3h 41m", "drill cutover"], ["220 TB", "data shifted"], ["0", "client downtime"]] },
    { tag: "C—03", client: "Foundry & Sons", sector: "Industrial IoT · 14-yr partner",
      headline: "From rack-mount colos to a single edge-fronted control plane. Same uptime, half the headcount.",
      body: "Foundry's platform team was running three colos and three vendor consoles. We migrated to a single edge-fronted control plane, with Tunnel reaching every legacy device and Workers handling auth and rate-limiting. Platform team shrank by attrition; on-call finally got a weekend.",
      stats: [["1×", "control plane"], ["−52%", "platform headcount"], ["99.99", "sla held"]] },
  ];
  const [open, setOpen] = useState(0);
  return (
    <section id="clients">
      <div className="wrap">
        <SectionLabel>§05 / 06 — clients</SectionLabel>
        <H2 kicker="Clients" index="§05 / 06" lede="We pick clients for fit, not logo wattage. Three we can talk about; the rest we can't.">
          Three engagements,<br/>told <em>in one paragraph</em>.
        </H2>

        <div style={{ marginTop: 40, border: "1px solid var(--line)" }}>
          {cases.map((c, i) => {
            const isOpen = open === i;
            return (
              <div key={c.tag} style={{ borderBottom: i < cases.length - 1 ? "1px solid var(--line)" : "none", background: isOpen ? "var(--bg-1)" : "transparent" }}>
                <button onClick={() => setOpen(isOpen ? -1 : i)}
                  style={{
                    width: "100%", textAlign: "left", padding: "22px 24px",
                    display: "grid", gridTemplateColumns: "100px 1fr 280px 32px", gap: 20, alignItems: "center"
                  }}>
                  <span className="mono" style={{ fontSize: 11, letterSpacing: ".1em", color: "var(--fg-2)" }}>{c.tag}</span>
                  <div>
                    <div className="serif" style={{ fontStyle: "italic", fontSize: 26 }}>{c.client}</div>
                    <div className="caps" style={{ marginTop: 4 }}>{c.sector}</div>
                  </div>
                  <div style={{ fontSize: 14, color: "var(--fg-1)", lineHeight: 1.45 }}>{c.headline}</div>
                  <span style={{ fontFamily: "var(--font-serif)", fontSize: 30, color: "var(--accent)", textAlign: "right", transform: isOpen ? "rotate(45deg)" : "none", transition: "transform .25s ease" }}>+</span>
                </button>
                {isOpen && (
                  <div style={{ padding: "0 24px 28px 144px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 32 }}>
                    <p style={{ fontSize: 15, lineHeight: 1.65, color: "var(--fg-1)" }}>{c.body}</p>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16 }}>
                      {c.stats.map(([n, l]) => (
                        <div key={l} style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}>
                          <div className="display" style={{ fontSize: 36 }}>{n}</div>
                          <div className="caps" style={{ marginTop: 4 }}>{l}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ marginTop: 56, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 48, alignItems: "end" }}>
          <blockquote style={{ margin: 0 }}>
            <div className="display" style={{ fontSize: "clamp(28px, 3.4vw, 48px)", lineHeight: 1.2 }}>
              <em style={{ color: "var(--accent)" }}>“</em>They're the rare consultancy that ships code on a Friday and answers the pager on a Sunday.<em style={{ color: "var(--accent)" }}>”</em>
            </div>
            <div style={{ marginTop: 36, display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ width: 40, height: 40, background: "var(--bg-2)", border: "1px solid var(--line-2)", color: "var(--fg-0)", display: "grid", placeItems: "center", fontFamily: "var(--font-mono)", fontSize: 12 }}>MV</div>
              <div>
                <div className="mono" style={{ fontSize: 12 }}>Marta Vélez</div>
                <div className="caps">VP Platform · Northwind Capital</div>
              </div>
            </div>
          </blockquote>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            {[["NPS", "73"], ["Avg engagement", "14 mo"], ["Renewal rate", "92%"], ["Pages/mo", "&lt; 4"]].map(([l, n]) => (
              <div key={l} style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
                <div className="display" style={{ fontSize: 44 }} dangerouslySetInnerHTML={{ __html: n }} />
                <div className="caps" style={{ marginTop: 4 }}>{l}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
Object.assign(window, { Cases });
