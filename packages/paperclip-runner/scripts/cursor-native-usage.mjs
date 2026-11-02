/** Self-contained: embedded verbatim into the digest-pinned ACP module.
 * Observations are NOT usage accounting. Native counter semantics remain unknown.
 */
export function createCursorNativeUsage(promptId) {
  if (typeof promptId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(promptId)) throw new Error("Invalid Cursor usage prompt identity");
  const limits = { maxObservations: 64, maxInvocations: 64, maxBytes: 16384 };
  // Reserve bounded ACPX request/message identities and wrapper keys within 16 KiB.
  const envelopeMaxBytes = limits.maxBytes - 640;
  const fields = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"];
  const reasons = new Set(["native_counter_semantics_unverified"]);
  const observations = [];
  const children = new WeakMap();
  const trackedInvocations = new Set(); // At most maxInvocations, including children.
  let closed = false, truncated = false, invocations = 0;
  let finished;
  const envelope = () => ({
    schema: "paperclip.cursor.native-usage.v1", source: "native_turn_ended", promptId,
    completeness: "partial", reasons: [...reasons], observations, limits, truncated,
  });
  const truncate = () => { truncated = true; reasons.add("observation_limit_reached"); };
  function begin(role, nativeRun) {
    if (closed) return null;
    if (invocations >= limits.maxInvocations) { truncate(); return null; }
    const invocationId = `invocation-${++invocations}`;
    let ended = false, sequence = 0;
    const collector = {
      observe(update) {
        if (closed || ended || truncated || update?.message?.case !== "turnEnded") return;
        if (observations.length >= limits.maxObservations) { truncate(); return; }
        const value = update.message.value;
        const counters = {};
        for (const field of fields) {
          const raw = value?.[field];
          if (raw === undefined) continue;
          const number = typeof raw === "bigint" && raw >= 0n && raw <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(raw) : raw;
          if (typeof number === "number" && Number.isSafeInteger(number) && number >= 0) counters[field] = number;
          else reasons.add("invalid_native_counter");
        }
        if (Object.keys(counters).length < fields.length) reasons.add("native_counters_missing");
        if (sequence > 0) reasons.add("multiple_terminal_observations");
        observations.push({ invocationId, role, nativeRun, sequence: ++sequence, counters });
      },
      end() { if (!ended && sequence === 0 && !closed) reasons.add("native_terminal_not_observed"); ended = true; },
    };
    trackedInvocations.add(collector);
    return collector;
  }
  return {
    beginParent() { return begin("parent", invocations + 1); },
    observeChild(child, update) {
      if (closed || !child || child.terminal) return;
      if (!Number.isSafeInteger(child.runs) || child.runs < 1) { reasons.add("child_run_attribution_unverified"); return; }
      // The native callback identifies only the child, not its run generation.
      // After ID reuse, delayed old-run updates cannot be distinguished safely.
      if (child.runs !== 1) { reasons.add("child_run_attribution_unverified"); return; }
      let run = children.get(child);
      if (!run || run.nativeRun !== child.runs) {
        run?.collector?.end();
        run = { nativeRun: child.runs, collector: begin("child", child.runs) };
        children.set(child, run);
      }
      run.collector?.observe(update);
    },
    finish() {
      if (finished !== undefined) return JSON.parse(finished);
      for (const invocation of trackedInvocations) invocation.end();
      trackedInvocations.clear();
      closed = true;
      if (observations.length === 0) reasons.add("native_terminal_not_observed");
      // Bound the FINAL envelope after every reason has been added. Its fixed
      // ASCII keys/IDs/reasons make JSON length equal to its UTF-8 byte length.
      finished = JSON.stringify(envelope());
      while (finished.length > envelopeMaxBytes && observations.length > 0) {
        observations.pop(); truncate(); finished = JSON.stringify(envelope());
      }
      // Detached snapshot: late provider callbacks cannot mutate a returned receipt.
      return JSON.parse(finished);
    },
    close() { closed = true; trackedInvocations.clear(); },
  };
}
