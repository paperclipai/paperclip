/** Observe media rejection immediately and release any pending scenario wait. */
export function createMediaFailure(onFailure) {
  let error, reject;
  const failure = new Promise((_, fail) => { reject = fail; });
  failure.catch(() => {}); // A failure can occur between scenario waits.
  return {
    get error() { return error; },
    observe(pump) {
      return pump.catch(cause => {
        error ??= cause;
        reject(error);
        onFailure(error);
      });
    },
    waitFor(action) { return Promise.race([Promise.resolve().then(action), failure]); },
  };
}
