function Hero({ tw }) {
  return (
    <section id="top" style={{ paddingTop: 56 }}>
      <div className="wrap">
        <SectionLabel>§00 / hero · the switzerland of cloud</SectionLabel>

        <div className="hero-grid rise" style={{ marginTop: 24 }}>
          <div>
            <h1 className="hero-headline">
              {tw.headline.split("\n").map((l, i, arr) => {
                const isLast = i === arr.length - 1;
                if (l.startsWith("//")) {
                  return <span key={i} style={{ display: "block", fontFamily: "var(--font-mono)", fontSize: ".22em", color: "var(--fg-2)", letterSpacing: "-.01em", marginTop: 22, fontWeight: 500 }}>{l}</span>;
                }
                return <span key={i} style={{ display: "block" }} dangerouslySetInnerHTML={{ __html: l }} />;
              })}
            </h1>

            <p style={{ marginTop: 28, maxWidth: "52ch", fontSize: 17, lineHeight: 1.6, color: "var(--fg-1)" }}>
              BitBuilder is a US-based managed-hosting and consulting practice for teams who refuse to mortgage their architecture to a single cloud. We design, run, and migrate enterprise workloads across providers and the global edge — encrypted end-to-end, observable everywhere, owned by you.
            </p>

            <p style={{ marginTop: 14, maxWidth: "52ch", fontSize: 13, color: "var(--fg-2)", fontFamily: "var(--font-mono)", letterSpacing: ".02em" }}>
              <span style={{ color: "var(--accent)" }}>// </span>expert Cloudflare consulting &amp; support · 14<span style={{ color: "var(--accent)" }}>+</span> years · on-prem &rarr; edge specialists
            </p>

            <div style={{ marginTop: 28, display: "flex", gap: 10, flexWrap: "wrap" }}>
              <a href="#engagement" className="btn primary">Schedule architecture review <kbd>↵</kbd></a>
              <a href="#services" className="btn"><span style={{ color: "var(--accent)" }}>$</span> see services <kbd>S</kbd></a>
            </div>

            <div style={{ marginTop: 48, display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 18, paddingTop: 24, borderTop: "1px solid var(--line)" }}>
              <div className="bigmetric"><div className="v">14</div><div className="l">regions live</div></div>
              <div className="bigmetric"><div className="v">7</div><div className="l">providers supported</div></div>
              <div className="bigmetric"><div className="v">38<span style={{ fontSize: 32 }}>%</span></div><div className="l">median spend ↓</div></div>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="terminal">
              <div className="terminal-head">
                <span>session · bb-cli v4.2 · {tw.headline.length > 0 ? "client@bb-prod" : ""}</span>
                <span className="lamps">
                  <span style={{ background: "var(--accent)" }} />
                  <span style={{ background: "var(--fg-3)" }} />
                  <span style={{ background: "var(--fg-3)" }} />
                </span>
              </div>
              <div className="terminal-body">
                <div className="line cmd"><span className="p">$</span><span>bb deploy svc/api --edge=workers --origin=any</span></div>
                <div className="line dim"><span className="p">›</span><span>routing: 330+ pops · anycast · &lt; 50ms</span></div>
                <div className="line dim"><span className="p">›</span><span>origin: aws us-east-1 + bare-metal dfw</span></div>
                <div className="line dim"><span className="p">›</span><span>tls: client-managed keys · zero-trust</span></div>
                <div className="line dim"><span className="p">›</span><span>r2 ↔ s3 mirror · egress fee: $0</span></div>
                <div className="line ok"><span className="p">✓</span><span>shipped · 3 origins · 1 edge · 0 lock-in</span></div>
                <div className="line dim"><span className="p">›</span><span>elapsed: 4m 18s · drill cost: $0.42</span></div>
                <div className="line cmd"><span className="p">$</span><span><span className="blink">▌</span></span></div>
              </div>
            </div>

            <div className="panel">
              <div className="panel-head">
                <span className="panel-title">spec · 04—27</span>
                <span className="chip ok"><span className="dot" /> verified</span>
              </div>
              <div className="panel-body">
                <div className="spec-rows">
                  <span className="k">edge</span><span className="v">workers · 330+ pops · anycast</span>
                  <span className="k">origin</span><span className="v">multi-cloud · active/active</span>
                  <span className="k">storage</span><span className="v">r2 · zero egress</span>
                  <span className="k">zero-trust</span><span className="v">access · gateway · tunnel</span>
                  <span className="k">sla</span><span className="v">99.99 · 24/7 sre</span>
                  <span className="k">audit</span><span className="v">soc 2 ii · iso 27001</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

Object.assign(window, { Hero });
