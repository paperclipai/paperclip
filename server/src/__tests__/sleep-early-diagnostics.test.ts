import { expect, it } from 'vitest';
import { assertEarlySleepDiagnostics } from './helpers/maintenance/early-sleep-diagnostics.js';
const fixture = () => ({ idleSleepSafety: { diagnostics: { complete: true, checks: [
  { reason: 'local.registered_probes', state: 'present' }, { reason: 'local.inspection', state: 'present' },
  { reason: 'backup.checkpoint', state: 'not_checked' }, ...['inspection.hold', 'inspection.generation', 'durable.snapshot', 'deadlines.catalog', 'issues'].map(reason => ({ reason, state: 'none' })),
] } } });
it('retains only explicit early cooldown/diagnostic-backup reasons and refuses every unexpected or unknown blocker', () => {
  expect(() => assertEarlySleepDiagnostics(fixture(), 90_000)).not.toThrow();
  for (const [reason, state] of [['issues', 'present'], ['deadlines.catalog', 'unknown'], ['inspection.hold', 'not_checked'], ['local.registered_probes', 'unknown']]) {
    const f = fixture(); f.idleSleepSafety.diagnostics.checks.find(check => check.reason === reason)!.state = state;
    expect(() => assertEarlySleepDiagnostics(f, 90_000)).toThrow('Unexpected');
  }
  const missing = fixture(); missing.idleSleepSafety.diagnostics.checks.shift(); expect(() => assertEarlySleepDiagnostics(missing, 90_000)).toThrow('Missing');
  for (const duration of [NaN, Infinity, -1, 600_000]) expect(() => assertEarlySleepDiagnostics(fixture(), duration)).toThrow('cooldown');
});
