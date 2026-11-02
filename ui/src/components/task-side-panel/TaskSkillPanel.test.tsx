// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { companySkillsApi } from "@/api/companySkills";
import { TaskSkillPanel } from "./TaskSkillPanel";
import { i18n } from "@/i18n";

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

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  await i18n.changeLanguage("en");
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

  it("reactively translates the loaded panel without translating skill content or refetching", async () => {
    vi.mocked(companySkillsApi.detail).mockResolvedValue(skill);
    renderPanel();
    await vi.waitFor(() => expect(container.textContent).toContain("Revision 2"));
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container.textContent).toContain("Редакция 2");
    expect(container.textContent).toContain("Открыть в студии навыков");
    expect(container.textContent).toContain("Инструкции навыка");
    for (const raw of ["Release helper", "release-helper", "Ships releases.", "# Instructions", "Run the release."]) {
      expect(container.textContent).toContain(raw);
    }
    expect(container.textContent).not.toContain("name: release-helper");
    act(() => (container.querySelector("button") as HTMLButtonElement).click());
    expect(navigate).toHaveBeenCalledWith("/skills/studio/skill-1");
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(container.textContent).toContain("Open in Skill Studio");
    expect(companySkillsApi.detail).toHaveBeenCalledExactlyOnceWith("company-1", "skill-1");
  });

  it("translates loading reactively", async () => {
    vi.mocked(companySkillsApi.detail).mockImplementation(() => new Promise(() => {}));
    renderPanel();
    expect(container.textContent).toContain("Loading skill…");
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Загружаем навык…");
  });

  it.each([[403, "У вас нет доступа к этому навыку.", "alert"], [404, "Навык больше недоступен.", "status"]])("preserves the non-retryable %s state in Russian", async (status, text, role) => {
    await i18n.changeLanguage("ru");
    vi.mocked(companySkillsApi.detail).mockRejectedValue(new ApiError("raw API diagnostic", Number(status), null));
    renderPanel();
    await vi.waitFor(() => expect(container.querySelector(`[role="${role}"]`)?.textContent).toContain(text));
    expect(container.querySelector("button")).toBeNull();
  });

  it("retains transient retry behavior and localizes pending and empty states", async () => {
    await i18n.changeLanguage("ru");
    let finish!: (value: Awaited<ReturnType<typeof companySkillsApi.detail>>) => void;
    vi.mocked(companySkillsApi.detail).mockRejectedValueOnce(new Error("offline")).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    renderPanel();
    await vi.waitFor(() => expect(container.textContent).toContain("Не удалось загрузить навык."));
    act(() => (container.querySelector("button") as HTMLButtonElement).click());
    await vi.waitFor(() => expect(container.textContent).toContain("Загружаем навык…"));
    expect(container.querySelector("button")).toBeNull();
    await act(async () => finish({ ...(skill as object), markdown: "", currentVersion: null } as Awaited<ReturnType<typeof companySkillsApi.detail>>));
    await vi.waitFor(() => expect(container.textContent).toContain("В навыке нет инструкций."));
    expect(container.textContent).toContain("Текущая версия");
    expect(companySkillsApi.detail).toHaveBeenCalledTimes(2);
  });
});
