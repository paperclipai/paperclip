import assert from 'node:assert/strict';
import { installMaintenanceIdleWorkCapture } from './idle-work-capture.js';

// Isolated Node/TS-loader identity probe. Never imports app/index or opens a DB.
const original = await import('../../../services/task-admission.js');
const before = process.argv[2] === 'unhandled' ? undefined : original.beginIdleTrackedWork();
const capture = await installMaintenanceIdleWorkCapture();
try {
  const observed = await import('../../../services/task-admission.js');
  assert.equal(observed.idleWorkSnapshot, original.idleWorkSnapshot);
  if (process.argv[2] === 'unhandled') {
    const reason = new Error('original unhandled tracked rejection');
    let listener!: (reason: unknown, promise: Promise<unknown>) => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const event = new Promise<{ reason: unknown; promise: Promise<unknown> }>((resolve, reject) => {
      listener = (reason, promise) => resolve({ reason, promise });
      process.once('unhandledRejection', listener);
      timer = setTimeout(() => reject(new Error('Original tracked rejection did not reach unhandledRejection')), 1500);
    });
    try {
      // Deliberately never await or attach a handler to this original promise.
      const tracked = observed.trackIdleWork(Promise.reject(reason));
      const unhandled = await event;
      assert.equal(unhandled.promise, tracked);
      assert.equal(unhandled.reason, reason);
      assert.equal(original.idleWorkSnapshot().active, 0);
      assert.equal(capture.snapshot().observedActive, 0);
      console.log(JSON.stringify({ unhandledOriginalPromise: true, unhandledOriginalReason: true, finalActive: 0 }));
    } finally {
      if (timer) clearTimeout(timer);
      process.removeListener('unhandledRejection', listener);
    }
  } else {
    assert.equal(observed.idleWorkSnapshot().active, 1); // Existing state was not reset.
    assert.equal(capture.snapshot().observedActive, 0); // The pre-install path is explicitly missing.
    before!();
    const finish = observed.beginIdleTrackedWork();
    assert.equal(original.idleWorkSnapshot().active, 1);
    finish(); finish();
    assert.equal(original.idleWorkSnapshot().active, 0);
    assert.equal(await observed.trackIdleWork(Promise.resolve('original-result')), 'original-result');
    assert.equal(original.idleWorkSnapshot().active, 0);
    const result = capture.summary();
    assert(result.snapshot.missingPaths > 0);
    console.log(JSON.stringify({ identity: true, originalStatePreserved: true, finalActive: original.idleWorkSnapshot().active, missingPathsExplicit: result.snapshot.missingPaths }));
  }
} finally {
  before?.();
  capture.dispose();
}
