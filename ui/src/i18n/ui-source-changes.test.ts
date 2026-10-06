// @vitest-environment node
import { describe, expect, it } from "vitest";
import { collectUiSourceChanges, collectUiText, isUiSourcePath, runUiSourceChanges } from "./ui-source-changes";

describe("incremental UI source review queue", () => {
  it("finds new JSX, attributes, conditional labels and display metadata", () => {
    const result = collectUiText({ "Example.tsx": `
      const choices = [{ label: "Personal account", value: "user" }];
      const view = <section><h1>Email</h1><button aria-label={busy ? "Connecting" : "Connect"} title="Setup">Next</button></section>;
    ` });
    expect(result.map((item) => item.text)).toEqual(["Personal account", "Email", "Connecting", "Connect", "Setup", "Next"]);
    expect(result.every((item) => item.line > 0)).toBe(true);
  });
  it("ignores moved lines but reports duplicate new occurrences and changed text", () => {
    const previous = { "Example.tsx": `const x = <p>Connect</p>;` };
    expect(collectUiSourceChanges(previous, { "Example.tsx": `\n\n${previous["Example.tsx"]}` }).candidates).toEqual([]);
    const result = collectUiSourceChanges(previous, { "Example.tsx": `const x = <><p>Connect</p><p>Connect</p><p>Reconnect</p></>;` });
    expect(result.candidates.map((item) => item.text)).toEqual(["Connect", "Reconnect"]);
  });
  it("keeps removed files visible and handles wholly new files", () => {
    const result = collectUiSourceChanges({ "Old.tsx": `const x = <p>Old</p>;` }, { "New.tsx": `const x = <p>New</p>;` });
    expect(result.removedFiles).toEqual(["Old.tsx"]);
    expect(result.files).toEqual(["New.tsx"]);
    expect(result.candidates[0]?.text).toBe("New");
  });
  it("does not mistake translated keys, code examples or routes for UI copy", () => {
    const source = `const x = <><Trans i18nKey="key">Fallback</Trans><pre><code>Example</code></pre><button title={t("key")} data-state="open" onClick={() => send("command")} /></>;`;
    expect(collectUiText({ "Example.tsx": source })).toEqual([]);
  });
  it("does not mistake enum comparisons or typeof guards for display labels", () => {
    expect(collectUiText({ "Example.tsx": `const x = <button aria-label={direction === "inbound" ? t("received") : t("sent")} />; const obj = { description: typeof raw === "string" ? raw : undefined };` })).toEqual([]);
  });
  it("finds literal JSX expression branches and logical display fallbacks", () => {
    const source = `const x = <>
      {"Fragment label"}
      <button>{"Connect"}</button>
      <button>{state === "pending" ? "Connecting" : "Connected"}</button>
      <button title={label || "Reconnect"} aria-label={label ?? "Retry"} />
      <button title={(state === "active" && "Pause") || "Resume"} />
      <button>{typeof raw === "string" && (raw || "No message")}</button>
    </>; const meta = { description: raw ?? "Description unavailable" };`;
    expect(collectUiText({ "Example.tsx": source }).map((item) => item.text)).toEqual([
      "Fragment label", "Connect", "Connecting", "Connected", "Reconnect", "Retry",
      "Pause", "Resume", "No message", "Description unavailable",
    ]);
  });
  it("keeps JSX expression conditions, translation keys and protocol inputs excluded", () => {
    const source = `const x = <>
      {state === "active"}
      {typeof raw === "string" ? raw : null}
      {state === "active" && t("pause.key")}
      {helper("provider_status") || t("fallback.key")}
      <button title={state === "active"} data-state={raw || "pending"} />
      <Trans i18nKey="copy.key">{"Fallback"}</Trans>
      <pre>{"Example"}<code>{raw || "Example code"}</code></pre>
    </>;`;
    expect(collectUiText({ "Example.tsx": source })).toEqual([]);
  });
  it("reports literal template fragments but never claims to resolve dynamic output", () => {
    const result = collectUiText({ "Example.tsx": 'const x = <button aria-label={`More actions for ${name}`} title={helper(raw)} />;' });
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("attribute:aria-label:template");
  });
  it("stops on syntax errors instead of reporting misleading zero coverage", () => {
    expect(() => collectUiText({ "Broken.tsx": "const x = <" })).toThrow("syntax errors");
  });
  it("limits source scope without excluding production variants", () => {
    for (const file of ["ui/src/pages/Email.tsx", "ui/src/components/Layout.production.tsx", "ui/src/lib/labels.ts"]) expect(isUiSourcePath(file)).toBe(true);
    for (const file of ["server/src/a.ts", "ui/src/i18n/locales/en.json", "ui/src/pages/Email.test.tsx", "ui/src/fixtures/Test.tsx", "ui/src/pages/DesignGuide.tsx", "ui/src/types.d.ts"]) expect(isUiSourcePath(file)).toBe(false);
  });
  it("requires an explicit baseline and rejects unknown options", () => {
    expect(() => runUiSourceChanges([])).toThrow("Usage:");
    expect(() => runUiSourceChanges(["--base"])).toThrow("incomplete option");
    expect(() => runUiSourceChanges(["--write"])).toThrow("Unknown");
  });
});
