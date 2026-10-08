const { branchIndex } = require('./storybook-destination.cjs');
const { createHash } = require('node:crypto');

async function verifyAvatarImages({ buildUrl, fetch = globalThis.fetch }) {
  const response = await fetch(new URL('agent-avatar-images/manifest.json', buildUrl), { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Avatar manifest returned HTTP ${response.status}.`);
  const manifest = await response.json();
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.images) || !manifest.images.length || manifest.images.length > 10000) {
    throw new Error('Invalid avatar image manifest.');
  }
  const paths = new Set();
  for (const image of manifest.images) {
    if (!/^agent-avatar-images\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+\.png$/.test(image.path)
        || !/^[a-f0-9]{64}$/.test(image.sha256) || !Number.isInteger(image.pixels)
        || image.pixels < 16 || image.pixels > 1024 || paths.has(image.path)) {
      throw new Error('Invalid avatar image entry.');
    }
    paths.add(image.path);
  }
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < manifest.images.length) {
      const image = manifest.images[next++];
      const result = await fetch(new URL(image.path, buildUrl), { signal: AbortSignal.timeout(15000) });
      if (!result.ok || !result.headers.get('content-type')?.startsWith('image/png')) {
        throw new Error(`Avatar ${image.path} returned HTTP ${result.status} or a non-PNG content type.`);
      }
      const png = Buffer.from(await result.arrayBuffer());
      if (png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
          || png.readUInt32BE(16) !== image.pixels || png.readUInt32BE(20) !== image.pixels
          || createHash('sha256').update(png).digest('hex') !== image.sha256) {
        throw new Error(`Avatar ${image.path} has incorrect PNG bytes or dimensions.`);
      }
    }
  }));
  console.log(`Verified ${manifest.images.length} public avatar PNGs.`);
}

async function verifyStorybook({ branchUrl, buildUrl, sha, fetch = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = 6 }) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const [metadata, index] = await Promise.all([
        fetch(new URL('deployment.json', buildUrl), { signal: AbortSignal.timeout(15000) }),
        fetch(branchUrl, { signal: AbortSignal.timeout(15000) }),
      ]);
      if (!metadata.ok || !index.ok) throw new Error(`Public deployment returned HTTP ${metadata.status}/${index.status}.`);
      const build = await metadata.json();
      if (build.sha !== sha) throw new Error('Public build has the wrong source commit.');
      if ((await index.text()) !== branchIndex(buildUrl)) throw new Error('Public branch URL does not point to this build.');
      if (build.avatarManifest) await verifyAvatarImages({ buildUrl, fetch });
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      await sleep(10000);
    }
  }
}

module.exports = { verifyStorybook, verifyAvatarImages };
if (require.main === module) {
  verifyStorybook({ branchUrl: process.env.BRANCH_URL, buildUrl: process.env.BUILD_URL,
    sha: process.env.SOURCE_SHA }).catch((error) => { console.error(error); process.exitCode = 1; });
}
