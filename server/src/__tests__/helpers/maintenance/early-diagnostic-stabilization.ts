import assert from 'node:assert/strict';
import { assertEarlySleepDiagnostics } from './early-sleep-diagnostics.js';
import type { startMaintenanceServer } from './server-harness.js';

type Report = { ownerId: string; draining: boolean; quiescent: boolean; expiresAt: string;
  idleSleepSafety: { diagnostics?: { complete?: boolean; checks?: Array<{ reason: string; state: string }> } } };
const transientStates = new Map([['inspection.generation', 'unknown'], ['local.tracked_work', 'present'], ['plugins.runtime_drain', 'not_checked']]);

export function classifyEarlyDiagnostic(report: Report, elapsedSinceApiMs: number): 'strict' | 'transient' {
  const checks = report.idleSleepSafety.diagnostics?.checks;
  if (!Array.isArray(checks)) throw new Error('Missing early diagnostic checks');
  // A real durable blocker fails now, even if unrelated inspection work is in flight.
  const expectedStates = new Map([['local.registered_probes', 'present'], ['local.inspection', 'present'], ['backup.checkpoint', 'not_checked']]);
  for (const check of checks) {
    if (check.state === (expectedStates.get(check.reason) ?? 'none')) continue;
    if (transientStates.get(check.reason) !== check.state) throw new Error(`Unexpected early sleep blocker: ${check.reason}=${check.state}`);
  }
  if (checks.some(check => transientStates.get(check.reason) === check.state)) return 'transient';
  assertEarlySleepDiagnostics(report, elapsedSinceApiMs);
  return 'strict';
}

/** Bounded setup-only observation, never a quiet-window poll or an uncertainty exemption. */
export async function stabilizeEarlyDiagnostics(server: Awaited<ReturnType<typeof startMaintenanceServer>>, options: {
  ownerId: string; apiSucceededAt: number; read: () => Promise<Report>; persist: (observations: unknown[]) => Promise<void>;
}) {
  const observations: unknown[] = [];
  for (let round = 1; round <= 3; round++) {
    const before = await server.settled();
    observations.push({ round, kind: 'settled-before', at: new Date().toISOString(), snapshot: before }); await options.persist(observations);
    assert(before.managed?.apiActivityActive, 'Actual successful managed API key activity is not held');
    const reports: Report[] = []; let transient = false;
    for (const position of ['initial', 'final']) {
      const report = await options.read(); reports.push(report);
      observations.push({ round, kind: position, at: new Date().toISOString(), report }); await options.persist(observations);
      assert(report.ownerId === options.ownerId && report.draining && report.quiescent && Date.parse(report.expiresAt) > Date.now(), 'Early diagnostic lost exact live hold');
      const classification = classifyEarlyDiagnostic(report, performance.now() - options.apiSucceededAt);
      transient = classification === 'transient' || transient;
    }
    const after = await server.snapshot();
    observations.push({ round, kind: 'snapshot-after', at: new Date().toISOString(), snapshot: after }); await options.persist(observations);
    if (transient) continue;
    assert(before.idle.active === 0 && after.idle.active === 0, 'Accepted early diagnostic has active owned work');
    // Each real HTTP authentication is tracked work. Its generation changes are
    // observer stimuli; each report separately proves its own scan stayed stable.
    assert.deepEqual(reports[0]!.idleSleepSafety, reports[1]!.idleSleepSafety, 'Accepted early diagnostic pair differs');
    assert(after.managed?.apiActivityActive, 'Real managed API activity expired during setup');
    return { rounds: round, initial: reports[0]!, final: reports[1]!, observations,
      boundary: 'Strict complete stable setup inventory with real API cooldown active; not sleep eligibility' };
  }
  throw new Error('Early inspection did not stabilize in three bounded owner-settled rounds');
}
