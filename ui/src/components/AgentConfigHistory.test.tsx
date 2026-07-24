// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfigRevision } from "@paperclipai/shared";
import { AgentConfigHistory, revisionDiff } from "./AgentConfigHistory";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const revision = {
  id: "revision-1", companyId: "company-1", agentId: "agent-1", createdByAgentId: null, createdByUserId: "user-1",
  source: "patch", rolledBackFromRevisionId: null, changedKeys: ["adapterConfig.model"],
  beforeConfig: { adapterConfig: { model: "gpt-5" } }, afterConfig: { adapterConfig: { model: "gpt-5.5" } },
  createdAt: new Date("2026-07-22T12:00:00Z"),
} satisfies AgentConfigRevision;

describe("AgentConfigHistory", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("requires confirmation before restoring a revision", () => {
    const onRestore = vi.fn();
    flushSync(() => root.render(<AgentConfigHistory revisions={[revision]} onRestore={onRestore} restoring={false} />));

    const restoreButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Restore");
    flushSync(() => restoreButton?.click());
    expect(document.body.textContent).toContain("Restore this configuration?");
    expect(document.body.textContent).toContain("gpt-5");
    expect(onRestore).not.toHaveBeenCalled();

    const confirmButton = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Restore configuration");
    flushSync(() => confirmButton?.click());
    expect(onRestore).toHaveBeenCalledWith("revision-1");
  });

  it("expands legacy whole-object changes into field-level rows", () => {
    const legacyRevision = {
      ...revision,
      changedKeys: ["adapterConfig"],
      beforeConfig: { adapterConfig: { effort: "high", graceSec: 15, headers: { version: "1" } } },
      afterConfig: { adapterConfig: { effort: "high", graceSec: 42, headers: { version: "2" } } },
    } satisfies AgentConfigRevision;

    expect(revisionDiff(legacyRevision)).toEqual([
      { key: "adapterConfig.graceSec", before: 15, after: 42 },
      { key: "adapterConfig.headers.version", before: "1", after: "2" },
    ]);
  });

  it("uses the same human-readable labels as the review changes popover", () => {
    const labelRevision = {
      ...revision,
      changedKeys: ["adapterConfig.graceSec"],
      beforeConfig: { adapterConfig: { graceSec: 15 } },
      afterConfig: { adapterConfig: { graceSec: 42 } },
    } satisfies AgentConfigRevision;
    flushSync(() => root.render(<AgentConfigHistory revisions={[labelRevision]} onRestore={vi.fn()} restoring={false} />));

    const viewDiffButton = container.querySelector<HTMLButtonElement>('button[aria-label="View revision diff"]');
    flushSync(() => viewDiffButton?.click());

    expect(document.body.textContent).toContain("Grace Sec");
    expect(document.body.textContent).toContain("Grace Sec1542");
  });
});
