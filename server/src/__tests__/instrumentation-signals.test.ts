import { afterEach, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>>, start: vi.fn(), shutdown: vi.fn(async () => {}) }));
vi.mock('../peer-version-check.js', () => ({ checkExactPeerVersions: () => ({ ok: true }) }));
vi.mock('@opentelemetry/sdk-node', () => ({ NodeSDK: class {
  constructor(options: Record<string, unknown>) { sdk.options.push(options); }
  start = sdk.start;
  shutdown = sdk.shutdown;
} }));
vi.mock('@opentelemetry/auto-instrumentations-node', () => ({ getNodeAutoInstrumentations: () => [] }));
vi.mock('@opentelemetry/resources', () => ({ resourceFromAttributes: (attributes: unknown) => attributes }));
vi.mock('@opentelemetry/semantic-conventions', () => ({ ATTR_SERVICE_NAME: 'service.name', ATTR_SERVICE_VERSION: 'service.version' }));
vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({ OTLPTraceExporter: class {} }));

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it('configures current plural SDK signal options so an opted-in trace exporter cannot enable default metrics or logs', async () => {
  vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://collector.invalid:4318');
  vi.stubEnv('OTEL_EXPORTER_OTLP_PROTOCOL', 'http/json');
  vi.spyOn(process, 'once').mockReturnValue(process);
  vi.resetModules();
  const instrumentation = await import('../instrumentation.js');
  await instrumentation.instrumentationReady;
  expect(sdk.options).toHaveLength(1);
  expect(sdk.options[0]).toMatchObject({ metricReaders: [], logRecordProcessors: [], traceExporter: expect.any(Object) });
  expect(sdk.options[0]).not.toHaveProperty('metricReader');
  expect(sdk.options[0]).not.toHaveProperty('logRecordProcessor');
  expect(sdk.start).toHaveBeenCalledOnce();
  await instrumentation.shutdownInstrumentation();
  expect(sdk.shutdown).toHaveBeenCalledOnce();
});
