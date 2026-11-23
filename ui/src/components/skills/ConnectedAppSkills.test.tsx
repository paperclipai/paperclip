// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyMcpSkill } from "@paperclipai/shared";
import { ConnectedAppSkillsList, connectedAppSkillNote } from "./ConnectedAppSkills";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const skill: CompanyMcpSkill = {
  id: "s-1", connectionId: "c-1", appName: "Hugging Face", name: "hf-cli", description: "Hub CLI",
  skillUri: "skill://hf-cli/SKILL.md", status: "pending_review", statusReason: "new",
  manifestDigest: `sha256:${"a".repeat(64)}`, fileCount: 2, totalBytes: 2048,
  requestedTools: ["Bash(hf:*)"], allowedToolsApproved: false, nameCollision: false,
  reviewedAt: null, lastSeenAt: "2026-11-12T00:00:00.000Z",
};

describe("ConnectedAppSkillsList", () => {
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

  it("renders nothing when no app publishes skills", () => {
    act(() => root.render(<ConnectedAppSkillsList skills={[]} />));
    expect(container.innerHTML).toBe("");
  });

  it("approves with the requested tools only when the board ticks them", () => {
    const onApprove = vi.fn();
    act(() => root.render(<ConnectedAppSkillsList skills={[skill]} onApprove={onApprove} onDecline={vi.fn()} />));
    expect(container.textContent).toContain("from Hugging Face");
    expect(container.textContent).toContain("Needs review");
    const approve = [...container.querySelectorAll("button")].find((button) => button.textContent === "Approve")!;
    act(() => approve.click());
    expect(onApprove).toHaveBeenLastCalledWith(skill, false);
    act(() => (container.querySelector("[role=checkbox]") as HTMLButtonElement).click());
    act(() => approve.click());
    expect(onApprove).toHaveBeenLastCalledWith(skill, true);
  });

  it("never shows or approves against instructions for an older version", () => {
    const onApprove = vi.fn();
    const stale = { skillId: skill.id, manifestDigest: `sha256:${"b".repeat(64)}`, markdown: "old instructions" };
    act(() => root.render(<ConnectedAppSkillsList skills={[skill]} preview={stale} onPreview={vi.fn()} onApprove={onApprove} onDecline={vi.fn()} />));
    expect(container.textContent).not.toContain("old instructions");
    const approve = [...container.querySelectorAll("button")].find((button) => button.textContent === "Approve")!;
    expect(approve.disabled).toBe(true);
    act(() => root.render(<ConnectedAppSkillsList skills={[skill]} preview={{ ...stale, manifestDigest: skill.manifestDigest!, markdown: "current" }} onPreview={vi.fn()} onApprove={onApprove} onDecline={vi.fn()} />));
    expect(container.textContent).toContain("current");
    expect(([...container.querySelectorAll("button")].find((button) => button.textContent === "Approve")!).disabled).toBe(false);
  });

  it("explains declined-by-default and changed skills without offering approval for unavailable ones", () => {
    const dynamic = { ...skill, id: "s-2", status: "unavailable" as const, statusReason: "dynamic" as const, manifestDigest: null, fileCount: null, totalBytes: null };
    act(() => root.render(<ConnectedAppSkillsList skills={[dynamic]} onApprove={vi.fn()} onDecline={vi.fn()} />));
    expect(container.textContent).toContain("Paperclip can't check its content");
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).not.toContain("Approve");
    expect(connectedAppSkillNote({ ...skill, statusReason: "changed" })).toContain("approve the new version");
  });
});
