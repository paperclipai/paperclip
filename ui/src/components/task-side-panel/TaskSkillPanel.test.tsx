// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { companySkillsApi } from "@/api/companySkills";
import { TaskSkillPanel } from "./TaskSkillPanel";

const navigate = vi.fn();
vi.mock("@/api/companySkills", () => ({ companySkillsApi: { detail: vi.fn() } }));
vi.mock("@/lib/router", () => ({ useNavigate: () => navigate }));
vi.mock("@/components/MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => <div>{children}</div> }));

const skill = { id: "skill-1", name: "Release helper", slug: "release-helper", description: "Ships releases.", markdown: "---\nname: release-helper\ndescription: Ships releases.\n---\n\n# Instructions\n\nRun the release.", currentVersion: { revisionNumber: 2 } } as never;
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let client: QueryClient;

function renderPanel() {
  act(() => root.render(<QueryClientProvider client={client}><TaskSkillPanel companyId="company-1" skillId="skill-1" /></QueryClientProvider>));
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
});

describe("TaskSkillPanel", () => {
  it("renders a missing state for 404", async () => {
    vi.mocked(companySkillsApi.detail).mockRejectedValue(new ApiError("missing", 404, null));
    renderPanel();
    await vi.waitFor(() => expect(container.textContent).toContain("Skill no longer available"));
    expect(container.querySelector("button")).toBeNull();
  });

  it("offers retry for transient errors", async () => {
    vi.mocked(companySkillsApi.detail).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(skill);
    renderPanel();
    await vi.waitFor(() => expect(container.textContent).toContain("The skill could not be loaded"));
    act(() => (container.querySelector("button") as HTMLButtonElement).click());
    await vi.waitFor(() => expect(container.textContent).toContain("Release helper"));
    expect(container.textContent).toContain("Run the release.");
    expect(container.textContent).not.toContain("name: release-helper");
  });

  it("opens the current skill in Skill Studio", async () => {
    vi.mocked(companySkillsApi.detail).mockResolvedValue(skill);
    renderPanel();
    await vi.waitFor(() => expect(container.textContent).toContain("Release helper"));
    act(() => (container.querySelector("button") as HTMLButtonElement).click());
    expect(navigate).toHaveBeenCalledWith("/skills/studio/skill-1");
  });
});
