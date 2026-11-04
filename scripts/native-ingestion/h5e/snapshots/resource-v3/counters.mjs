import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function createCounters(record = () => {}) {
  const totals = { normalizedEvents: 0, postCommitEvents: 0, duplicateReceipts: 0,
    postCommitMarkers: 0, queryBuildAttempts: 0, beginInvocations: 0,
    beginAcknowledged: 0, beginResolved: 0, beginRejected: 0,
    beginRejectedBeforeAcknowledgment: 0, scopesPending: 0,
    outerScopes: 0, nestedScopes: 0, outerWorkRejected: 0, nestedWorkRejected: 0,
    outerCommitRequested: 0, outerCommitAcknowledged: 0, outerCommitFailed: 0,
    outerPrepareRequested: 0, outerPrepareAcknowledged: 0, outerPrepareFailed: 0,
    outerRollbackAcknowledged: 0, outerRollbackFailed: 0,
    nestedRollbackAcknowledged: 0, nestedRollbackFailed: 0, nestedWorkSucceeded: 0 };
  const queryBuildVerbs = {}, identities = new Set();
  let nextBegin = 0;
  const prefix = scope => scope.nested ? 'nested' : 'outer';
  const api = {
    normalized() { totals.normalizedEvents++; },
    queryBuild(statement) {
      totals.queryBuildAttempts++;
      const verb = statement.trim().match(/^[a-z]+/i)?.[0].toLowerCase() ?? 'other';
      queryBuildVerbs[verb] = (queryBuildVerbs[verb] ?? 0) + 1;
    },
    beginStarted() { totals.beginInvocations++; return { id: ++nextBegin, acknowledged: false, settled: false }; },
    beginAck(begin) { assert.equal(begin.acknowledged, false); begin.acknowledged = true; totals.beginAcknowledged++; },
    beginResolved(begin) { assert.equal(begin.settled, false); begin.settled = true; totals.beginResolved++; },
    beginRejected(begin) {
      assert.equal(begin.settled, false); begin.settled = true; totals.beginRejected++;
      if (!begin.acknowledged) totals.beginRejectedBeforeAcknowledgment++;
    },
    scopeStarted(begin, nested) {
      assert.equal(begin.acknowledged, true);
      totals[nested ? 'nestedScopes' : 'outerScopes']++; totals.scopesPending++;
      return { begin, nested, finished: false, completion: null, outcome: null };
    },
    scopeFinished(scope) { assert.equal(scope.finished, false); scope.finished = true; totals.scopesPending--; },
    workRejected(scope) { totals[prefix(scope) + 'WorkRejected']++; },
    rollbackAck(scope) { totals[prefix(scope) + 'RollbackAcknowledged']++; },
    rollbackFailed(scope) { totals[prefix(scope) + 'RollbackFailed']++; },
    completionRequested(scope, prepared) {
      assert.equal(scope.nested, false); assert.equal(scope.completion, null);
      scope.completion = prepared ? 'Prepare' : 'Commit';
      totals['outer' + scope.completion + 'Requested']++;
    },
    completionAck(scope) {
      assert.ok(scope.completion); assert.equal(scope.outcome, null); scope.outcome = 'ack';
      totals['outer' + scope.completion + 'Acknowledged']++;
      record({ kind: 'outer-transaction-completion-ack', beginId: scope.begin.id,
        completion: scope.completion.toLowerCase(), apiAlreadyRejected: scope.begin.settled });
    },
    completionFailed(scope) {
      assert.ok(scope.completion); assert.equal(scope.outcome, null); scope.outcome = 'failed';
      totals['outer' + scope.completion + 'Failed']++;
    },
    nestedSucceeded(scope) { assert.equal(scope.nested, true); totals.nestedWorkSucceeded++; },
    postCommit(event, disposition) {
      if (disposition === 'duplicate') { totals.duplicateReceipts++; return; }
      assert.equal(disposition, 'committed');
      assert.ok(event.runId && event.sourceInstanceId && event.sourceEventId);
      const identity = JSON.stringify([event.runId, event.sourceInstanceId, event.sourceEventId]);
      assert.equal(identities.has(identity), false, 'Repeated committed source identity');
      assert.ok(identities.size < 262144, 'Committed-identity observer bound exceeded');
      identities.add(identity); totals.postCommitEvents++;
      if (event.eventType !== 'item.delta' || typeof event.payload?.text !== 'string') return;
      for (const match of event.payload.text.matchAll(/\[([a-z0-9]{2})([a-z0-9]{1,3})\]/g)) {
        totals.postCommitMarkers++;
        record({ kind: 'postcommit-marker', runId: event.runId, sourceSeq: event.sourceSeq,
          markerCode: match[1], index: Number.parseInt(match[2], 36),
          identitySha256: createHash('sha256').update(identity).digest('hex') });
      }
    },
    snapshot() { return { ...totals, queryBuildVerbs: { ...queryBuildVerbs } }; },
  };
  return api;
}
