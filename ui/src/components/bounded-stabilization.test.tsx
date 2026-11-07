// @vitest-environment jsdom
// Mounted regression derived from Work/FinalReview's independent counterexamples.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { CommentThread } from "./CommentThread";
import { DeleteFolderDialog } from "./folders/FolderControls";
vi.mock("@/components/MarkdownEditor", () => ({ MarkdownEditor: () => null }));
vi.mock("@/components/MarkdownBody", () => ({ MarkdownBody: () => null }));
vi.mock("@/plugins/slots", () => ({ PluginSlotOutlet: () => null }));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = "";
  await i18n.changeLanguage("en");
});
for (const count of [0, 1, 2]) {
  it(`preserves timeline count ${count} through mounted en/zh-CN/en roundtrip`, async () => {
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    const comments = Array.from({ length: count }, (_, n) => ({ id: `c-${n}`, body: "user content", createdAt: "2026-01-01T00:00:00Z", authorUserId: "user-1" }));
    await act(async () => root!.render(<MemoryRouter><CommentThread comments={comments as never} onAdd={async () => {}} composerDisabledReason="fixture" /></MemoryRouter>));
    for (const locale of ["en", "zh-CN", "en"]) {
      await act(async () => { await i18n.changeLanguage(locale); });
      expect(host.querySelector("h3")?.textContent).toBe(locale === "en" ? `Timeline (${count})` : `时间线（${count}）`);
    }
  });
  for (const itemLabelPlural of ["skills", "routines"]) {
    it(`preserves deletion count ${count} and ${itemLabelPlural} display label through mounted locale roundtrip`, async () => {
      const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
      const folder = { id: "folder-id", name: "user folder", kind: itemLabelPlural === "skills" ? "skill" : "routine", itemCount: count };
      const before = JSON.stringify(folder); const onConfirm = vi.fn();
      await act(async () => root!.render(<DeleteFolderDialog open folder={folder as never} itemLabelPlural={itemLabelPlural} onOpenChange={() => {}} onConfirm={onConfirm} />));
      for (const locale of ["en", "zh-CN", "en"]) {
        await act(async () => { await i18n.changeLanguage(locale); });
        const description = document.querySelector('[data-slot="alert-dialog-description"]')?.textContent;
        expect(description).toBe(locale === "en"
          ? `The ${count} ${itemLabelPlural} in this folder won't be deleted. They'll move to Unfiled.`
          : `此文件夹中的 ${count} 个${itemLabelPlural === "skills" ? "技能" : "例行任务"}不会被删除，而会移至“未归类”。`);
      }
      expect(JSON.stringify(folder)).toBe(before);
      const button = [...document.querySelectorAll("button")].find(b => b.textContent === "Delete folder")!;
      await act(async () => button.click()); expect(onConfirm).toHaveBeenCalledOnce();
    });
  }
}
it("preserves pending/null-folder guards and unknown item display text", async () => {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const onConfirm = vi.fn();
  for (const pending of [true, false]) {
    await act(async () => root!.render(<DeleteFolderDialog open folder={null} itemLabelPlural="custom items" pending={pending} onOpenChange={() => {}} onConfirm={onConfirm} />));
    expect(document.querySelector('[data-slot="alert-dialog-description"]')?.textContent).toContain("0 custom items");
    const button = [...document.querySelectorAll("button")].find(b => /Delete folder|Deleting/.test(b.textContent ?? ""))!;
    expect(button.disabled).toBe(true); await act(async () => button.click());
  }
  expect(onConfirm).not.toHaveBeenCalled();
});
