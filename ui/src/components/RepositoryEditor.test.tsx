// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { ProjectRepository } from "@paperclipai/shared";
import { RepositoryEditor } from "./RepositoryEditor";
import { repositoryProviders } from "./repository-providers";

vi.mock("./ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("RepositoryEditor", () => {
  it("checks large selections against the catalog with linear ID reads", async () => {
    let reads = 0;
    const repos = Array.from({ length: 400 }, (_, index) => ({
      get id() { reads++; return `repo-${index}`; },
      fullName: `org/repo-${index}`, url: `https://github.com/org/repo-${index}`, connections: [],
    }));
    const container = document.createElement("div"), root = createRoot(container);
    try {
      await act(async () => root.render(<RepositoryEditor selected={repos} available={repos} onChange={vi.fn()} onConnect={vi.fn()} onRetry={vi.fn()} />));
      expect(reads).toBeLessThan(repos.length * 15);
      expect(container.textContent).not.toContain("Restore the provider connection or repository access");
    } finally { await act(async () => root.unmount()); }
  });
  it("opens setup for the selected repository provider", async () => {
    const onConnect = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<RepositoryEditor selected={[]} state="disconnected" onChange={vi.fn()} onConnect={onConnect} onRetry={vi.fn()} />));
      const azure = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Connect Azure DevOps"))!;
      const github = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Connect GitHub"))!;
      await act(async () => azure.click());
      expect(onConnect).toHaveBeenLastCalledWith(repositoryProviders[1]);
      await act(async () => github.click());
      expect(onConnect).toHaveBeenLastCalledWith(repositoryProviders[0]);
    } finally {
      await act(async () => root.unmount());
    }
  });
  it("shows provider-neutral selected repository names and preserves provider-qualified identity", async () => {
    const selected: ProjectRepository[] = [
      { id: "12345", fullName: "paperclipai/paperclip", url: "https://github.com/paperclipai/paperclip", connections: [] },
      { id: "azure-devops:org/project/repo", provider: "azure-devops", fullName: "org/project/repo", url: "https://dev.azure.com/org/project/_git/repo", connections: ["Work Azure DevOps"] },
    ];
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<RepositoryEditor selected={selected} available={[selected[0]!]} onChange={vi.fn()} onConnect={vi.fn()} onRetry={vi.fn()} />));
      expect(container.textContent).toContain("paperclipai/paperclip");
      expect(container.textContent).toContain("GitHub");
      expect(container.textContent).toContain("org/project/repo");
      expect(container.textContent).toContain("Azure DevOps");
      expect(container.querySelector('[aria-label="Remove paperclipai/paperclip"]')).toBeTruthy();
      expect(container.querySelector('[aria-label="Remove org/project/repo"]')).toBeTruthy();
      expect(container.textContent).toContain("Restore the provider connection or repository access");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it.each(["loading", "error"] as const)("does not report missing provider access while the catalog is %s", async (state) => {
    const selected: ProjectRepository[] = [{ id: "azure-devops:org/project/repo", provider: "azure-devops", fullName: "org/project/repo", url: "https://dev.azure.com/org/project/_git/repo", connections: [] }];
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<RepositoryEditor selected={selected} available={[]} state={state} onChange={vi.fn()} onConnect={vi.fn()} onRetry={vi.fn()} />));
      expect(container.textContent).not.toContain("Restore the provider connection or repository access");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
  it("shows a recovery message for an unavailable GitHub repository", async () => {
    const selected: ProjectRepository[] = [{ id: "12345", fullName: "paperclipai/paperclip", url: "https://github.com/paperclipai/paperclip", connections: [] }];
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<RepositoryEditor selected={selected} available={[]} state="empty" onChange={vi.fn()} onConnect={vi.fn()} onRetry={vi.fn()} />));
      expect(container.textContent).toContain("Restore the provider connection or repository access");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

});
