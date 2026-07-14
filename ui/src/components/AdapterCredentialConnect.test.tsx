// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterCredentialSetup } from "@paperclipai/adapter-utils";
import type { CompanySecret } from "@paperclipai/shared";
import { ApiError } from "../api/client";

const mockSecretsApi = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("../api/secrets", () => ({
  secretsApi: mockSecretsApi,
}));

import { AdapterCredentialConnect } from "./AdapterCredentialConnect";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function makeSecret(overrides: Partial<CompanySecret> = {}): CompanySecret {
  return {
    id: "secret-1",
    companyId: "company-1",
    scope: "company",
    ownerUserId: null,
    userSecretDefinitionId: null,
    key: "claude-local-anthropic-api-key",
    name: "claude-local-anthropic-api-key",
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
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as CompanySecret;
}

const claudeLocalSetup: AdapterCredentialSetup = {
  options: [
    {
      envKey: "ANTHROPIC_API_KEY",
      kind: "api_key",
      label: "Anthropic API key",
      hint: "Create a key in the Anthropic Console.",
      setupUrl: "https://console.anthropic.com/settings/keys",
      placeholder: "sk-ant-…",
    },
    {
      envKey: "CLAUDE_CODE_OAUTH_TOKEN",
      kind: "subscription_token",
      label: "Claude Pro/Max subscription token",
      hint: "Mint a long-lived token with `claude setup-token`.",
      setupCommand: "claude setup-token",
      placeholder: "sk-ant-oat01-…",
    },
  ],
};

let container: HTMLDivElement;
let root: Root | null = null;

function render(props: Partial<React.ComponentProps<typeof AdapterCredentialConnect>> = {}) {
  root = createRoot(container);
  return act(() => {
    root!.render(
      <AdapterCredentialConnect
        companyId={props.companyId ?? "company-1"}
        adapterType={props.adapterType ?? "claude_local"}
        setup={props.setup ?? claudeLocalSetup}
        boundEnvKeys={props.boundEnvKeys ?? []}
        onBind={props.onBind ?? vi.fn()}
      />,
    );
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  mockSecretsApi.create.mockReset();
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container.remove();
});

describe("AdapterCredentialConnect", () => {
  it("renders the full card with option labels, hint, and setupCommand chip when nothing is bound", async () => {
    await render({});

    expect(container.textContent).toContain("Anthropic API key");
    expect(container.textContent).toContain("Claude Pro/Max subscription token");
    expect(container.textContent).toContain("Create a key in the Anthropic Console.");
    // First option is active by default and has no setupCommand.
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
  });

  it("renders a compact connected summary naming the bound envKey when an option is bound", async () => {
    await render({ boundEnvKeys: ["ANTHROPIC_API_KEY"] });

    expect(container.textContent).toContain("ANTHROPIC_API_KEY");
    expect(container.querySelector('input[type="password"]')).toBeNull();
    const changeButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Change",
    );
    expect(changeButton).not.toBeUndefined();

    await act(() => {
      changeButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector('input[type="password"]')).not.toBeNull();
  });

  it("switching the segmented control swaps the active option's hint and field", async () => {
    await render({});

    expect(container.textContent).toContain("Create a key in the Anthropic Console.");
    expect(container.textContent).not.toContain("claude setup-token");

    const tokenTab = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Claude Pro/Max subscription token",
    );
    expect(tokenTab).not.toBeUndefined();

    await act(() => {
      tokenTab!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Mint a long-lived token with");
    expect(container.textContent).toContain("claude setup-token");
    const input = container.querySelector<HTMLInputElement>('input[type="password"]');
    expect(input?.placeholder).toBe("sk-ant-oat01-…");
  });

  it("submits, creates the secret with the derived name, and binds on success", async () => {
    const onBind = vi.fn();
    mockSecretsApi.create.mockResolvedValueOnce(makeSecret({ id: "secret-42" }));

    await render({ onBind });

    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(() => setInputValue(input, "sk-ant-test"));

    const connectButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Connect"),
    )!;
    expect(connectButton.hasAttribute("disabled")).toBe(false);

    await act(() => {
      connectButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockSecretsApi.create).toHaveBeenCalledTimes(1);
    expect(mockSecretsApi.create).toHaveBeenCalledWith("company-1", {
      name: "claude-local-anthropic-api-key",
      value: "sk-ant-test",
    });
    expect(onBind).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "secret-42");

    const clearedInput = container.querySelector<HTMLInputElement>('input[type="password"]');
    expect(clearedInput?.value ?? "").toBe("");
  });

  it("retries once with a -2 suffix when the create call rejects with a 409 name conflict, then binds on the retry", async () => {
    const onBind = vi.fn();
    mockSecretsApi.create
      .mockRejectedValueOnce(
        new ApiError("a secret with this name already exists", 409, {
          message: "a secret with this name already exists",
        }),
      )
      .mockResolvedValueOnce(makeSecret({ id: "secret-retry" }));

    await render({ onBind });

    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(() => setInputValue(input, "sk-ant-test"));

    const connectButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Connect"),
    )!;
    await act(() => {
      connectButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockSecretsApi.create).toHaveBeenCalledTimes(2);
    expect(mockSecretsApi.create).toHaveBeenNthCalledWith(1, "company-1", {
      name: "claude-local-anthropic-api-key",
      value: "sk-ant-test",
    });
    expect(mockSecretsApi.create).toHaveBeenNthCalledWith(2, "company-1", {
      name: "claude-local-anthropic-api-key-2",
      value: "sk-ant-test",
    });
    expect(onBind).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "secret-retry");
  });

  it("shows an inline error and keeps the input when both the create and the 409 retry reject", async () => {
    const onBind = vi.fn();
    mockSecretsApi.create
      .mockRejectedValueOnce(new ApiError("first failure", 409, { message: "first failure" }))
      .mockRejectedValueOnce(new ApiError("still conflicted", 409, { message: "still conflicted" }));

    await render({ onBind });

    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(() => setInputValue(input, "sk-ant-test"));

    const connectButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Connect"),
    )!;
    await act(() => {
      connectButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockSecretsApi.create).toHaveBeenCalledTimes(2);
    expect(onBind).not.toHaveBeenCalled();
    expect(container.textContent).toContain("still conflicted");
    const keptInput = container.querySelector<HTMLInputElement>('input[type="password"]');
    expect(keptInput?.value).toBe("sk-ant-test");
  });

  it("does not retry on a non-409 rejection and surfaces the error immediately", async () => {
    const onBind = vi.fn();
    mockSecretsApi.create.mockRejectedValueOnce(new Error("network error"));

    await render({ onBind });

    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(() => setInputValue(input, "sk-ant-test"));

    const connectButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Connect"),
    )!;
    await act(() => {
      connectButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockSecretsApi.create).toHaveBeenCalledTimes(1);
    expect(onBind).not.toHaveBeenCalled();
    expect(container.textContent).toContain("network error");
    const keptInput = container.querySelector<HTMLInputElement>('input[type="password"]');
    expect(keptInput?.value).toBe("sk-ant-test");
  });

  it("sends the trimmed value to secretsApi.create", async () => {
    const onBind = vi.fn();
    mockSecretsApi.create.mockResolvedValueOnce(makeSecret({ id: "secret-trim" }));

    await render({ onBind });

    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(() => setInputValue(input, "  sk-ant-test  "));

    const connectButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Connect"),
    )!;
    await act(() => {
      connectButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockSecretsApi.create).toHaveBeenCalledWith("company-1", {
      name: "claude-local-anthropic-api-key",
      value: "sk-ant-test",
    });
  });

  it("submits on Enter in the password input", async () => {
    const onBind = vi.fn();
    mockSecretsApi.create.mockResolvedValueOnce(makeSecret({ id: "secret-enter" }));

    await render({ onBind });

    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(() => setInputValue(input, "sk-ant-test"));

    await act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    await flushReact();

    expect(mockSecretsApi.create).toHaveBeenCalledTimes(1);
    expect(onBind).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "secret-enter");
  });

  it("does not submit on Enter when the value is blank", async () => {
    await render({});

    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    await flushReact();

    expect(mockSecretsApi.create).not.toHaveBeenCalled();
  });

  it("associates the inline error with the input via aria-describedby and role=alert", async () => {
    mockSecretsApi.create.mockRejectedValueOnce(new Error("boom"));

    await render({});

    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(() => setInputValue(input, "sk-ant-test"));

    const connectButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Connect"),
    )!;
    await act(() => {
      connectButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const errorEl = container.querySelector('[role="alert"]');
    expect(errorEl).not.toBeNull();
    expect(errorEl?.textContent).toBe("boom");
    expect(errorEl?.id).toBeTruthy();
    expect(input.getAttribute("aria-describedby")).toBe(errorEl?.id);
  });
});
