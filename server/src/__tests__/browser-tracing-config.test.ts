import { describe, expect, it, vi } from "vitest";
import { authSessionSchema } from "@paperclipai/shared";
import { browserTracesUrl, resolveBrowserTracingConfig } from "../browser-tracing-config.js";

const cloud = { PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "tenant-token" };
const ingestKey = "hcaik_" + "0".repeat(58);

describe("resolveBrowserTracingConfig", () => {
  it("is off for a self-hosted instance even with every variable set", () => {
    expect(resolveBrowserTracingConfig({
      PAPERCLIP_BROWSER_TRACES_ENDPOINT: "https://api.honeycomb.io",
      PAPERCLIP_BROWSER_TRACES_INGEST_KEY: ingestKey,
    })).toBeNull();
  });

  it("is off for a cloud instance with no endpoint", () => {
    expect(resolveBrowserTracingConfig({ ...cloud, PAPERCLIP_BROWSER_TRACES_INGEST_KEY: ingestKey })).toBeNull();
  });

  it("is on for a cloud instance with an endpoint and ingest key, with defaults", () => {
    const config = resolveBrowserTracingConfig({
      ...cloud,
      PAPERCLIP_BROWSER_TRACES_ENDPOINT: "https://api.honeycomb.io",
      PAPERCLIP_BROWSER_TRACES_INGEST_KEY: ingestKey,
      SENTRY_ENVIRONMENT: "staging",
    });
    expect(config).toEqual({
      tracesUrl: "https://api.honeycomb.io/v1/traces",
      ingestKey,
      serviceName: "paperclip-web",
      environment: "staging",
      sampleRate: 1,
    });
    expect(authSessionSchema.shape.browserTracing.parse(config)).toEqual(config);
  });

  it("also recognises the managed-config cloud signal", () => {
    expect(resolveBrowserTracingConfig({
      PAPERCLIP_MANAGED_CONFIG: "{}",
      PAPERCLIP_BROWSER_TRACES_ENDPOINT: "https://collector.example.com/otlp",
      PAPERCLIP_BROWSER_TRACES_SAMPLE_RATE: "0.25",
      PAPERCLIP_BROWSER_TRACES_SERVICE_NAME: "board",
      PAPERCLIP_BROWSER_TRACES_ENVIRONMENT: "production",
    })).toEqual({
      tracesUrl: "https://collector.example.com/otlp/v1/traces",
      ingestKey: null,
      serviceName: "board",
      environment: "production",
      sampleRate: 0.25,
    });
  });

  it.each([
    ["a configuration key", { PAPERCLIP_BROWSER_TRACES_INGEST_KEY: "51GYc2configkey00000000" }, "INGEST_KEY is not a Honeycomb ingest key"],
    ["Honeycomb with no key", { PAPERCLIP_BROWSER_TRACES_INGEST_KEY: undefined }, "INGEST_KEY is required"],
    ["plain http", { PAPERCLIP_BROWSER_TRACES_ENDPOINT: "http://api.honeycomb.io" }, "must use https"],
    ["a malformed endpoint", { PAPERCLIP_BROWSER_TRACES_ENDPOINT: "not a url" }, "not a valid URL"],
    ["a malformed sample rate", { PAPERCLIP_BROWSER_TRACES_SAMPLE_RATE: "10%" }, "SAMPLE_RATE must be a number"],
    ["an out-of-range sample rate", { PAPERCLIP_BROWSER_TRACES_SAMPLE_RATE: "2" }, "SAMPLE_RATE must be a number"],
  ])("fails closed with a value-free warning for %s", (_label, override, warning) => {
    const warn = vi.fn();
    expect(resolveBrowserTracingConfig({
      ...cloud,
      PAPERCLIP_BROWSER_TRACES_ENDPOINT: "https://api.honeycomb.io",
      PAPERCLIP_BROWSER_TRACES_INGEST_KEY: ingestKey,
      ...override,
    }, warn)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(warning);
    expect(warn.mock.calls[0]![0]).not.toContain(ingestKey);
  });

  it.each([
    ["0.3", 1 / 3],
    ["0.75", 1],
    ["0.1", 0.1],
    ["0.25", 0.25],
  ])("rounds sample rate %s to an exact 1-in-N rate so Honeycomb weights stay correct", (raw, expected) => {
    expect(resolveBrowserTracingConfig({
      ...cloud,
      PAPERCLIP_BROWSER_TRACES_ENDPOINT: "https://api.honeycomb.io",
      PAPERCLIP_BROWSER_TRACES_INGEST_KEY: ingestKey,
      PAPERCLIP_BROWSER_TRACES_SAMPLE_RATE: raw,
    })?.sampleRate).toBeCloseTo(expected, 12);
  });

  it("treats a zero sample rate as off", () => {
    expect(resolveBrowserTracingConfig({
      ...cloud,
      PAPERCLIP_BROWSER_TRACES_ENDPOINT: "https://api.honeycomb.io",
      PAPERCLIP_BROWSER_TRACES_INGEST_KEY: ingestKey,
      PAPERCLIP_BROWSER_TRACES_SAMPLE_RATE: "0",
    })).toBeNull();
  });
});

describe("browserTracesUrl", () => {
  it("appends the OTLP traces path once and drops query and hash", () => {
    expect(browserTracesUrl(new URL("https://api.eu1.honeycomb.io/"))).toBe("https://api.eu1.honeycomb.io/v1/traces");
    expect(browserTracesUrl(new URL("https://collector.example.com/v1/traces?x=1#y"))).toBe("https://collector.example.com/v1/traces");
  });
});
