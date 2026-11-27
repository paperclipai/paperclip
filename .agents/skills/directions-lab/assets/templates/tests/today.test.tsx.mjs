export default (ctx) => `// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installApiStub } from "./api-stub";
import "./api-routes";
import { kit } from "./directions/today";
import { ${ctx.surfaces.map((surface) => surface.fixture).join(", ")} } from "./fixtures";
import { Slot } from "./frames/Slot";
import { createLabQueryClient, LabProviders } from "./providers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function settle(client: ReturnType<typeof createLabQueryClient>) {
  await act(async () => {
    await Promise.resolve();
  });
  for (let round = 0; round < 50 && client.isFetching() > 0; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

describe("the Today kit on the lab fixtures", () => {
  let container: HTMLDivElement;
  let root: Root;
  let restoreFetch: () => void;

  beforeEach(() => {
    restoreFetch = installApiStub();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreFetch();
  });
${ctx.surfaces
  .map(
    (surface) => `
  it("renders something inside the ${surface.id} slot", async () => {
    const client = createLabQueryClient();
    await act(async () => {
      root.render(
        <LabProviders client={client}>
          <Slot kit={kit}>
            <kit.${surface.body} items={${surface.fixture}} />
          </Slot>
        </LabProviders>,
      );
    });
    await settle(client);
    const slot = container.querySelector('[data-direction="today"]');
    expect(slot).not.toBeNull();
    expect(slot?.children.length ?? 0).toBeGreaterThan(0);
    expect(slot?.textContent?.trim()).not.toBe("");
    client.clear();
  });`,
  )
  .join("\n")}
});
`;
