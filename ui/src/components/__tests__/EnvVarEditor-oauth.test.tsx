// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanySecret, EnvBinding } from "@paperclipai/shared";
import { EnvVarEditor } from "../EnvVarEditor";
import type { ConnectionSummary } from "../../pages/settings/connections/api";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const baseConnections: ConnectionSummary[] = [
  {
    id: "conn-github-1",
    providerId: "github",
    status: "active",
    accountId: "42",
    accountLabel: "octocat",
    scopes: [],
    accessTokenExpiresAt: null,
    lastRefreshedAt: null,
    lastError: null,
    lastErrorAt: null,
    refreshAttemptCount: 0,
  },
  {
    id: "conn-slack-1",
    providerId: "slack",
    status: "active",
    accountId: "S1",
    accountLabel: "team-paperclip",
    scopes: [],
    accessTokenExpiresAt: null,
    lastRefreshedAt: null,
    lastError: null,
    lastErrorAt: null,
    refreshAttemptCount: 0,
  },
];

const noopCreateSecret = (): Promise<CompanySecret> => {
  throw new Error("not used");
};

function findFirstSourceSelect(container: HTMLElement): HTMLSelectElement {
  const selects = Array.from(container.querySelectorAll("select"));
  // The first select per row is the source dropdown (Plain | Secret | OAuth token).
  const sourceSelect = selects.find((s) =>
    Array.from(s.options).some((o) => o.value === "oauth_token"),
  );
  if (!sourceSelect) {
    throw new Error(
      `No source <select> found — saw selects with options: ${selects
        .map((s) => Array.from(s.options).map((o) => o.value).join("/"))
        .join(" | ")}`,
    );
  }
  return sourceSelect as HTMLSelectElement;
}

function fireChange(element: HTMLSelectElement, value: string) {
  element.value = value;
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("EnvVarEditor — oauth_token binding", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("offers OAuth token as a source option even with empty connection list", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <EnvVarEditor
          value={{ GH: { type: "plain", value: "" } }}
          secrets={[]}
          oauthConnections={[]}
          onCreateSecret={noopCreateSecret}
          onChange={() => {}}
        />,
      );
    });
    const sourceSelect = findFirstSourceSelect(container);
    const options = Array.from(sourceSelect.options).map((o) => o.value);
    expect(options).toContain("oauth_token");
  });

  it("shows the empty-connections hint when oauth_token is selected and the list is empty", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <EnvVarEditor
          value={{ GH: { type: "plain", value: "" } }}
          secrets={[]}
          oauthConnections={[]}
          onCreateSecret={noopCreateSecret}
          onChange={() => {}}
        />,
      );
    });
    const sourceSelect = findFirstSourceSelect(container);
    act(() => {
      fireChange(sourceSelect, "oauth_token");
    });
    expect(container.textContent).toMatch(/no active connections/i);
  });

  it("emits an oauth_token binding when a connection is picked", () => {
    const root = createRoot(container);
    const onChange = vi.fn<(value: Record<string, EnvBinding> | undefined) => void>();
    act(() => {
      root.render(
        <EnvVarEditor
          value={{ GH: { type: "plain", value: "" } }}
          secrets={[]}
          oauthConnections={baseConnections}
          onCreateSecret={noopCreateSecret}
          onChange={onChange}
        />,
      );
    });
    const sourceSelect = findFirstSourceSelect(container);
    act(() => {
      fireChange(sourceSelect, "oauth_token");
    });
    // After source change, the connection picker should appear. It is also a <select>.
    const allSelects = Array.from(container.querySelectorAll("select"));
    const connectionSelect = allSelects.find(
      (s) => s.getAttribute("aria-label") === "OAuth connection",
    ) as HTMLSelectElement | undefined;
    if (!connectionSelect) {
      throw new Error("connection picker not rendered");
    }
    act(() => {
      fireChange(connectionSelect, "conn-github-1");
    });
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0];
    expect(lastCall).toMatchObject({
      GH: {
        type: "oauth_token",
        connectionId: "conn-github-1",
        field: "access",
      },
    });
  });

  it("round-trips an existing oauth_token binding into the row state and back out", () => {
    const root = createRoot(container);
    const onChange = vi.fn<(value: Record<string, EnvBinding> | undefined) => void>();
    act(() => {
      root.render(
        <EnvVarEditor
          value={{
            SLACK_TOKEN: {
              type: "oauth_token",
              connectionId: "conn-slack-1",
              field: "access",
            },
          }}
          secrets={[]}
          oauthConnections={baseConnections}
          onCreateSecret={noopCreateSecret}
          onChange={onChange}
        />,
      );
    });
    const sourceSelect = findFirstSourceSelect(container);
    expect(sourceSelect.value).toBe("oauth_token");
    const connectionSelect = Array.from(container.querySelectorAll("select")).find(
      (s) => s.getAttribute("aria-label") === "OAuth connection",
    ) as HTMLSelectElement | undefined;
    if (!connectionSelect) throw new Error("connection picker not rendered");
    expect(connectionSelect.value).toBe("conn-slack-1");
  });

  it("does not break the existing plain → secret flow", () => {
    const root = createRoot(container);
    const secret: CompanySecret = {
      id: "sec-1",
      companyId: "c1",
      key: "GH",
      name: "GH",
      provider: "local_encrypted",
      status: "active",
      managedMode: "paperclip_managed",
      externalRef: null,
      providerConfigId: null,
      providerMetadata: null,
      latestVersion: 1,
      description: null,
      lastResolvedAt: null,
      lastRotatedAt: null,
      deletedAt: null,
      createdByAgentId: null,
      createdByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const onChange = vi.fn<(value: Record<string, EnvBinding> | undefined) => void>();
    act(() => {
      root.render(
        <EnvVarEditor
          value={{ GH: { type: "plain", value: "abc" } }}
          secrets={[secret]}
          oauthConnections={[]}
          onCreateSecret={noopCreateSecret}
          onChange={onChange}
        />,
      );
    });
    const sourceSelect = findFirstSourceSelect(container);
    act(() => {
      fireChange(sourceSelect, "secret");
    });
    // Should now show the secret picker (a select with the secret as an option).
    const secretSelect = Array.from(container.querySelectorAll("select")).find((s) =>
      Array.from(s.options).some((o) => o.value === "sec-1"),
    ) as HTMLSelectElement | undefined;
    if (!secretSelect) throw new Error("secret picker missing");
    act(() => {
      fireChange(secretSelect, "sec-1");
    });
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0];
    expect(lastCall).toMatchObject({
      GH: { type: "secret_ref", secretId: "sec-1" },
    });
  });
});
