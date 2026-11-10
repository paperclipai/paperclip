type Check = { reason: string; state: string };
/** Early diagnostics are only a fail-fast blocker inventory, never sleep proof.
 * The registered-probe aggregate includes the real 10-minute API activity hold;
 * it cannot distinguish other probes, so the later full cooldown/proof is mandatory. */
export function assertEarlySleepDiagnostics(report: { idleSleepSafety?: { diagnostics?: { complete?: boolean; checks?: Check[] } } }, elapsedSinceApiMs: number) {
  const diagnostics = report.idleSleepSafety?.diagnostics;
  if (!Number.isFinite(elapsedSinceApiMs) || elapsedSinceApiMs < 0 || elapsedSinceApiMs >= 600_000) throw new Error('Early diagnostic requires the actual API cooldown still active');
  if (diagnostics?.complete !== true || !Array.isArray(diagnostics.checks)) throw new Error('Early diagnostic coverage incomplete');
  const expected = new Map([['local.registered_probes', 'present'], ['local.inspection', 'present'], ['backup.checkpoint', 'not_checked']]);
  const seen = new Set<string>();
  for (const check of diagnostics.checks) {
    if (seen.has(check.reason) || check.state !== (expected.get(check.reason) ?? 'none')) throw new Error(`Unexpected early sleep blocker: ${check.reason}=${check.state}`);
    seen.add(check.reason);
  }
  for (const required of [...expected.keys(), 'inspection.hold', 'inspection.generation', 'durable.snapshot', 'deadlines.catalog']) {
    if (!seen.has(required)) throw new Error(`Missing early sleep diagnostic: ${required}`);
  }
}
