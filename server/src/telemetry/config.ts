/**
 * OpenTelemetry configuration resolution from environment variables.
 */

export interface OtelConfig {
  enabled: boolean;
  serviceName: string;
  otlpEndpoint: string | undefined;
  otlpHeaders: Record<string, string>;
  samplingRate: number;
  prometheusPort: number | undefined;
}

export function resolveOtelConfig(): OtelConfig {
  const enabled = process.env.OTEL_ENABLED !== "false";
  const serviceName = process.env.OTEL_SERVICE_NAME ?? "paperclip-server";
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined;
  const samplingRate = parseFloat(process.env.OTEL_SAMPLING_RATE ?? "0.1");
  const prometheusPort = process.env.OTEL_PROMETHEUS_PORT
    ? parseInt(process.env.OTEL_PROMETHEUS_PORT, 10)
    : undefined;

  const otlpHeaders: Record<string, string> = {};
  const rawHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  if (rawHeaders) {
    for (const pair of rawHeaders.split(",")) {
      const eqIdx = pair.indexOf("=");
      if (eqIdx > 0) {
        otlpHeaders[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
      }
    }
  }

  return {
    enabled,
    serviceName,
    otlpEndpoint,
    otlpHeaders,
    samplingRate: Number.isFinite(samplingRate) ? Math.max(0, Math.min(1, samplingRate)) : 0.1,
    prometheusPort,
  };
}
