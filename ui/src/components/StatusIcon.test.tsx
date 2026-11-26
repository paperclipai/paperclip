// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { StatusIcon } from "./StatusIcon";

it.each(["in_review", "in_progress"])("animates only the current in-progress glyph when picking a status from %s", async (status) => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    await act(async () => root.render(<StatusIcon status={status} onChange={vi.fn()} />));
    const trigger = host.querySelector("button")!;
    await act(async () => trigger.click());

    const option = document.querySelector('[role="dialog"] svg[aria-label="In Progress"]');
    expect(option).toBeTruthy();
    const isInProgress = status === "in_progress";
    expect(option!.classList.contains("motion-safe:animate-spin")).toBe(isInProgress);
    expect(trigger.querySelector("svg")!.classList.contains("motion-safe:animate-spin")).toBe(isInProgress);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
