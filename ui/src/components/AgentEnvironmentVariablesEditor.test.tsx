// @vitest-environment jsdom

import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { EnvBinding } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentEnvironmentVariablesEditor,
  mergeAgentConfigurationEnv,
  selectAgentConfigurationEnv,
} from "./AgentEnvironmentVariablesEditor";
import type { EnvironmentVariablesEditorHandle } from "./environment-variables-editor";

describe("agent configuration environment model", () => {
  const env: Record<string, EnvBinding> = {
    MASKED: { type: "plain", value: "***REDACTED***" },
    MASKED_STRING: "***REDACTED***",
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
      MASKED: { type: "plain", value: "***REDACTED***" },
      MASKED_STRING: "***REDACTED***",
      COMPANY_TOKEN: { type: "secret_ref", secretId: "company-secret", version: "latest" },
      USER_TOKEN: { type: "user_secret_ref", key: "personal-token", required: true },
      PLAIN: { type: "plain", value: "changed" },
      OTHER: { type: "plain", value: "new" },
    });
  });


  it("retains hidden references and masked values when all visible rows are removed", () => {
    expect(mergeAgentConfigurationEnv(env, undefined)).toEqual({
      MASKED: env.MASKED, MASKED_STRING: env.MASKED_STRING,
      COMPANY_TOKEN: env.COMPANY_TOKEN, USER_TOKEN: env.USER_TOKEN,
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

  it("does not save a plain variable renamed to a hidden secret name", () => {
    const onChange = vi.fn();
    const ref = createRef<EnvironmentVariablesEditorHandle>();
    flushSync(() => {
      root.render(
        <AgentEnvironmentVariablesEditor
          ref={ref}
          value={{
            FOO: { type: "plain", value: "entered" },
            TOKEN: { type: "secret_ref", secretId: "company-secret", version: "latest" },
          }}
          onChange={onChange}
        />,
      );
    });
    const nameInput = container.querySelector<HTMLInputElement>('input[aria-label="Variable name"]')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(nameInput, "TOKEN");
    flushSync(() => nameInput.dispatchEvent(new Event("input", { bubbles: true })));
    flushSync(() => nameInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));

    expect(ref.current?.flushPendingDraft()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Used by a secret on the Secrets tab");
    const save = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Save"));
    expect(save?.disabled).toBe(true);
  });


});
