// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADAPTER_AUTH_MISSING_CHECK_CODE, type BrowserAnalyticsConfig } from "@paperclipai/shared";
import { blocksAgentCreate } from "@/lib/onboarding-connection-test";
import { isReportableAdapterLoginFailure } from "@/components/AgentConfigForm";
import {
  captureProductAnalyticsEvent,
  resetProductAnalyticsForTest,
  setProductAnalyticsUser,
  syncProductAnalytics,
  type ProductAnalyticsClient,
} from "./product-analytics";
import {
  captureAgentChatMessageSent,
  captureOnboardingStepCompleted,
  captureOnboardingStepFailed,
  useOnboardingAnalytics,
} from "./onboarding-analytics";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const unmounts: Array<() => void> = [];

function renderHook<R, P>(callback: (props: P) => R, options: { initialProps: P }) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let props = options.initialProps;
  const result = {} as { current: R };
  function Harness() {
    result.current = callback(props);
    return null;
  }
  function rerender(next: P = props) {
    props = next;
    act(() => root.render(createElement(Harness)));
  }
  unmounts.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  rerender();
  return { result, rerender };
}

const config: BrowserAnalyticsConfig = {
  token: "phc_test",
  apiHost: "/_ph",
  uiHost: "https://us.posthog.com",
  environment: "staging",
  stackId: "stack-1",
  replayEnabled: false,
};

function mockClient() {
  return {
    init: vi.fn(),
    register: vi.fn(),
    identify: vi.fn(),
    group: vi.fn(),
    reset: vi.fn(),
    capture: vi.fn(),
    opt_out_capturing: vi.fn(),
    opt_in_capturing: vi.fn(),
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

let client: ReturnType<typeof mockClient>;
let scheduled: (() => void) | null;
const load = () => Promise.resolve(client as unknown as ProductAnalyticsClient);
const schedule = (start: () => void) => {
  scheduled = start;
  return () => { scheduled = null; };
};

async function startAnalytics() {
  syncProductAnalytics(config, "granted", { load, schedule, immediate: true });
  await flush();
}

function captured() {
  return client.capture.mock.calls.map(([event, properties]) => [event, properties]);
}

beforeEach(() => {
  client = mockClient();
  scheduled = null;
});

afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
  resetProductAnalyticsForTest();
});

describe("browser product events", () => {
  it("captures nothing when browser analytics is off", async () => {
    captureProductAnalyticsEvent("onboarding_opened", { step: "create_agent" });
    await flush();
    expect(client.capture).not.toHaveBeenCalled();
  });

  it.each(["denied", "ask"] as const)("captures nothing when consent is %s", async (consent) => {
    syncProductAnalytics(config, consent, { load, schedule, immediate: true });
    await flush();
    captureProductAnalyticsEvent("onboarding_opened", { step: "create_agent" });
    await flush();
    expect(client.init).not.toHaveBeenCalled();
    expect(client.capture).not.toHaveBeenCalled();
  });

  it("holds events from before posthog-js loads and sends them with their own time", async () => {
    syncProductAnalytics(config, "granted", { load, schedule });
    captureProductAnalyticsEvent("onboarding_opened", { step: "create_agent" });
    expect(client.capture).not.toHaveBeenCalled();
    scheduled!();
    await flush();
    expect(client.capture).toHaveBeenCalledTimes(1);
    expect(client.capture).toHaveBeenCalledWith(
      "onboarding_opened",
      { step: "create_agent" },
      { timestamp: expect.any(Date) },
    );
  });

  it("drops held events when consent is withdrawn before posthog-js loads", async () => {
    syncProductAnalytics(config, "granted", { load, schedule });
    captureProductAnalyticsEvent("onboarding_opened", { step: "create_agent" });
    scheduled!();
    syncProductAnalytics(config, "denied", { load, schedule });
    await flush();
    captureProductAnalyticsEvent("onboarding_dismissed", { step: "create_agent" });
    expect(client.capture).not.toHaveBeenCalled();
  });

  it("drops held events when the signed-in person changes before posthog-js loads", async () => {
    setProductAnalyticsUser({ id: "user-1", email: null, name: null });
    syncProductAnalytics(config, "granted", { load, schedule });
    captureProductAnalyticsEvent("onboarding_opened", { step: "create_agent" });
    setProductAnalyticsUser(null);
    setProductAnalyticsUser({ id: "user-2", email: null, name: null });
    captureProductAnalyticsEvent("onboarding_opened", { step: "connect_model" });
    scheduled!();
    await flush();
    expect(captured()).toEqual([["onboarding_opened", { step: "connect_model" }]]);
    expect(client.identify).toHaveBeenCalledWith("user-2", {});
  });

  it("keeps held events when the same person is set again before posthog-js loads", async () => {
    setProductAnalyticsUser({ id: "user-1", email: null, name: null });
    syncProductAnalytics(config, "granted", { load, schedule });
    captureProductAnalyticsEvent("onboarding_opened", { step: "create_agent" });
    setProductAnalyticsUser({ id: "user-1", email: "jane@example.com", name: null });
    scheduled!();
    await flush();
    expect(captured()).toEqual([["onboarding_opened", { step: "create_agent" }]]);
  });

  it("stops capturing after consent is withdrawn", async () => {
    await startAnalytics();
    syncProductAnalytics(config, "denied", { load, schedule });
    captureProductAnalyticsEvent("onboarding_opened", {});
    expect(client.capture).not.toHaveBeenCalled();
  });
});

