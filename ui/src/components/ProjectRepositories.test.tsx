// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import { ProjectRepositories } from "./ProjectRepositories";
import { repositoryProviders, type RepositoryProvider } from "./repository-providers";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./ProjectRepositoryInput", () => ({
  repositoryOptionsKey: (companyId: string) => ["repositories", companyId],
  ProjectRepositoryInput: ({ onConnect }: { onConnect: (provider: RepositoryProvider) => void }) => <button onClick={() => onConnect(repositoryProviders[1])}>Connect Azure</button>,
}));
vi.mock("@/features/connections/ConnectionSetupFlow", () => ({
  ConnectionSetupFlow: ({ serviceSlug, onComplete }: { serviceSlug: string; onComplete: () => void }) => <div>Setup {serviceSlug}<button onClick={onComplete}>Finish</button></div>,
}));
vi.mock("./ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <>{children}</> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

describe("project repository connections", () => {
  it("opens Azure setup and refreshes the current company's repositories after completion", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const container = document.createElement("div");
    const root = createRoot(container);
    const project = { id: "p", companyId: "c", urlKey: "p", workspaces: [] } as unknown as Project;
    try {
      await act(async () => root.render(<QueryClientProvider client={client}><ProjectRepositories project={project} /></QueryClientProvider>));
      await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Connect Azure")!.click());
      expect(container.textContent).toContain("Setup azure-devops");
      await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Finish")!.click());
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["repositories", "c"] });
      expect(container.textContent).not.toContain("Setup azure-devops");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
