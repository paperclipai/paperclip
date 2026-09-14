const { branchIndex } = require('./storybook-destination.cjs');

async function verifyStorybook({ branchUrl, buildUrl, sha, fetch = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = 6 }) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const [metadata, index] = await Promise.all([
        fetch(new URL('deployment.json', buildUrl), { signal: AbortSignal.timeout(15000) }),
        fetch(branchUrl, { signal: AbortSignal.timeout(15000) }),
      ]);
      if (!metadata.ok || !index.ok) throw new Error(`Public deployment returned HTTP ${metadata.status}/${index.status}.`);
      if ((await metadata.json()).sha !== sha) throw new Error('Public build has the wrong source commit.');
      if ((await index.text()) !== branchIndex(buildUrl)) throw new Error('Public branch URL does not point to this build.');
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      await sleep(10000);
    }
  }
}

module.exports = { verifyStorybook };
if (require.main === module) {
  verifyStorybook({ branchUrl: process.env.BRANCH_URL, buildUrl: process.env.BUILD_URL,
    sha: process.env.SOURCE_SHA }).catch((error) => { console.error(error); process.exitCode = 1; });
}
