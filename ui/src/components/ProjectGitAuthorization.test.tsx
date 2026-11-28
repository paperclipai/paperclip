// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import { projectsApi } from "@/api/projects";
import { ProjectGitAuthorization } from "./ProjectGitAuthorization";
import { replayLeaks } from "@/lib/analytics/replay-recording.test-utils";

vi.mock("@/api/projects", () => ({
  projectsApi: {
    gitAuthorization: vi.fn(),
    setGitAuthorization: vi.fn(),
  },
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ProjectGitAuthorization", () => {
  it("explains standing credential consent and revokes without retaining task context", async () => {
    const saved = {
      grantId: "grant-a",
      authorizedByUserId: "user-a",
      options: [
        {
          grantId: "grant-a",
          connectionName: "Work GitHub",
          login: "fixture-login",
        },
      ],
    };
    vi.mocked(projectsApi.gitAuthorization).mockResolvedValue(saved);
    vi.mocked(projectsApi.setGitAuthorization).mockResolvedValue({
      ...saved,
      grantId: null,
      authorizedByUserId: null,
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(["project-git-authorization", "company-a", "project-a"], saved);
    const container = document.createElement("div"),
      root = createRoot(container);
    document.body.appendChild(container);
    try {
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <ProjectGitAuthorization project={{ id: "project-a", companyId: "company-a" } as Project} />
          </QueryClientProvider>,
        ),
      );
      expect(container.textContent).toContain("existing GitHub permissions");
      expect(container.textContent).toContain("Project repository editors can add repositories covered by this connection");
      expect(container.textContent).toContain("Manage repository access in the GitHub connection");
      expect(container.textContent).toContain("Task runs continue to use their own identity");
      expect(container.textContent).toContain("fixture-login");
      const authorize = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Authorize project",
      )!;
      expect(authorize.disabled).toBe(true);
      const revoke = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Revoke authorization",
      )!;
      await act(async () => {
        revoke.click();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(projectsApi.setGitAuthorization).toHaveBeenCalledWith("project-a", null);
      expect(client.getQueryData(["project-git-authorization", "company-a", "project-a"])).toMatchObject({
        grantId: null,
      });
      expect(container.textContent).not.toContain("Revoke authorization");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      client.clear();
    }
  });

  it("masks GitHub logins in session replay", async () => {
    const saved = {
      grantId: "grant-a",
      authorizedByUserId: "user-a",
      options: [
        { grantId: "grant-a", connectionName: "Work GitHub", login: "saved-octo-quillon" },
        { grantId: "grant-b", connectionName: "Side GitHub", login: "picked-octo-varnell" },
      ],
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(["project-git-authorization", "company-a", "project-b"], saved);
    const container = document.createElement("div"),
      root = createRoot(container);
    document.body.appendChild(container);
    try {
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <ProjectGitAuthorization project={{ id: "project-b", companyId: "company-a" } as Project} />
          </QueryClientProvider>,
        ),
      );
      expect(replayLeaks("saved-octo-quillon", container)).toEqual({ rendered: true, recorded: false });
      const trigger = container.querySelector<HTMLElement>('[role="combobox"]')!;
      await act(async () => {
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      });
      expect(replayLeaks("picked-octo-varnell", document.body)).toEqual({ rendered: true, recorded: false });
      const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.includes("picked-octo-varnell"))!;
      await act(async () => option.click());
      expect(replayLeaks("picked-octo-varnell", trigger)).toEqual({ rendered: true, recorded: false });
    } finally {
      await act(async () => root.unmount());
      container.remove();
      client.clear();
    }
  });
});
