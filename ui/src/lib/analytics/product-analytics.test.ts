// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserAnalyticsConfig } from "@paperclipai/shared";
import {
  buildPostHogInitOptions,
  cancelPendingProductAnalytics,
  resetProductAnalyticsForTest,
  scrubCapturedEvent,
  setProductAnalyticsUser,
  startProductAnalytics,
  type ProductAnalyticsClient,
} from "./product-analytics";

const config: BrowserAnalyticsConfig = {
  token: "phc_test",
  apiHost: "/_ph",
  uiHost: "https://us.posthog.com",
  environment: "staging",
  stackId: "stack-1",
  replayEnabled: true,
};

function mockClient() {
  return {
    init: vi.fn(),
    register: vi.fn(),
    identify: vi.fn(),
    group: vi.fn(),
    reset: vi.fn(),
  } satisfies { [K in keyof ProductAnalyticsClient]: ReturnType<typeof vi.fn> };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("product analytics", () => {
  let client: ReturnType<typeof mockClient>;
  let load: ReturnType<typeof vi.fn<() => Promise<ProductAnalyticsClient>>>;
  let scheduled: (() => void) | null;
  const schedule = (start: () => void) => {
    scheduled = start;
    return () => { scheduled = null; };
  };

  beforeEach(() => {
    client = mockClient();
    load = vi.fn(async () => client as unknown as ProductAnalyticsClient);
    scheduled = null;
  });

  afterEach(() => resetProductAnalyticsForTest());

  it("does not load posthog-js until the page settles", async () => {
    startProductAnalytics(config, { load, schedule });
    await flush();
    expect(load).not.toHaveBeenCalled();
    scheduled!();
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(client.init).toHaveBeenCalledWith("phc_test", expect.objectContaining({ api_host: "/_ph" }));
    expect(client.register).toHaveBeenCalledWith({ deployment_source: "cloud", environment: "staging" });
  });

  it("loads once when the scheduler calls back twice (settled page and deadline)", async () => {
    let starts: Array<() => void> = [];
    startProductAnalytics(config, { load, schedule: (start) => { starts = [start, start]; return () => {}; } });
    starts[0]!();
    starts[1]!();
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("never loads when cancelled before the page settles", async () => {
    startProductAnalytics(config, { load, schedule });
    cancelPendingProductAnalytics();
    expect(scheduled).toBeNull();
    await flush();
    expect(load).not.toHaveBeenCalled();
  });

  it("identifies the signed-in user with email and name as person properties, then joins the workspace group", async () => {
    setProductAnalyticsUser({ id: "user-1", email: "jane@example.com", name: "Jane" });
    startProductAnalytics(config, { load, schedule });
    scheduled!();
    await flush();
    expect(client.identify).toHaveBeenCalledWith("user-1", { email: "jane@example.com", name: "Jane" });
    expect(client.group).toHaveBeenCalledWith("workspace", "stack-1");
    // Email and name never become super (event) properties.
    for (const [props] of client.register.mock.calls) {
      expect(props).not.toHaveProperty("email");
      expect(props).not.toHaveProperty("name");
    }
  });

  it("identifies a user who signs in after posthog-js loaded, once", async () => {
    startProductAnalytics(config, { load, schedule });
    scheduled!();
    await flush();
    expect(client.identify).not.toHaveBeenCalled();
    setProductAnalyticsUser({ id: "user-1", email: null, name: null });
    setProductAnalyticsUser({ id: "user-1", email: null, name: null });
    expect(client.identify).toHaveBeenCalledTimes(1);
    expect(client.identify).toHaveBeenCalledWith("user-1", {});
  });

  it("resets identity on sign-out and keeps the deployment super properties", async () => {
    setProductAnalyticsUser({ id: "user-1", email: "jane@example.com", name: "Jane" });
    startProductAnalytics(config, { load, schedule });
    scheduled!();
    await flush();
    client.register.mockClear();
    setProductAnalyticsUser(null);
    expect(client.reset).toHaveBeenCalledTimes(1);
    expect(client.register).toHaveBeenCalledWith({ deployment_source: "cloud", environment: "staging" });
    setProductAnalyticsUser({ id: "user-2", email: null, name: null });
    expect(client.identify).toHaveBeenLastCalledWith("user-2", {});
  });

  it("does not reset an anonymous visitor", async () => {
    startProductAnalytics(config, { load, schedule });
    scheduled!();
    await flush();
    setProductAnalyticsUser(null);
    expect(client.reset).not.toHaveBeenCalled();
  });

  it("builds privacy-safe init options", () => {
    const options = buildPostHogInitOptions(config, "acme.paperclip.app");
    expect(options).toMatchObject({
      api_host: "/_ph",
      ui_host: "https://us.posthog.com",
      person_profiles: "identified_only",
      capture_pageview: "history_change",
      capture_pageleave: true,
      autocapture: true,
      mask_all_text: true,
      mask_all_element_attributes: true,
      capture_performance: { web_vitals: true },
      enable_heatmaps: true,
      disable_session_recording: false,
      tracing_headers: ["acme.paperclip.app"],
      session_recording: { maskAllInputs: true, blockClass: "ph-no-capture" },
    });
    // Replay masks text only inside customer content, secrets and editable content.
    expect(options.session_recording?.maskTextSelector).toBe(".ph-mask, .ph-sensitive, .ph-no-capture, [contenteditable]:not([contenteditable=\"false\"])");
    expect(options.session_recording).not.toHaveProperty("maskTextFn");
    expect(options.session_recording?.maskAttributeFn).toBeTypeOf("function");
    expect(options).toMatchObject({ disable_surveys: true, disable_product_tours: true, disable_web_experiments: true, disable_conversations: true });
    expect(buildPostHogInitOptions({ ...config, replayEnabled: false }, "x").disable_session_recording).toBe(true);
  });

  it("drops the page title, which names tasks and organizations, from every event", () => {
    const event = {
      uuid: "u",
      event: "$pageview",
      properties: { title: "Customer task title · Verify Co", $title: "x", $current_url: "https://acme.paperclip.app/VER/issues/VER-1" },
    } as unknown as Parameters<typeof scrubCapturedEvent>[0];
    expect(scrubCapturedEvent(event)?.properties).toEqual({ $current_url: "https://acme.paperclip.app/VER/issues/VER-1" });
    expect(buildPostHogInitOptions(config, "x").before_send).toBe(scrubCapturedEvent);
    expect(scrubCapturedEvent(null)).toBeNull();
  });

  it("redacts one-time tokens from URLs in events and replay meta, and keeps compressed replay data intact", () => {
    const gz = "\x1f\x8b\x08binary/board-claim/zzz";
    const event = {
      uuid: "u",
      event: "$snapshot",
      properties: {
        $current_url: "https://acme.paperclip.app/board-claim/claim-secret-123",
        $referrer: "https://acme.paperclip.app/cli-auth/abc?token=cli-secret-456",
        $set_once: { $initial_current_url: "https://acme.paperclip.app/invite/invite-secret-789" },
        $snapshot_data: [{ type: 4, data: { href: "https://acme.paperclip.app/oauth-handoff?code=c1&state=s1" } }, { type: 2, data: gz }],
        $pathname: "/VER/issues/VER-1",
      },
    } as unknown as Parameters<typeof scrubCapturedEvent>[0];
    const out = JSON.stringify(scrubCapturedEvent(event));
    for (const secret of ["claim-secret-123", "cli-secret-456", "invite-secret-789", "code=c1", "state=s1"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("/board-claim/REDACTED");
    expect(out).toContain("/VER/issues/VER-1");
    const data = (scrubCapturedEvent(event)!.properties.$snapshot_data as Array<{ data: unknown }>)[1]!.data;
    expect(data).toBe(gz);
  });

  it("keeps the event timestamp a Date", () => {
    const timestamp = new Date("2026-11-17T12:00:00Z");
    const event = { uuid: "u", event: "$pageview", timestamp, properties: { $current_url: "https://a.paperclip.app/x?y=1" } } as unknown as Parameters<typeof scrubCapturedEvent>[0];
    const out = scrubCapturedEvent(event)!;
    expect(out.timestamp).toBeInstanceOf(Date);
    expect(out.timestamp).toBe(timestamp);
    expect(out.properties.$current_url).toBe("https://a.paperclip.app/x");
  });

  it("registers cloud-trial-inference experiment super properties and $set_once cohort on identify", async () => {
    const treatmentConfig: BrowserAnalyticsConfig = {
      ...config,
      cloudTrialInferenceEnabled: true,
    };
    setProductAnalyticsUser({ id: "user-9", email: "alex@example.com", name: "Alex" });
    startProductAnalytics(treatmentConfig, { load, schedule });
    scheduled!();
    await flush();

    expect(client.register).toHaveBeenCalledWith({
      deployment_source: "cloud",
      environment: "staging",
      cloud_trial_inference_enabled: true,
      "$feature/cloud-trial-inference": "treatment",
    });
    expect(client.identify).toHaveBeenCalledWith(
      "user-9",
      { email: "alex@example.com", name: "Alex" },
      { cloud_trial_inference_cohort: "treatment" },
    );
  });
});
