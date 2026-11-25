import { describe, expect, it } from "vitest";
import { isPostHogDirectDeliveryEnabled, resolveCloudPostHogConfig } from "../services/cloud-posthog-config.js";

const CLOUD = {
  PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "tenant-token",
  PAPERCLIP_CLOUD_STACK_ID: "stack-123",
  PAPERCLIP_POSTHOG_PROJECT_TOKEN: "phc_test",
};

describe("resolveCloudPostHogConfig", () => {
  it("is null on a self-hosted install, even with a PostHog token", () => {
    expect(resolveCloudPostHogConfig({})).toBeNull();
    expect(
      resolveCloudPostHogConfig({ PAPERCLIP_POSTHOG_PROJECT_TOKEN: "phc_test", PAPERCLIP_CLOUD_STACK_ID: "stack-123" }),
    ).toBeNull();
  });

  it("is null on Cloud without a token or without a stack id", () => {
    expect(resolveCloudPostHogConfig({ ...CLOUD, PAPERCLIP_POSTHOG_PROJECT_TOKEN: "" })).toBeNull();
    expect(resolveCloudPostHogConfig({ ...CLOUD, PAPERCLIP_POSTHOG_PROJECT_TOKEN: "  " })).toBeNull();
    expect(resolveCloudPostHogConfig({ ...CLOUD, PAPERCLIP_CLOUD_STACK_ID: undefined })).toBeNull();
  });

  it("resolves defaults on a Cloud stack with a token", () => {
    expect(resolveCloudPostHogConfig(CLOUD)).toEqual({
      token: "phc_test",
      host: "https://us.i.posthog.com",
      environment: null,
      stackId: "stack-123",
      directEnabled: true,
      browserEnabled: false,
      replayEnabled: false,
      replayWorkContentEnabled: false,
      cloudTrialInferenceEnabled: false,
    });
  });

  it("resolves cloudTrialInferenceEnabled from PAPERCLIP_MANAGED_CONFIG and fails closed when invalid", () => {
    expect(
      resolveCloudPostHogConfig({
        ...CLOUD,
        PAPERCLIP_MANAGED_CONFIG: JSON.stringify({ features: { enableCloudTrialInference: true } }),
      })?.cloudTrialInferenceEnabled,
    ).toBe(true);
    expect(
      resolveCloudPostHogConfig({
        ...CLOUD,
        PAPERCLIP_MANAGED_CONFIG: JSON.stringify({ features: { enableCloudTrialInference: false } }),
      })?.cloudTrialInferenceEnabled,
    ).toBe(false);
    expect(
      resolveCloudPostHogConfig({
        ...CLOUD,
        PAPERCLIP_MANAGED_CONFIG: "{not-json",
      })?.cloudTrialInferenceEnabled,
    ).toBe(false);
  });

  it("accepts the legacy managed-config Cloud signal", () => {
    const { PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: _omit, ...rest } = CLOUD;
    expect(resolveCloudPostHogConfig({ ...rest, PAPERCLIP_MANAGED_CONFIG: "{}" })?.stackId).toBe("stack-123");
  });

  it("reads host, environment and the switches", () => {
    const config = resolveCloudPostHogConfig({
      ...CLOUD,
      PAPERCLIP_POSTHOG_HOST: "http://127.0.0.1:9999/",
      PAPERCLIP_POSTHOG_ENVIRONMENT: "staging",
      PAPERCLIP_POSTHOG_DIRECT: "0",
      PAPERCLIP_POSTHOG_BROWSER_ENABLED: "1",
    });
    expect(config).toMatchObject({
      host: "http://127.0.0.1:9999",
      environment: "staging",
      directEnabled: false,
      browserEnabled: true,
      replayEnabled: true,
    });
  });

  it("turns replay off with its own switch and never without the browser switch", () => {
    expect(
      resolveCloudPostHogConfig({
        ...CLOUD,
        PAPERCLIP_POSTHOG_BROWSER_ENABLED: "1",
        PAPERCLIP_POSTHOG_REPLAY_ENABLED: "0",
      })?.replayEnabled,
    ).toBe(false);
    expect(resolveCloudPostHogConfig({ ...CLOUD, PAPERCLIP_POSTHOG_REPLAY_ENABLED: "1" })?.replayEnabled).toBe(false);
  });

  it("turns direct delivery on only with the switch on and an environment", () => {
    expect(isPostHogDirectDeliveryEnabled(null)).toBe(false);
    expect(isPostHogDirectDeliveryEnabled(resolveCloudPostHogConfig(CLOUD))).toBe(false);
    expect(
      isPostHogDirectDeliveryEnabled(resolveCloudPostHogConfig({ ...CLOUD, PAPERCLIP_POSTHOG_ENVIRONMENT: "staging" })),
    ).toBe(true);
    expect(
      isPostHogDirectDeliveryEnabled(
        resolveCloudPostHogConfig({ ...CLOUD, PAPERCLIP_POSTHOG_ENVIRONMENT: "staging", PAPERCLIP_POSTHOG_DIRECT: "0" }),
      ),
    ).toBe(false);
  });

  it.each([undefined, "", "0", "true", "invalid", "1", " 1 "])(
    "requires an explicit work content opt-in: %s",
    (value) => {
      const config = resolveCloudPostHogConfig({
        ...CLOUD,
        PAPERCLIP_POSTHOG_BROWSER_ENABLED: "1",
        PAPERCLIP_POSTHOG_REPLAY_WORK_CONTENT_ENABLED: value,
      });
      expect(config?.replayEnabled).toBe(true);
      expect(config?.replayWorkContentEnabled).toBe(value?.trim() === "1");
    },
  );

  it("cannot enable work content without browser analytics and replay", () => {
    const env = { ...CLOUD, PAPERCLIP_POSTHOG_REPLAY_WORK_CONTENT_ENABLED: "1" };
    expect(resolveCloudPostHogConfig(env)?.replayWorkContentEnabled).toBe(false);
    expect(resolveCloudPostHogConfig({
      ...env,
      PAPERCLIP_POSTHOG_BROWSER_ENABLED: "1",
      PAPERCLIP_POSTHOG_REPLAY_ENABLED: "0",
    })?.replayWorkContentEnabled).toBe(false);
  });
});
