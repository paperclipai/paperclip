// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceUpdateStatus } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { UpdateStatusBanner } from "./UpdateStatusBanner";

const instanceUpdatesApiMock = vi.hoisted(() => ({
  getStatus: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock("../api/instanceUpdates", () => ({
  instanceUpdatesApi: instanceUpdatesApiMock,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function status(overrides: Partial<InstanceUpdateStatus> = {}): InstanceUpdateStatus {
  return {
    status: "update_available",
    currentVersion: "0.3.1",
    latestVersion: "0.3.2",
    updateAvailable: true,
    releaseUrl: "https://github.com/paperclipai/paperclip/releases/tag/v0.3.2",
    checkedAt: "2026-04-19T12:00:00.000Z",
    nextCheckAt: "2026-04-19T18:00:00.000Z",
    checkSource: "npm",
    error: null,
    settings: {
      channel: "stable",
      updateChecksEnabled: true,
      dismissedVersion: null,
      dismissedAt: null,
    },
    install: {
      currentVersion: "0.3.1",
      gitRepositoryRoot: "/tmp/paperclip",
      gitBranch: "main",
      gitSha: "abc1234",
      gitDirty: false,
    },
    backup: {
      required: true,
      valid: false,
      reason: "missing",
      targetVersion: "0.3.2",
      expiresAt: null,
      latest: null,
      externalStorageRequiresAcknowledgement: false,
    },
    banner: {
      shouldShow: true,
      tone: "warn",
      reasons: ["backup_required"],
    },
    ...overrides,
  };
}

async function renderBanner() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <UpdateStatusBanner />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  instanceUpdatesApiMock.getStatus.mockReset();
  instanceUpdatesApiMock.dismiss.mockReset();
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("UpdateStatusBanner", () => {
  it("hides when the update status says no banner should show", async () => {
    instanceUpdatesApiMock.getStatus.mockResolvedValue(status({
      status: "up_to_date",
      latestVersion: "0.3.1",
      updateAvailable: false,
      backup: {
        required: false,
        valid: true,
        reason: "none",
        targetVersion: null,
        expiresAt: null,
        latest: null,
        externalStorageRequiresAcknowledgement: false,
      },
      banner: {
        shouldShow: false,
        tone: null,
        reasons: [],
      },
    }));

    await renderBanner();

    expect(container?.textContent).not.toContain("Paperclip Update");
  });

  it("renders an amber backup-required banner with the Updates link", async () => {
    instanceUpdatesApiMock.getStatus.mockResolvedValue(status({
      install: {
        currentVersion: "0.3.1",
        gitRepositoryRoot: "/tmp/paperclip",
        gitBranch: "feature",
        gitSha: "abc1234",
        gitDirty: true,
      },
    }));

    await renderBanner();

    expect(container?.textContent).toContain("Paperclip Update Needs Backup");
    expect(container?.textContent).toContain("pre-update backup required");
    expect(container?.textContent).toContain("Local core edits were detected");
    const link = container?.querySelector("a") as HTMLAnchorElement | null;
    expect(link?.getAttribute("href")).toBe("/instance/settings/updates");
  });

  it("dismisses the detected version from the banner", async () => {
    instanceUpdatesApiMock.getStatus.mockResolvedValue(status());
    instanceUpdatesApiMock.dismiss.mockResolvedValue(status({
      banner: {
        shouldShow: false,
        tone: "warn",
        reasons: ["backup_required"],
      },
      settings: {
        channel: "stable",
        updateChecksEnabled: true,
        dismissedVersion: "0.3.2",
        dismissedAt: "2026-04-19T12:01:00.000Z",
      },
    }));

    await renderBanner();
    const dismiss = Array.from(container?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("Dismiss"),
    );
    if (!dismiss) throw new Error("Dismiss button not found");

    await act(async () => {
      dismiss.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(instanceUpdatesApiMock.dismiss).toHaveBeenCalledWith("0.3.2");
  });

  it("hides silently for non-admin board sessions", async () => {
    instanceUpdatesApiMock.getStatus.mockRejectedValue(new ApiError("Forbidden", 403, { error: "Forbidden" }));

    await renderBanner();

    expect(container?.textContent).not.toContain("Paperclip Update");
  });
});
