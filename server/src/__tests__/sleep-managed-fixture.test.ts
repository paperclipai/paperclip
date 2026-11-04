import { afterEach, expect, it, vi } from 'vitest';
import { createMaintenanceS3Boundary, decodeMaintenanceAwsChunks } from './helpers/maintenance/s3-boundary.js';
import { withMaintenanceProvider } from './helpers/maintenance/server-harness.js';
import { createS3StorageProvider } from '../storage/s3-provider.js';
import { classifyEarlyDiagnostic, stabilizeEarlyDiagnostics } from './helpers/maintenance/early-diagnostic-stabilization.js';

afterEach(() => vi.unstubAllEnvs());
it('uses real small-object SDK HTTP with conditional bytes, reads and deletion; unknown operations fail closed', async () => {
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'owned-fixture'); vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'owned-fixture'); vi.stubEnv('AWS_SESSION_TOKEN', undefined);
  const fixture = createMaintenanceS3Boundary();
  await withMaintenanceProvider(fixture.server, async endpoint => {
    const provider = createS3StorageProvider({ bucket: 'maintenance-test', region: 'us-east-1', endpoint, forcePathStyle: true });
    const input = { objectKey: 'owned/value', contentType: 'text/plain', contentLength: 3, body: Buffer.from('one') };
    const first = await provider.putObjectConditional!({ ...input, ifNoneMatch: '*' });
    expect(first.etag).toBeTruthy();
    await expect(provider.putObjectConditional!({ ...input, ifNoneMatch: '*' })).rejects.toMatchObject({ name: 'PreconditionFailed' });
    await expect(provider.putObjectConditional!({ ...input, ifMatch: 'wrong' })).rejects.toMatchObject({ name: 'PreconditionFailed' });
    await provider.putObjectConditional!({ ...input, body: Buffer.from('two'), ifMatch: first.etag });
    const object = await provider.getObject({ objectKey: input.objectKey }); const chunks: Buffer[] = [];
    for await (const chunk of object.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('two'); expect((await provider.headObject({ objectKey: input.objectKey })).exists).toBe(true);
    expect((await provider.listObjects!({ prefix: 'owned/' })).keys).toEqual([input.objectKey]);
    await provider.deleteObject({ objectKey: input.objectKey }); expect((await provider.headObject({ objectKey: input.objectKey })).exists).toBe(false);
    expect(fixture.snapshot().errors).toEqual([]);
    const unknown = await fetch(`${endpoint}/maintenance-test/key?uploads`, { method: 'POST' }); expect(unknown.status).toBe(501);
    expect(fixture.snapshot().errors).toHaveLength(1);
  });
});
it('decodes only complete bounded AWS checksum chunks and refuses malformed framing', () => {
  expect(decodeMaintenanceAwsChunks(Buffer.from('3\r\none\r\n3\r\ntwo\r\n0\r\nx-amz-checksum-crc32:YWJj\r\n\r\n')).toString()).toBe('onetwo');
  for (const wire of ['3\r\none', '3;signature=unknown\r\none\r\n0\r\n\r\n', '0\r\nunknown:secret\r\n\r\n']) expect(() => decodeMaintenanceAwsChunks(Buffer.from(wire))).toThrow();
});
it('retries only observed transient inspection states and rejects durable blockers even alongside them', () => {
  const checks = [
    { reason: 'local.registered_probes', state: 'present' }, { reason: 'local.inspection', state: 'present' },
    { reason: 'backup.checkpoint', state: 'not_checked' }, { reason: 'inspection.hold', state: 'none' },
    { reason: 'inspection.generation', state: 'unknown' }, { reason: 'local.tracked_work', state: 'present' },
    { reason: 'plugins.runtime_drain', state: 'not_checked' }, { reason: 'durable.snapshot', state: 'none' },
    { reason: 'deadlines.catalog', state: 'none' },
  ];
  const report = { ownerId: 'owned', draining: true, quiescent: true, expiresAt: '2099-01-01T00:00:00Z', idleSleepSafety: { diagnostics: { complete: false, checks } } };
  expect(classifyEarlyDiagnostic(report, 90_000)).toBe('transient');
  const durable = structuredClone(report); durable.idleSleepSafety.diagnostics.checks.push({ reason: 'chat_endpoints', state: 'present' });
  expect(() => classifyEarlyDiagnostic(durable, 90_000)).toThrow('chat_endpoints');
  const unknown = structuredClone(report); unknown.idleSleepSafety.diagnostics.checks.push({ reason: 'deadlines.reader', state: 'unknown' });
  expect(() => classifyEarlyDiagnostic(unknown, 90_000)).toThrow('deadlines.reader');
  for (const check of report.idleSleepSafety.diagnostics.checks) if (['inspection.generation', 'local.tracked_work', 'plugins.runtime_drain'].includes(check.reason)) check.state = 'none';
  report.idleSleepSafety.diagnostics.complete = true; expect(classifyEarlyDiagnostic(report, 90_000)).toBe('strict');
});

it('retains observer generation changes and still rejects a second durable report after a transient first', async () => {
  const checks = [
    { reason: 'local.registered_probes', state: 'present' }, { reason: 'local.inspection', state: 'present' },
    { reason: 'backup.checkpoint', state: 'not_checked' }, ...['inspection.hold', 'inspection.generation', 'durable.snapshot', 'deadlines.catalog'].map(reason => ({ reason, state: 'none' })),
  ];
  const strict = { ownerId: 'owned', draining: true, quiescent: true, expiresAt: '2099-01-01T00:00:00Z', idleSleepSafety: { diagnostics: { complete: true, checks } } };
  const observations: unknown[][] = [];
  const server = { settled: async () => ({ idle: { active: 0, generation: 10 }, managed: { apiActivityActive: true } }),
    snapshot: async () => ({ idle: { active: 0, generation: 14 }, managed: { apiActivityActive: true } }) } as unknown as Parameters<typeof stabilizeEarlyDiagnostics>[0];
  const accepted = await stabilizeEarlyDiagnostics(server, { ownerId: 'owned', apiSucceededAt: performance.now(), read: async () => structuredClone(strict), persist: async values => { observations.push(structuredClone(values)); } });
  expect(accepted.rounds).toBe(1); expect(observations.at(-1)).toHaveLength(4);
  const transient = structuredClone(strict); transient.idleSleepSafety.diagnostics.complete = false;
  transient.idleSleepSafety.diagnostics.checks.find(check => check.reason === 'inspection.generation')!.state = 'unknown';
  const blocked = structuredClone(transient); blocked.idleSleepSafety.diagnostics.checks.push({ reason: 'chat_endpoints', state: 'present' });
  let reads = 0;
  await expect(stabilizeEarlyDiagnostics(server, { ownerId: 'owned', apiSucceededAt: performance.now(), read: async () => reads++ ? blocked : transient,
    persist: async values => { observations.push(structuredClone(values)); } })).rejects.toThrow('chat_endpoints');
  expect(reads).toBe(2);
});
