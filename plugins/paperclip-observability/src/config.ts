/**
 * Configuration types and defaults for the observability plugin.
 */

export interface ObservabilityConfig {
  otlpEndpoint: string;
  serviceName: string;
  serviceVersion: string;
  exportIntervalMs: number;
  enableTracing: boolean;
  enableMetrics: boolean;
  resourceAttributes: Record<string, string>;
}

export const DEFAULT_CONFIG: ObservabilityConfig = {
  otlpEndpoint: "http://localhost:4318",
  serviceName: "paperclip",
  serviceVersion: "0.1.0",
  exportIntervalMs: 60_000,
  enableTracing: true,
  enableMetrics: true,
  resourceAttributes: {},
};

/**
 * Merge raw plugin config (from instanceConfigSchema) with defaults.
 */
export function resolveConfig(
  raw: Record<string, unknown>,
): ObservabilityConfig {
  return {
    otlpEndpoint:
      (raw.otlpEndpoint as string | undefined) ?? DEFAULT_CONFIG.otlpEndpoint,
    serviceName:
      (raw.serviceName as string | undefined) ?? DEFAULT_CONFIG.serviceName,
    serviceVersion:
      (raw.serviceVersion as string | undefined) ??
      DEFAULT_CONFIG.serviceVersion,
    exportIntervalMs:
      (raw.exportIntervalMs as number | undefined) ??
      DEFAULT_CONFIG.exportIntervalMs,
    enableTracing:
      (raw.enableTracing as boolean | undefined) ??
      DEFAULT_CONFIG.enableTracing,
    enableMetrics:
      (raw.enableMetrics as boolean | undefined) ??
      DEFAULT_CONFIG.enableMetrics,
    resourceAttributes:
      (raw.resourceAttributes as Record<string, string> | undefined) ??
      DEFAULT_CONFIG.resourceAttributes,
  };
}
