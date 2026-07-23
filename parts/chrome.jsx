function Topbar({ theme, setTheme, route, setRoute }) {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const items = [
    ["§01", "neutrality", "neutrality"],
    ["§02", "platform", "platform"],
    ["§03", "services", "services"],
    ["§04", "method", "architecture"],
    ["§05", "clients", "clients"],
    ["§06", "engagement", "engagement"],
  ];
  const t = time.toISOString().replace("T", " ").slice(0,19) + " UTC";
  return (
    <div className="topbar">
      <span className="lamp pulse" />
      <Brand />
      <span className="sep">/</span>
      <div className="tnav-group" style={{ display: "flex", gap: 16 }}>
        {items.map(([n, l, h]) => (
          <a key={l} href={"#"+h} className="tnav" style={{ display: "inline-flex", gap: 6 }}>
            <span style={{ color: "var(--fg-3)" }}>{n}</span>{l}
          </a>
        ))}
      </div>
      <span className="clock">
        <span style={{ color: "var(--fg-3)" }}>tty1 ·</span> {t} <span className="sep">·</span> v4.2.7
        <span className="sep">·</span>
        <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          style={{ marginLeft: 8, fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".14em", color: "var(--fg-2)", textTransform: "uppercase" }}>
          [{theme === "dark" ? "◐ dark" : "◑ light"}]
        </button>
      </span>
    </div>
  );
}

function Statusbar() {
  return (
    <div className="statusbar">
      <span className="seg ok"><span className="lamp" style={{ width: 6, height: 6, background: "currentColor" }} /> control plane / nominal</span>
      <span className="sep">·</span>
      <span className="seg hide-sm">14 regions</span>
      <span className="sep">·</span>
      <span className="seg hide-sm">7 providers</span>
      <span className="sep">·</span>
      <span className="seg hide-sm">sla 99.997</span>
      <span style={{ marginLeft: "auto" }} className="seg">© 2019—2026 BitBuilder Cloud, LLC</span>
      <span className="sep">·</span>
      <span className="seg">us · austin, tx</span>
    </div>
  );
}

Object.assign(window, { Topbar, Statusbar });
