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
    expect(code).toContain("{company.name}");
    expect(code).not.toContain("__paperclipTranslateUiLiteral(company.name)");
  });
});
