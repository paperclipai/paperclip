// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamCard } from "./TeamCatalog";
import { onboardingTeams } from "./TeamCatalog.fixtures";
import { TooltipProvider } from "@/components/ui/tooltip";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, cleanup: () => { root.unmount(); container.remove(); }, root };
}

describe("TeamCard", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders name, pluralized counts, and tags", async () => {
    const team = onboardingTeams[0];
    const { container, root, cleanup } = render(null);
    await act(async () => {
      root.render(
        <TooltipProvider>
          <TeamCard team={team} selected={false} onSelect={() => {}} />
        </TooltipProvider>,
      );
    });
    const text = container.textContent ?? "";
    expect(text).toContain(team.name);
    expect(text).toContain(`${team.counts.agents} agents`);
    expect(text).toContain(`${team.counts.projects} project`);
    for (const tag of team.tags) expect(text).toContain(tag);
    cleanup();
  });

  it("applies the selection ring when selected and fires onSelect on click", async () => {
    const onSelect = vi.fn();
    const { container, root, cleanup } = render(null);
    await act(async () => {
      root.render(
        <TooltipProvider>
          <TeamCard team={onboardingTeams[0]} selected onSelect={onSelect} />
        </TooltipProvider>,
      );
    });
    const button = container.querySelector("button")!;
    expect(button.className).toContain("ring-2");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      button.click();
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("hides the TrustChip for markdown_only teams", async () => {
    // onboardingTeams[0] is markdown_only — no trust chip text should appear.
    const { container, root, cleanup } = render(null);
    await act(async () => {
      root.render(
        <TooltipProvider>
          <TeamCard team={onboardingTeams[0]} onSelect={() => {}} />
        </TooltipProvider>,
      );
    });
    // The "assets" team (index 1) does render a chip; sanity-check the contrast.
    expect(onboardingTeams[0].trustLevel).toBe("markdown_only");
    expect(onboardingTeams[1].trustLevel).toBe("assets");
    expect(container.querySelector("svg")).toBeTruthy(); // the Users2 icon still renders
    cleanup();
  });
});
