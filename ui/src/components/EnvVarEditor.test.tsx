// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanySecret, EnvBinding } from "@paperclipai/shared";
import { EnvVarEditor } from "./EnvVarEditor";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function dispatchInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function dispatchSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function latestEnvCall(mock: ReturnType<typeof vi.fn>): Record<string, EnvBinding> | undefined {
  const calls = mock.mock.calls;
  return calls[calls.length - 1]?.[0] as Record<string, EnvBinding> | undefined;
}

function makeSecret(overrides: Partial<CompanySecret> = {}): CompanySecret {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    name: "paperclip_api_key",
    provider: "local_encrypted",
    latestVersion: 1,
    externalRef: null,
    description: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("EnvVarEditor", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
  });

  it("emits secret refs when an existing secret is selected", () => {
    const onChange = vi.fn();
    const root = createRoot(container);
    const secrets: CompanySecret[] = [makeSecret()];

    act(() => {
      root.render(
        <EnvVarEditor
          value={{}}
          secrets={secrets}
          onCreateSecret={vi.fn()}
          onChange={onChange}
        />,
      );
    });

    const [keyInput] = container.querySelectorAll<HTMLInputElement>('input[placeholder="KEY"]');
    const selects = container.querySelectorAll<HTMLSelectElement>("select");
    const sourceSelect = selects[0];

    act(() => {
      dispatchInputValue(keyInput!, "OPENAI_API_KEY");
    });
    act(() => {
      dispatchSelectValue(sourceSelect!, "secret");
    });

    const secretSelect = container.querySelectorAll<HTMLSelectElement>("select")[1];
    act(() => {
      dispatchSelectValue(secretSelect!, secrets[0]!.id);
    });

    expect(latestEnvCall(onChange)).toEqual({
      OPENAI_API_KEY: {
        type: "secret_ref",
        secretId: secrets[0]!.id,
        version: "latest",
      },
    });

    act(() => {
      root.unmount();
    });
  });

  it("does not silently fall back to plain when secret mode has no selected secret", () => {
    const onChange = vi.fn();
    const root = createRoot(container);

    act(() => {
      root.render(
        <EnvVarEditor
          value={{ OPENAI_API_KEY: { type: "plain", value: "sk-test" } }}
          secrets={[]}
          onCreateSecret={vi.fn()}
          onChange={onChange}
        />,
      );
    });

    const sourceSelect = container.querySelector<HTMLSelectElement>("select");
    expect(sourceSelect).not.toBeNull();

    act(() => {
      dispatchSelectValue(sourceSelect!, "secret");
    });

    expect(latestEnvCall(onChange)).toBeUndefined();

    act(() => {
      root.unmount();
    });
  });

  it("creates a new secret from secret mode without requiring a hidden plain value", async () => {
    const onChange = vi.fn();
    const onCreateSecret = vi.fn(async (name: string, value: string) => ({
      ...makeSecret({
        id: "22222222-2222-4222-8222-222222222222",
        name,
      }),
    }));
    const typedCreateSecret: (name: string, value: string) => Promise<CompanySecret> = async (name, value) => {
      return onCreateSecret(name, value);
    };
    const prompt = vi
      .spyOn(window, "prompt")
      .mockReturnValueOnce("openai_key")
      .mockReturnValueOnce("sk-secret");
    const root = createRoot(container);

    act(() => {
      root.render(
        <EnvVarEditor
          value={{}}
          secrets={[]}
          onCreateSecret={typedCreateSecret}
          onChange={onChange}
        />,
      );
    });

    const [keyInput] = container.querySelectorAll<HTMLInputElement>('input[placeholder="KEY"]');
    const sourceSelect = container.querySelector<HTMLSelectElement>("select");

    act(() => {
      dispatchInputValue(keyInput!, "OPENAI_API_KEY");
    });
    act(() => {
      dispatchSelectValue(sourceSelect!, "secret");
    });

    const newButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "New");
    expect(newButton).not.toBeNull();
    expect(newButton).not.toHaveProperty("disabled", true);

    await act(async () => {
      newButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(onCreateSecret).toHaveBeenCalledWith("openai_key", "sk-secret");
    expect(latestEnvCall(onChange)).toEqual({
      OPENAI_API_KEY: {
        type: "secret_ref",
        secretId: "22222222-2222-4222-8222-222222222222",
        version: "latest",
      },
    });

    act(() => {
      root.unmount();
    });
  });
});
