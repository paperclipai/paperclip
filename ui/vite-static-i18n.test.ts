import { describe, expect, it } from "vitest";

import { staticUiLocalization } from "./vite-static-i18n";

describe("staticUiLocalization", () => {
  it("wraps static UI copy without touching dynamic user data", async () => {
    const plugin = staticUiLocalization();
    const source = `
      export function Card({ company }) {
        return <section title="Company settings"><h1>Welcome</h1><p>{company.name}</p></section>;
      }
    `;
    const transform = plugin.transform;
    if (!transform) throw new Error("transform hook missing");
    const handler = typeof transform === "function" ? transform : transform.handler;
    const result = await handler.call({} as never, source, "/repo/ui/src/Card.tsx", {} as never);
    const code = typeof result === "string" ? result : result?.code;

    expect(code).toContain('__paperclipTranslateUiLiteral("Company settings")');
    expect(code).toContain('__paperclipTranslateUiLiteral("Welcome")');
    expect(code).toContain("__paperclipUseUiLiteralLocale();");
    expect(code).toContain("{company.name}");
    expect(code).not.toContain("__paperclipTranslateUiLiteral(company.name)");
  });

  it("does not translate state or adapter identifiers used by rendered conditions", async () => {
    const plugin = staticUiLocalization();
    const source = `
      export function Wizard({ missionPath, adapterType }) {
        return <section>
          {missionPath === "questionnaire" && <p>Answer a few questions</p>}
          {missionPath === "direct" ? <p>Type it directly</p> : null}
          {adapterType === "codex_local" ? "Codex is ready" : "Choose an adapter"}
        </section>;
      }
    `;
    const transform = plugin.transform;
    if (!transform) throw new Error("transform hook missing");
    const handler = typeof transform === "function" ? transform : transform.handler;
    const result = await handler.call({} as never, source, "/repo/ui/src/Wizard.tsx", {} as never);
    const code = typeof result === "string" ? result : result?.code;

    expect(code).toContain('missionPath === "questionnaire"');
    expect(code).toContain('missionPath === "direct"');
    expect(code).toContain('adapterType === "codex_local"');
    expect(code).not.toContain('__paperclipTranslateUiLiteral("questionnaire")');
    expect(code).not.toContain('__paperclipTranslateUiLiteral("direct")');
    expect(code).not.toContain('__paperclipTranslateUiLiteral("codex_local")');
    expect(code).toContain('__paperclipTranslateUiLiteral("Answer a few questions")');
    expect(code).toContain('__paperclipTranslateUiLiteral("Type it directly")');
    expect(code).toContain('__paperclipTranslateUiLiteral("Codex is ready")');
    expect(code).toContain('__paperclipTranslateUiLiteral("Choose an adapter")');
  });
});
