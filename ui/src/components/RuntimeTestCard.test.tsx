// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { RuntimeTestCard } from "./RuntimeTestCard";

it("shows the installation repair directly on a missing runtime test", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const message = "The ACPX claude runtime is incomplete: required package @agentclientprotocol/claude-agent-acp is missing. Reinstall or rebuild Paperclip with its bundled provider dependencies, restart the server, then test the agent's runtime before retrying.";
  try {
    flushSync(() => root.render(<RuntimeTestCard state="fail" onTest={() => {}} result={{
      adapterType: "paperclip_runner", status: "fail", testedAt: "2026-10-11T11:19:14Z",
      checks: [{ code: "acpx_runtime_package_missing", level: "error", message }],
    }} />));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Runtime missing");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(message);
    expect(container.textContent).not.toContain("Check your model and provider connection");
  } finally {
    flushSync(() => root.unmount());
  }
});
