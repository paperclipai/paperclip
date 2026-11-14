import { afterEach, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>>, autoConfigs: [] as unknown[], start: vi.fn(), shutdown: vi.fn(async () => {}) }));
vi.mock('../peer-version-check.js', () => ({ checkExactPeerVersions: () => ({ ok: true }) }));
vi.mock('@opentelemetry/sdk-node', () => ({ NodeSDK: class {
  constructor(options: Record<string, unknown>) { sdk.options.push(options); }
  start = sdk.start;
  shutdown = sdk.shutdown;
} }));
vi.mock('@opentelemetry/auto-instrumentations-node', () => ({ getNodeAutoInstrumentations: (config: unknown) => { sdk.autoConfigs.push(config); return []; } }));
vi.mock('@opentelemetry/resources', () => ({ resourceFromAttributes: (attributes: unknown) => attributes }));
vi.mock('@opentelemetry/semantic-conventions', () => ({ ATTR_SERVICE_NAME: 'service.name', ATTR_SERVICE_VERSION: 'service.version' }));
vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({ OTLPTraceExporter: class {} }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  sdk.options.length = 0;
  sdk.autoConfigs.length = 0;
  Reflect.deleteProperty(globalThis, Symbol.for('paperclip.otel.started-sdk'));
});
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
  expect(sdk.autoConfigs[0]).toMatchObject({
    '@opentelemetry/instrumentation-express': { ignoreLayersType: ['middleware', 'router'] },
    '@opentelemetry/instrumentation-router': { enabled: false },
  });
  await instrumentation.shutdownInstrumentation();
  expect(sdk.shutdown).toHaveBeenCalledOnce();
});

it('starts tracing after a cached preload first runs before the instance environment loads', async () => {
  vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
  vi.stubEnv('OTEL_EXPORTER_OTLP_PROTOCOL', 'http/json');
  vi.spyOn(process, 'once').mockReturnValue(process);
  vi.resetModules();
  const earlyPreload = await import('../otel-register.js');
  expect(sdk.start).not.toHaveBeenCalled();

  vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://collector.invalid:4318');
  const cachedPreload = await import('../otel-register.js');
  expect(cachedPreload).toBe(earlyPreload);
  const first = cachedPreload.initializeInstrumentation();
  const second = cachedPreload.initializeInstrumentation();
  expect(first).toBe(second);
  await Promise.all([first, second]);
  expect(sdk.start).toHaveBeenCalledOnce();
  expect(sdk.options[0]).toMatchObject({ metricReaders: [], logRecordProcessors: [] });

  const instrumentation = await import('../instrumentation.js');
  await instrumentation.shutdownInstrumentation();
  expect(sdk.shutdown).toHaveBeenCalledOnce();
});
