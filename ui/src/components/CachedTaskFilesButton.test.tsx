// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CachedTaskFilesButton } from "./CachedTaskFilesButton";

vi.mock("@/components/WorkFolderBrowser", () => ({
  WorkFolderBrowser: ({ owner, readOnly, allowTrashActions }: { owner: unknown; readOnly: boolean; allowTrashActions: boolean }) =>
    <div data-testid="browser">{JSON.stringify({ owner, readOnly, allowTrashActions })}</div>,
}));

const issue = { id: "task-1", companyId: "company-1", projectId: "project-1", assigneeAgentId: "agent-1", responsibleUserId: "user-1" };
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = "";
});
async function open(context: ComponentProps<typeof CachedTaskFilesButton>["issue"] = issue, currentUserId = "user-1") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<CachedTaskFilesButton issue={context} currentUserId={currentUserId} />));
  await act(async () => container.querySelector("button")!.click());
}
async function select(label: string) {
  const tab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((node) => node.textContent === label)!;
  await act(async () => { tab.focus(); });
}
describe("cached task context inspector", () => {
  it("uses each task binding and allows trash actions without upload or refresh controls", async () => {
    await open();
    for (const [label, scope, ownerId] of [["Task", "task", "task-1"], ["Project", "project", "project-1"], ["Agent", "agent", "agent-1"], ["Responsible user", "user", "user-1"]]) {
      await select(label!);
      expect(JSON.parse(document.querySelector('[data-testid="browser"]')!.textContent!)).toEqual({ owner: { companyId: "company-1", scope, ownerId }, readOnly: true, allowTrashActions: true });
    }
    expect(document.body.textContent).toContain("not the live sandbox filesystem");
  });
  it("does not mount a private-user browser for a different viewer", async () => {
    await open(issue, "another-user");
    await select("Responsible user");
    expect(document.body.textContent).toContain("private to the responsible user");
    expect(document.querySelector('[data-testid="browser"]')).toBeNull();
  });
  it("leaves missing bindings unbound without selecting a substitute owner", async () => {
    await open({ ...issue, projectId: null, assigneeAgentId: null, responsibleUserId: null });
    for (const label of ["Project", "Agent", "Responsible user"]) {
      await select(label);
      expect(document.body.textContent).toContain("empty and unbound");
      expect(document.querySelector('[data-testid="browser"]')).toBeNull();
    }
  });
});
