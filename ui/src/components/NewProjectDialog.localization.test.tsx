// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { projectsApi } from "../api/projects";
import { NewProjectForm } from "./NewProjectDialog";

vi.mock("../api/projects", () => ({ projectsApi: { create: vi.fn() } }));
vi.mock("./ProjectRepositoryInput", () => ({ ProjectRepositoryInput: () => null, repositoryOptionsKey: (id: string) => ["repositories", id] }));
vi.mock("@/features/connections/ConnectionSetupFlow", () => ({ ConnectionSetupFlow: () => null }));
vi.mock("./ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.createElement("div");
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  host.replaceChildren();
  await i18n.changeLanguage("en");
  vi.clearAllMocks();
});

it("keeps a mounted project draft and API discriminators unchanged when switching to Chinese", async () => {
  await i18n.changeLanguage("en");
  vi.mocked(projectsApi.create).mockResolvedValue({ id: "project-id" } as Awaited<ReturnType<typeof projectsApi.create>>);
  root = createRoot(host);
  await act(async () => root?.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}><NewProjectForm companyId="company-1" onClose={vi.fn()} /></QueryClientProvider>));
  const input = host.querySelector<HTMLInputElement>("input")!;
  const name = "Project Alpha / 用户内容 <example>";
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(host.querySelector("input")).toBe(input);
  expect(input.value).toBe(name);
  expect(input.getAttribute("aria-label")).toBe("项目名称");
  expect(host.textContent).toContain("创建项目");
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(projectsApi.create).toHaveBeenCalledWith("company-1", expect.objectContaining({ name, status: "planned", repositoryIds: [] }));
});
