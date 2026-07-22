// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfigRevision } from "@paperclipai/shared";
import { AgentConfigHistory } from "./AgentConfigHistory";

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
});
