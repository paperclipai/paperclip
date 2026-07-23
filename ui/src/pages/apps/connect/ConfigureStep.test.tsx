// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_DEFINITIONS } from "@paperclipai/shared";
import { ConfigureStep } from "./ConfigureStep";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(cb: () => void) {
  flushSync(cb);
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function bySlug(slug: string) {
  const def = APP_DEFINITIONS.find((d) => d.slug === slug);
  if (!def) throw new Error(`missing catalog def: ${slug}`);
  return def;
}

describe("ConfigureStep grammar", () => {
  it("renders every Wave-1 definition × method without throwing", () => {
    for (const def of APP_DEFINITIONS) {
      for (const method of def.methods) {
        expect(() =>
          act(() => root.render(<ConfigureStep def={def} method={method} />)),
        ).not.toThrow();
        // Every method surfaces the specific CTA (never a bare "Create").
        expect(container.textContent).toContain(def.name);
      }
    }
  });

  it("branded BYO OAuth (linear) shows guidance + ownership footer", () => {
    const def = bySlug("linear");
    act(() => root.render(<ConfigureStep def={def} method={def.methods[0]!} />));
    expect(container.textContent).toMatch(/responsible for managing|authorize Paperclip/);
  });

  it("api-key generic shows multi-key add-key affordance", () => {
    const def = bySlug("api-key-generic");
    const apiKeyMethod = def.methods.find((m) => m.auth === "api_key") ?? def.methods[0]!;
    act(() => root.render(<ConfigureStep def={def} method={apiKeyMethod} />));
    expect(container.textContent).toContain("Add key");
  });

  it("generic OAuth exposes OIDC discovery", () => {
    const def = bySlug("oauth-generic");
    const oauthMethod = def.methods.find((m) => m.auth === "oauth") ?? def.methods[0]!;
    act(() => root.render(<ConfigureStep def={def} method={oauthMethod} />));
    expect(container.textContent).toMatch(/Discover|Server URL/);
  });

  it("BYO OAuth with >1 ownership mode renders ownership tabs", () => {
    // Wave-1 branded/generic OAuth defs ship ownershipModes ['customer','dcr'].
    const def = bySlug("slack");
    act(() => root.render(<ConfigureStep def={def} method={def.methods[0]!} />));
    expect(container.textContent).toContain("Credential ownership");
    expect(container.textContent).toMatch(/Your own credentials|Dynamic registration/);
  });

  it("managed ownership states the Paperclip consent-screen branding exactly", () => {
    const def = {
      ...bySlug("slack"),
      ownershipAvailability: { platform_shared: true },
    };
    act(() => root.render(<ConfigureStep def={def} method={def.methods[0]!} />));
    expect(container.textContent).toContain(
      "You authorize Paperclip's Slack app; the consent screen will show Paperclip.",
    );
  });
});
