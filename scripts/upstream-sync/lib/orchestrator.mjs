export async function runUpstreamSync({ config }) {
  return {
    branchName: `${config.branchPrefix}/sync`,
    reportPath: 'reports/upstream-sync-report.md',
    prBodyPath: 'reports/upstream-sync-pr-body.md',
    status: config.dryRun ? 'dry-run' : 'ok',
  };
}
