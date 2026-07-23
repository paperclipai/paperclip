function App() {
  const defaults = /*EDITMODE-BEGIN*/{
    "theme": "dark",
    "accentHue": 38,
    "headline": "Portable\ninfrastructure,\n<em>without the vendor.</em>\n// build it once. run it anywhere."
  }/*EDITMODE-END*/;
  const [tweaks, setTweak] = useTweaks(defaults);

  useEffect(() => {
    document.documentElement.dataset.theme = tweaks.theme;
    document.documentElement.style.setProperty("--accent-h", tweaks.accentHue);
  }, [tweaks.theme, tweaks.accentHue]);

  const setTheme = (t) => setTweak("theme", t);

  return (
    <>
      <Topbar theme={tweaks.theme} setTheme={setTheme} />
      <Hero tw={tweaks} />
      <Neutrality />
      <EdgeStack />
      <Services />
      <Architecture />
      <Cases />
      <Pricing />
      <Footer />
      <Statusbar />

      <TweaksPanel title="Tweaks">
        <TweakSection title="Theme">
          <TweakRadio label="Mode" value={tweaks.theme} options={["dark", "light"]} onChange={(v) => setTweak("theme", v)} />
          <TweakSlider label="Accent hue" value={tweaks.accentHue} min={0} max={360} unit="°" onChange={(v) => setTweak("accentHue", v)} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 4 }}>
            {[
              ["amber", 38], ["red", 25], ["lime", 125], ["teal", 180], ["blue", 255], ["violet", 290],
            ].map(([n, h]) => (
              <button key={n} onClick={() => setTweak("accentHue", h)}
                title={n}
                style={{ height: 22, background: `oklch(0.78 0.17 ${h})`, border: "1px solid var(--line-2)", cursor: "pointer" }} />
            ))}
          </div>
        </TweakSection>
        <TweakSection title="Hero">
          <TweakText label="Headline" value={tweaks.headline.replace(/\n/g, "\\n")}
            onChange={(v) => setTweak("headline", v.replace(/\\n/g, "\n"))} />
        </TweakSection>
      </TweaksPanel>
    </>
  );
}
ReactDOM.createRoot(document.getElementById("app")).render(<App />);
