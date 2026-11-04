import test from 'node:test';
import assert from 'node:assert/strict';
import {createMediaFailure} from './media-failure.mjs';

for (const operation of ['captureFrame', 'waitForPlayout']) {
  test(`${operation} failure releases pending input and runs hangup and evidence cleanup`, async () => {
    let fail, hungUp = false, reportSaved = false, observed;
    const media = createMediaFailure(error => { observed = error; });
    const sourceFailure = new Error(`${operation} failed`);
    const source = {captureFrame: async () => {}, waitForPlayout: async () => {}};
    source[operation] = () => new Promise((_, reject) => { fail = reject; });
    const pump = media.observe((async () => { await source.captureFrame(); await source.waitForPlayout(); })());
    const input = media.waitFor(() => new Promise(() => {}));
    while (!fail) await Promise.resolve();
    fail(sourceFailure);
    let failure;
    try { await input; }
    catch (error) { failure = error; }
    finally { hungUp = true; reportSaved = true; }
    await pump;
    assert.equal(failure, sourceFailure);
    assert.equal(observed, sourceFailure);
    assert.equal(media.error, sourceFailure);
    assert.equal(hungUp && reportSaved, true);
    await assert.rejects(media.waitFor(() => new Promise(() => {})), sourceFailure);
  });
}
