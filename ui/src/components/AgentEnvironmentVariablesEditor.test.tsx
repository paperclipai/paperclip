// @vitest-environment jsdom

import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { EnvBinding } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentEnvironmentVariablesEditor,
  mergeAgentConfigurationEnv,
  replaceAgentCompanySecretEnv,
  selectAgentConfigurationEnv,
} from "./AgentEnvironmentVariablesEditor";
import type { EnvironmentVariablesEditorHandle } from "./environment-variables-editor";

describe("agent configuration environment model", () => {
  const env: Record<string, EnvBinding> = {
    PLAIN: { type: "plain", value: "visible" },
    COMPANY_TOKEN: { type: "secret_ref", secretId: "company-secret", version: "latest" },
    USER_TOKEN: { type: "user_secret_ref", key: "personal-token", required: true },
  };

  it("shows only non-secret variables in Configuration", () => {
    expect(selectAgentConfigurationEnv(env)).toEqual({
      PLAIN: { type: "plain", value: "visible" },
    });
  });

  it("preserves hidden secret bindings when plain variables change", () => {
    expect(
      mergeAgentConfigurationEnv(env, {
        PLAIN: { type: "plain", value: "changed" },
        OTHER: { type: "plain", value: "new" },
      }),
    ).toEqual({
      COMPANY_TOKEN: { type: "secret_ref", secretId: "company-secret", version: "latest" },
      USER_TOKEN: { type: "user_secret_ref", key: "personal-token", required: true },
      PLAIN: { type: "plain", value: "changed" },
      OTHER: { type: "plain", value: "new" },
    });
  });

  it("replaces company-secret assignments without touching other environment values", () => {
    expect(
      replaceAgentCompanySecretEnv(env, {
        NEW_TOKEN: { type: "secret_ref", secretId: "new-company-secret", version: 3 },
      }),
    ).toEqual({
      PLAIN: { type: "plain", value: "visible" },
      USER_TOKEN: { type: "user_secret_ref", key: "personal-token", required: true },
      NEW_TOKEN: { type: "secret_ref", secretId: "new-company-secret", version: 3 },
    });
  });
});

describe("AgentEnvironmentVariablesEditor", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  it("hides secret rows and sources while preserving them in emitted values", () => {
    const onChange = vi.fn();
    const ref = createRef<EnvironmentVariablesEditorHandle>();
    const value: Record<string, EnvBinding> = {
      PLAIN: { type: "plain", value: "visible" },
      COMPANY_TOKEN: { type: "secret_ref", secretId: "company-secret", version: "latest" },
      USER_TOKEN: { type: "user_secret_ref", key: "personal-token", required: true },
    };

    flushSync(() => {
      root.render(
        <AgentEnvironmentVariablesEditor
          ref={ref}
          value={value}
          onChange={onChange}
        />,
      );
    });

    const names = [...container.querySelectorAll<HTMLInputElement>('input[aria-label="Variable name"]')]
      .map((input) => input.value);
    expect(names).toEqual(["PLAIN"]);
    expect(container.querySelector('[aria-label="Value source"]')).toBeNull();
    expect(container.textContent).not.toContain("Store as secret");

    const valueInput = container.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(valueInput, "changed");
    flushSync(() => valueInput.dispatchEvent(new Event("input", { bubbles: true })));
    const flushed = ref.current?.flushPendingDraft();

    expect(flushed).toEqual({
      COMPANY_TOKEN: { type: "secret_ref", secretId: "company-secret", version: "latest" },
      USER_TOKEN: { type: "user_secret_ref", key: "personal-token", required: true },
      PLAIN: { type: "plain", value: "changed" },
    });
    expect(onChange).toHaveBeenLastCalledWith(flushed);
  });
});
