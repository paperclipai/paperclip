/** Preserve final evidence and permit retrying an unconfirmed provider hangup. */
export function createCleanup({ local, provider, report, failed }) {
  let localEnded = false, providerEnded = false, reportSaved = false, pending;
  const localSuccesses = new Set();
  const attempt = async (operation, action) => {
    try { await action(); return true; }
    catch { failed(operation); return false; }
  };
  return {
    get complete() { return localEnded && providerEnded && reportSaved; },
    end() {
      if (pending) return pending;
      pending = (async () => {
        let ok = true;
        try {
          if (!localEnded) {
            let localOk = true;
            const completed = await attempt('local.cleanup', () => local(async (operation, action) => {
              if (localSuccesses.has(operation)) return;
              const succeeded = await attempt(operation, action);
              if (succeeded) localSuccesses.add(operation);
              else localOk = false;
            }));
            localEnded = completed && localOk;
            ok = localEnded && ok;
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
