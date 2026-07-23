function Neutrality() {
  const [hovered, setHovered] = useState(null);
  const providers = [
    { id: "aws", name: "AWS", x: 14, y: 30 },
    { id: "gcp", name: "GCP", x: 32, y: 14 },
    { id: "azure", name: "Azure", x: 56, y: 22 },
    { id: "hetz", name: "Hetzner", x: 82, y: 36 },
    { id: "do", name: "DigitalOcean", x: 80, y: 70 },
    { id: "ovh", name: "OVH", x: 56, y: 80 },
    { id: "onprem", name: "On-prem", x: 28, y: 76 },
    { id: "bm", name: "Bare-metal", x: 8, y: 60 },
  ];
  return (
    <section id="neutrality">
      <div className="wrap">
        <SectionLabel>§01 / 06 — neutrality</SectionLabel>
        <H2 kicker="Neutrality" index="§01 / 06" lede="One provider is a single point of failure for your strategy. We architect every workload to run anywhere — and to leave anywhere on 24 hours' notice.">
          The cloud,<br/><em>plural.</em>
        </H2>

        <div style={{ marginTop: 40, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 32, alignItems: "stretch" }}>
          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">fig.01 — control plane / providers as peers</span>
              <span className="caps">n = 8</span>
            </div>
            <div className="panel-body">
              <div className="gridbg" style={{ position: "relative", aspectRatio: "1 / 1", border: "1px dashed var(--line-2)" }}>
                <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)", textAlign: "center", zIndex: 2 }}>
                  <div style={{ width: 120, height: 120, border: "1px solid var(--accent)", background: "var(--bg-2)", display: "grid", placeItems: "center", color: "var(--accent)" }}>
                    <div>
                      <div style={{ display: "grid", placeItems: "center" }}><Logo size={36} color="var(--accent)" /></div>
                      <div className="caps" style={{ marginTop: 6, color: "var(--accent)" }}>bb · edge</div>
                      <div className="mono" style={{ fontSize: 9, color: "var(--fg-2)", marginTop: 2 }}>330+ pops</div>
                    </div>
                  </div>
                </div>
                {providers.map((p) => (
                  <div key={p.id}
                    onMouseEnter={() => setHovered(p.id)}
                    onMouseLeave={() => setHovered(null)}
                    style={{
                      position: "absolute", left: `${p.x}%`, top: `${p.y}%`, transform: "translate(-50%,-50%)",
                      padding: "5px 10px", background: hovered === p.id ? "var(--accent)" : "var(--bg-1)",
                      color: hovered === p.id ? "var(--bg-0)" : "var(--fg-1)",
                      border: "1px solid " + (hovered === p.id ? "var(--accent)" : "var(--line-2)"),
                      fontFamily: "var(--font-mono)", fontSize: 11, transition: "all .2s ease", zIndex: 2,
                    }}>
                    {p.name}
                  </div>
                ))}
                <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
                  {providers.map((p) => (
                    <line key={p.id} x1="50%" y1="50%" x2={`${p.x}%`} y2={`${p.y}%`}
                      stroke={hovered === p.id ? "var(--accent)" : "var(--line-2)"}
                      strokeWidth={hovered === p.id ? 1.4 : 1} strokeDasharray="2 4" />
                  ))}
                </svg>
              </div>
              <div style={{ marginTop: 12, display: "flex", justifyContent: "space-between", color: "var(--fg-2)" }} className="caps">
                <span>{hovered ? `▸ ${providers.find(p => p.id === hovered).name}` : "hover a node"}</span>
                <span>0 lock-in across mesh</span>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">principles / 05</span>
              <span className="caps">contract-grade</span>
            </div>
            <div>
              {[
                ["A.", "Edge first, origin neutral", "User-facing logic runs at 330+ POPs. Origin is whichever cloud earns its keep this quarter."],
                ["B.", "Your keys, your kingdom", "Encryption keys live in your KMS. We operate. You own."],
                ["C.", "Egress is a feature, not a fee", "We model egress before lock-in becomes invisible. Object storage with $0 egress is non-negotiable."],
                ["D.", "Open by contract", "Terraform, OpenTofu, Wrangler, OTel — never a proprietary console as source of truth."],
                ["E.", "Exit clauses, real ones", "SOW guarantees a 14-day handover. Migration playbooks ship with the contract."],
              ].map(([k, t, s], i, arr) => (
                <div key={k} className="lift" style={{
                  display: "grid", gridTemplateColumns: "44px 1fr 56px", gap: 16, alignItems: "start",
                  padding: "20px 14px", borderBottom: i < arr.length - 1 ? "1px solid var(--line)" : "none",
                }}>
                  <span className="display" style={{ fontSize: 30, color: "var(--accent)" }}>{k}</span>
                  <div>
                    <div className="serif" style={{ fontStyle: "italic", fontSize: 18, color: "var(--fg-0)" }}>{t}</div>
                    <div style={{ marginTop: 4, fontSize: 13, color: "var(--fg-1)", lineHeight: 1.55 }}>{s}</div>
                  </div>
                  <span className="caps" style={{ color: "var(--fg-3)", textAlign: "right" }}>0{i+1}/05</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

Object.assign(window, { Neutrality });