describe("onboarding funnel events", () => {
  function renderWizard(initial: { open: boolean; step: number }) {
    return renderHook(
      (props: { open: boolean; step: number; connectOutcome: "subscription" | "api_key" }) => useOnboardingAnalytics(props),
      { initialProps: { ...initial, connectOutcome: "subscription" as "subscription" | "api_key" } },
    );
  }

  it("captures each transition once through the wizard", async () => {
    await startAnalytics();
    const wizard = renderWizard({ open: false, step: 1 });
    wizard.rerender({ open: true, step: 1, connectOutcome: "subscription" });
    act(() => wizard.result.current.opened(3, 1));
    wizard.rerender({ open: true, step: 3, connectOutcome: "subscription" });
    wizard.rerender({ open: true, step: 3, connectOutcome: "subscription" });
    wizard.rerender({ open: true, step: 4, connectOutcome: "subscription" });
    wizard.rerender({ open: true, step: 4, connectOutcome: "api_key" });
    wizard.rerender({ open: true, step: 5, connectOutcome: "api_key" });
    captureOnboardingStepCompleted("review");
    captureOnboardingStepCompleted("launch", "succeeded");
    act(() => wizard.result.current.finished());
    wizard.rerender({ open: false, step: 1, connectOutcome: "subscription" });

    expect(captured()).toEqual([
      ["onboarding_opened", { step: "create_agent" }],
      ["onboarding_step_viewed", { step: "create_agent" }],
      ["onboarding_step_completed", { step: "create_agent" }],
      ["onboarding_step_viewed", { step: "connect_model" }],
      ["onboarding_step_completed", { step: "connect_model", outcome: "api_key" }],
      ["onboarding_step_viewed", { step: "review" }],
      ["onboarding_step_completed", { step: "review" }],
      ["onboarding_step_completed", { step: "launch", outcome: "succeeded" }],
    ]);
  });

  it("does not count a stale step from the opening render as a view", async () => {
    await startAnalytics();
    const wizard = renderWizard({ open: true, step: 5 });
    act(() => wizard.result.current.opened(3, 5));
    wizard.rerender({ open: true, step: 5, connectOutcome: "subscription" });
    wizard.rerender({ open: true, step: 3, connectOutcome: "subscription" });

    expect(captured()).toEqual([
      ["onboarding_opened", { step: "create_agent" }],
      ["onboarding_step_viewed", { step: "create_agent" }],
    ]);
  });

  it("captures a dismissal once and a reopen as a new session", async () => {
    await startAnalytics();
    const wizard = renderWizard({ open: true, step: 4 });
    act(() => wizard.result.current.opened(4, 4));
    act(() => wizard.result.current.opened(4, 4));
    act(() => wizard.result.current.dismissed(4));
    act(() => wizard.result.current.dismissed(4));
    wizard.rerender({ open: false, step: 1, connectOutcome: "subscription" });
    wizard.rerender({ open: true, step: 1, connectOutcome: "subscription" });
    act(() => wizard.result.current.opened(3, 1));

    expect(captured()).toEqual([
      ["onboarding_opened", { step: "connect_model" }],
      ["onboarding_step_viewed", { step: "connect_model" }],
      ["onboarding_dismissed", { step: "connect_model" }],
      ["onboarding_opened", { step: "create_agent" }],
      ["onboarding_step_viewed", { step: "create_agent" }],
    ]);
  });

  it("captures a dismissal when the wizard closes before launch", async () => {
    await startAnalytics();
    const wizard = renderWizard({ open: true, step: 3 });
    act(() => wizard.result.current.opened(3, 3));
    wizard.rerender({ open: true, step: 4, connectOutcome: "subscription" });
    wizard.rerender({ open: false, step: 1, connectOutcome: "subscription" });
    wizard.rerender({ open: false, step: 1, connectOutcome: "subscription" });

    expect(captured()).toEqual([
      ["onboarding_opened", { step: "create_agent" }],
      ["onboarding_step_viewed", { step: "create_agent" }],
      ["onboarding_step_completed", { step: "create_agent" }],
      ["onboarding_step_viewed", { step: "connect_model" }],
      ["onboarding_dismissed", { step: "connect_model" }],
    ]);
  });

  it("captures nothing in the wizard when consent is not granted", async () => {
    syncProductAnalytics(config, "ask", { load, schedule, immediate: true });
    const wizard = renderWizard({ open: true, step: 3 });
    act(() => wizard.result.current.opened(3, 3));
    wizard.rerender({ open: true, step: 4, connectOutcome: "subscription" });
    act(() => wizard.result.current.dismissed(4));
    expect(client.capture).not.toHaveBeenCalled();
  });

  it("captures structured onboarding failures and drops unsafe provider strings", async () => {
    await startAnalytics();
    captureOnboardingStepFailed({
      step: "connect_model",
      reason: "api_key_save_failed",
      provider: "Anthropic",
      method: "api_key",
    });
    captureOnboardingStepFailed({
      step: "connect_model",
      reason: "subscription_login_failed",
      provider: "secret token=sk-123",
      method: "subscription",
    });
    captureOnboardingStepFailed({
      step: "launch",
      reason: "greeting_failed",
    });
    expect(captured()).toEqual([
      ["onboarding_step_failed", { step: "connect_model", reason: "api_key_save_failed", provider: "anthropic", method: "api_key" }],
      ["onboarding_step_failed", { step: "connect_model", reason: "subscription_login_failed", method: "subscription" }],
      ["onboarding_step_failed", { step: "launch", reason: "greeting_failed" }],
    ]);
  });

  it("captures agent chat messages with onboarding_chat vs agent_chat surface only", async () => {
    await startAnalytics();
    captureAgentChatMessageSent("onboarding_chat");
    captureAgentChatMessageSent("agent_chat");
    expect(captured()).toEqual([
      ["agent_chat_message_sent", { surface: "onboarding_chat" }],
      ["agent_chat_message_sent", { surface: "agent_chat" }],
    ]);
  });

  it("blocksAgentCreate flags fail results and warn/pass results with missing-auth checks", () => {
    const base = {
      adapterType: "codex_local",
      testedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(blocksAgentCreate({ ...base, status: "fail", checks: [] })).toBe(true);
    expect(
      blocksAgentCreate({
        ...base,
        status: "warn",
        checks: [{ code: ADAPTER_AUTH_MISSING_CHECK_CODE, level: "warn", message: "Auth required" }],
      }),
    ).toBe(true);
    expect(
      blocksAgentCreate({
        ...base,
        status: "pass",
        checks: [{ code: ADAPTER_AUTH_MISSING_CHECK_CODE, level: "warn", message: "Auth required" }],
      }),
    ).toBe(true);
    expect(
      blocksAgentCreate({
        ...base,
        status: "warn",
        checks: [{ code: "other_warning", level: "warn", message: "Non-blocking warning" }],
      }),
    ).toBe(false);
    expect(blocksAgentCreate({ ...base, status: "pass", checks: [] })).toBe(false);
  });

  it("isReportableAdapterLoginFailure covers start/poll/timeout failures and excludes cancellation and retries", () => {
    expect(isReportableAdapterLoginFailure({ active: true, retrying: false, status: "failed", hasFailure: true })).toBe(true);
    expect(isReportableAdapterLoginFailure({ active: true, retrying: false, status: "timed_out", hasFailure: true })).toBe(true);
    expect(isReportableAdapterLoginFailure({ active: true, retrying: false, status: undefined, hasFailure: true })).toBe(true);
    expect(isReportableAdapterLoginFailure({ active: true, retrying: false, status: "cancelled", hasFailure: true })).toBe(false);
    expect(isReportableAdapterLoginFailure({ active: true, retrying: true, status: "failed", hasFailure: true })).toBe(false);
    expect(isReportableAdapterLoginFailure({ active: false, retrying: false, status: "failed", hasFailure: true })).toBe(false);
    expect(isReportableAdapterLoginFailure({ active: true, retrying: false, status: "waiting_for_user", hasFailure: false })).toBe(false);
  });
});
