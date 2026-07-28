// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ShadowRuntimeBanner } from "./ShadowRuntimeBanner";

describe("ShadowRuntimeBanner", () => {
  it("renders the shared-db runtime warning for shadow servers", () => {
    const markup = renderToStaticMarkup(
      <ShadowRuntimeBanner
        runtime={{
          role: "shadow",
          shadowSourceApi: "http://127.0.0.1:3100",
          shadowSourcePort: 3100,
          targetPort: 3101,
          scheduler: { enabled: false, owner: "source_api" },
          backups: { enabled: false, owner: "source_api" },
        }}
      />,
    );

    expect(markup).toContain("Shadow dev server on 3101, using 3100 database, background schedulers disabled.");
    expect(markup).toContain("Scheduler and backup ownership stay with the source server.");
  });

  it("does not render for primary runtimes", () => {
    expect(renderToStaticMarkup(
      <ShadowRuntimeBanner
        runtime={{
          role: "primary",
          shadowSourceApi: null,
          shadowSourcePort: null,
          targetPort: 3100,
          scheduler: { enabled: true, owner: "local" },
          backups: { enabled: true, owner: "local" },
        }}
      />,
    )).toBe("");
  });
});
