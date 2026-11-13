// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { queryKeys } from "../../lib/queryKeys";
import { AgentSkillsTab } from "./AgentSkillsTab";
import { TooltipProvider } from "../../components/ui/tooltip";

vi.mock("@/lib/router", () => ({ Link: ({ children }: { children: unknown }) => children }));

import { toDesiredSkillPayload } from "./AgentSkillsTab";

describe("toDesiredSkillPayload", () => {
  const skillKey = "paperclipai/paperclip/paperclip";
  const versionId = "22222222-2222-4222-8222-222222222222";

  it("includes saved version pins while beta skills are enabled", () => {
    expect(toDesiredSkillPayload([skillKey], { [skillKey]: versionId }, true)).toEqual([
      { key: skillKey, versionId },
    ]);
  });

  it("omits saved version pins while beta skills are disabled", () => {
    expect(toDesiredSkillPayload([skillKey], { [skillKey]: versionId }, false)).toEqual([
      skillKey,
    ]);
  });
});


const syncSkills = vi.hoisted(() => vi.fn());
vi.mock("../../api/agents", () => ({ agentsApi: { syncSkills } }));
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.clearAllMocks();
});

function setup(desiredSkills = ["design"], installedSkills = desiredSkills) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const agent = { id: "agent-1", urlKey: "agent-1", companyId: "company-1", adapterType: "codex_local", adapterConfig: {} } as Agent;
  const snapshot = { adapterType: "codex_local", supported: true, mode: "ephemeral", desiredSkills, installedSkills, entries: [], warnings: [] };
  client.setQueryData(queryKeys.agents.skills(agent.id), snapshot);
  client.setQueryData(queryKeys.companySkills.list(agent.companyId), [
    { id: "design", key: "design", name: "Design guide", description: "UI tokens", categories: ["design"], sourceKind: "bundled", sourceType: "bundled" },
    { id: "browser", key: "browser", name: "Browser automation", description: "Inspect pages", categories: ["testing"], authorName: "Acme", sourceKind: "bundled", sourceType: "bundled" },
  ]);
  client.setQueryData(queryKeys.instance.experimentalSettings, { enableBetaSkills: false });
  syncSkills.mockImplementation(async (_id, desired, _mode, _company, installed) => ({ ...snapshot, desiredSkills: desired, installedSkills: installed }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (nextAgent = agent) => flushSync(() => root.render(createElement(QueryClientProvider, { client }, createElement(TooltipProvider, { children: createElement(AgentSkillsTab, { agent: nextAgent, companyId: agent.companyId }) }))));
  render();
  cleanups.push(() => { flushSync(() => root.unmount()); client.clear(); container.remove(); });
  const search = (value: string) => {
    const input = container.querySelector("input")!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  return { client, agent, snapshot, container, render, search, button };
}

it("keeps installed skills visible and shows library rows only for a nonempty search", () => {
  const { container, search, button } = setup();
  expect(button("Disable Design guide")).not.toBeNull();
  expect(container.textContent).not.toContain("Browser automation");
  search("   ");
  expect(container.textContent).not.toContain("Browser automation");
  search("acme");
  expect(button("Add Browser automation")).not.toBeNull();
  expect(button("Disable Design guide")).not.toBeNull();
  search("nothing matches");
  expect(container.textContent).toContain("No library skills match your search");
  expect(button("Disable Design guide")).not.toBeNull();
  button("Clear skill search")!.click();
});

it("adds a result and retains it when disabled, saved, and mounted again", async () => {
  const { container, search, button, render, client, agent, snapshot } = setup();
  search("browser");
  flushSync(() => button("Add Browser automation")!.click());
  expect(button("Disable Browser automation")).not.toBeNull();
  expect(button("Add Browser automation")).toBeNull();
  // Add and disable inside the debounce period must still save membership.
  flushSync(() => button("Disable Browser automation")!.click());
  await vi.waitFor(() => expect(syncSkills).toHaveBeenCalledWith(agent.id, ["design"], "replace", agent.companyId, ["design", "browser"]));
  await vi.waitFor(() => expect(container.textContent).toContain("Saved"));
  expect(button("Enable Browser automation")).not.toBeNull();
  client.setQueryData(queryKeys.agents.skills("agent-2"), { ...snapshot, installedSkills: ["design", "browser"] });
  render({ ...agent, id: "agent-2" });
  expect(button("Enable Browser automation")).not.toBeNull();
  expect(container.querySelector("input")!.value).toBe("");
  flushSync(() => button("Enable Browser automation")!.click());
  expect(button("Disable Browser automation")).not.toBeNull();
});

it("hydrates disabled membership without filtering it with search", () => {
  const { search, button } = setup([], ["design"]);
  expect(button("Enable Design guide")).not.toBeNull();
  search("browser");
  expect(button("Enable Design guide")).not.toBeNull();
  expect(button("Add Design guide")).toBeNull();
});

it("removes a connector from editable results when its automatic assignment arrives", async () => {
  const { client, agent, snapshot, button, search, container } = setup();
  search("browser");
  expect(button("Add Browser automation")).not.toBeNull();
  client.setQueryData(queryKeys.agents.skills(agent.id), { ...snapshot, desiredSkills: ["design", "browser"], entries: [{ key: "browser", runtimeName: "Browser automation", desired: true, managed: true, readOnly: true, state: "configured" }] });
  await vi.waitFor(() => {
    expect(button("Add Browser automation")).toBeNull();
    expect(button("Disable Browser automation")).toBeNull();
    expect(container.textContent).toContain("Automatic and detected skills");
  });
});

it("keeps a failed save visible without retrying the same payload", async () => {
  const { search, button, container } = setup();
  syncSkills.mockRejectedValue(new Error("Cannot save skills"));
  search("browser");
  flushSync(() => button("Add Browser automation")!.click());
  await vi.waitFor(() => expect(container.textContent).toContain("Couldn’t save"));
  await new Promise((resolve) => setTimeout(resolve, 550));
  expect(syncSkills).toHaveBeenCalledTimes(1);
  expect(button("Disable Browser automation")).not.toBeNull();
});

it("preserves edits made while a save is in flight", async () => {
  const { search, button, snapshot } = setup();
  let finishSave!: (value: unknown) => void;
  syncSkills.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
  search("browser");
  flushSync(() => button("Add Browser automation")!.click());
  await vi.waitFor(() => expect(syncSkills).toHaveBeenCalledTimes(1));
  flushSync(() => button("Disable Design guide")!.click());
  finishSave({ ...snapshot, desiredSkills: ["design", "browser"], installedSkills: ["design", "browser"] });
  await vi.waitFor(() => expect(syncSkills).toHaveBeenLastCalledWith("agent-1", ["browser"], "replace", "company-1", ["design", "browser"]));
  expect(button("Enable Design guide")).not.toBeNull();
});

it("does not save an old agent's debounce to the newly selected agent", async () => {
  const { search, button, render, client, agent, snapshot } = setup();
  search("browser");
  flushSync(() => button("Add Browser automation")!.click());
  client.setQueryData(queryKeys.agents.skills("agent-2"), { ...snapshot, desiredSkills: [], installedSkills: [] });
  render({ ...agent, id: "agent-2" });
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect(syncSkills).not.toHaveBeenCalled();
  expect(button("Disable Browser automation")).toBeNull();
});

it("indexes a large library once and does not remap it on each search", async () => {
  const catalog = await vi.importActual<{ default: { skills: Array<{ name: string; key: string; description: string; slug: string; category: string }> } }>("../../../../packages/skills-catalog/generated/catalog.json");
  const { client, agent, search, container } = setup();
  const skills = Array.from({ length: 40 }, (_, copy) => catalog.default.skills.map((skill) => ({
    ...skill, id: `${copy}-${skill.key}`, key: `${copy}/${skill.key}`, categories: [skill.category], sourceType: "bundled", sourceKind: "bundled",
  }))).flat();
  let keyReads = 0;
  const counted = skills.map((skill) => ({ ...skill, get key() {
    if (++keyReads > skills.length * 20) throw new Error("Library repeatedly scanned or remapped");
    return skill.key;
  } }));
  client.setQueryData(queryKeys.companySkills.list(agent.companyId), counted);
  await vi.waitFor(() => expect(container.textContent).toContain("No skills installed"));
  const mappedReads = keyReads;
  search("nonexistent skill");
  search("another missing skill");
  expect(keyReads).toBe(mappedReads);
  expect(container.querySelectorAll('[role="switch"]')).toHaveLength(0);
});

it("keeps installed and Add controls disabled for an unsupported adapter", () => {
  const { client, agent, snapshot, render, search, button, container } = setup();
  client.setQueryData(queryKeys.agents.skills("unsupported"), { ...snapshot, mode: "unsupported", supported: false });
  render({ ...agent, id: "unsupported", adapterType: "openclaw_gateway" });
  search("browser");
  expect(button("Disable Design guide")!.disabled).toBe(true);
  expect(button("Add Browser automation")!.disabled).toBe(true);
  expect(container.textContent).toContain("Visit your OpenClaw instance");
});

it("blocks adding the legacy operational skill on native Runner", () => {
  const { client, agent, snapshot, render, search, button } = setup();
  client.setQueryData(queryKeys.companySkills.list(agent.companyId), [{ id: "core", key: "paperclipai/paperclip/paperclip", name: "Paperclip", categories: [], sourceType: "bundled" }]);
  client.setQueryData(queryKeys.agents.skills("native"), { ...snapshot, desiredSkills: [], installedSkills: [] });
  render({ ...agent, id: "native", adapterType: "paperclip_runner" });
  search("paperclip");
  expect(button("Add Paperclip")!.disabled).toBe(true);
});
