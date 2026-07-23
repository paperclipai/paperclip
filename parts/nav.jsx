function Nav({ tw }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 30);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const items = [
    ["§01", "Neutrality", "#neutrality"],
    ["§02", "Services", "#services"],
    ["§03", "Architecture", "#architecture"],
    ["§04", "Clients", "#clients"],
    ["§05", "Engagement", "#engagement"],
  ];

  return (
    <header style={{
      position: "sticky", top: 0, zIndex: 50,
      background: scrolled ? "rgba(241,236,224,0.92)" : "transparent",
      backdropFilter: scrolled ? "saturate(140%) blur(8px)" : "none",
      borderBottom: scrolled ? "1px solid var(--rule)" : "1px solid transparent",
      transition: "all .25s ease",
    }}>
      <div className="wrap" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 0" }}>
        <a href="#top" style={{ display: "inline-flex" }}><Wordmark /></a>
        <nav style={{ display: "flex", alignItems: "center", gap: 28 }}>
          {items.map(([num, label, href]) => (
            <a key={label} href={href} style={{ fontFamily: "var(--mono)", fontSize: 12, letterSpacing: ".08em", display: "inline-flex", gap: 6 }}>
              <span style={{ color: "var(--ink-soft)" }}>{num}</span><span>{label}</span>
            </a>
          ))}
          <span style={{ width: 1, height: 18, background: "var(--rule-soft)" }} />
          <a href="#engagement" className="btn" style={{ padding: "10px 16px", fontSize: 12 }}>
            <span style={{ width: 6, height: 6, background: "var(--signal)", borderRadius: 0 }} className="pulse" />
            Brief us
          </a>
        </nav>
      </div>
    </header>
  );
}

Object.assign(window, { Nav });
