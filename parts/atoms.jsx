const { useEffect, useState, useRef, useMemo } = React;

function Logo({ size = 22, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="BitBuilder">
      <rect x="1" y="1" width="22" height="22" stroke={color} strokeWidth="1.4" />
      <path d="M7 7 L4 12 L7 17" stroke={color} strokeWidth="1.3" fill="none" />
      <path d="M17 7 L20 12 L17 17" stroke={color} strokeWidth="1.3" fill="none" />
      <rect x="10" y="10" width="1.6" height="1.6" fill={color} />
      <rect x="13" y="10" width="1.6" height="1.6" fill={color} />
      <rect x="10" y="13" width="1.6" height="1.6" fill={color} />
      <rect x="13" y="13" width="1.6" height="1.6" fill={color} />
    </svg>
  );
}

function Brand({ small }) {
  return (
    <span className="brand">
      <Logo size={small ? 14 : 16} />
      <span style={{ marginLeft: 6 }}>bitbuilder<em>·</em>cloud</span>
      <span className="dot">v4.2</span>
    </span>
  );
}

function SectionLabel({ children }) {
  return <div className="sec-label">{children}</div>;
}

function H2({ kicker, index, children, lede }) {
  return (
    <div style={{ paddingBottom: 32, borderBottom: "1px solid var(--line)", marginTop: 20 }}>
      <h2 className="display" style={{ fontSize: "clamp(40px, 6vw, 84px)", lineHeight: 1.02, maxWidth: "16ch", margin: 0 }}>{children}</h2>
      {lede && <p style={{ marginTop: 22, maxWidth: "62ch", fontSize: 17, lineHeight: 1.6, color: "var(--fg-1)" }}>{lede}</p>}
    </div>
  );
}

function Tape() {
  const items = [
    ["EDGE",    "330+ pops · nominal"],
    ["WORKERS", "p99 · 12ms"],
    ["R2",      "egress · $0.00"],
    ["KV",      "global · ≤ 5ms"],
    ["AWS",     "us-east-1 · nominal"],
    ["GCP",     "europe-west4 · nominal"],
    ["AZURE",   "eastus2 · nominal"],
    ["HETZNER", "hel1 · nominal"],
    ["BARE",    "dfw · nominal"],
    ["SLA",     "99.997"],
    ["INC",     "0 P1 / 30d"],
  ];
  const row = (
    <div className="tape">
      {items.concat(items).map(([s, v], i) => (
        <span key={i} className="tape-item"><span className="sym">{s}</span><span>·</span><span>{v}</span></span>
      ))}
    </div>
  );
  return <div className="tape-strip">{row}</div>;
}

Object.assign(window, { Logo, Brand, SectionLabel, H2, Tape });
