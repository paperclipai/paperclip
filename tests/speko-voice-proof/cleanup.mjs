/** Preserve final evidence and permit retrying an unconfirmed provider hangup. */
export function createCleanup({ local, provider, report, failed }) {
  let localEnded = false, providerEnded = false, reportSaved = false, pending;
  const attempt = async (operation, action) => {
    try { await action(); return true; }
    catch { failed(operation); return false; }
  };
  return {
    get complete() { return providerEnded && reportSaved; },
    end() {
      if (pending) return pending;
      pending = (async () => {
        let ok = true;
        try {
          if (!localEnded) {
            localEnded = true;
            ok = await attempt('local.cleanup', () => local(async (operation, action) => {
              const succeeded = await attempt(operation, action);
              if (!succeeded) ok = false;
            })) && ok;
          }
          if (!providerEnded) providerEnded = await attempt('session.end', provider);
          ok = providerEnded && ok;
        } finally {
          reportSaved = await attempt('report.save', report);
        }
        return ok && reportSaved;
      })().finally(() => { pending = undefined; });
      return pending;
    },
  };
}
