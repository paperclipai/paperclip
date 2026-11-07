#!/usr/bin/env node
/** Run after the final server build and Linux daemon/provider-pack assembly. */
import { createHash } from 'node:crypto';
import { writeFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [directory, sourceRevision, ...extra] = process.argv.slice(2);
if (!directory || !/^[a-f0-9]{40}$/.test(sourceRevision ?? '') || extra.length) throw new Error('Usage: node scripts/create-runner-remote-companion.mjs DIRECTORY SOURCE_SHA');
const root = await realpath(directory);
const { createRemotePiCompanionManifest } = await import(pathToFileURL(resolve('server/dist/services/native-runtime/remote-pi-companion.js')).href);
const manifest = await createRemotePiCompanionManifest(root, sourceRevision);
const bytes = JSON.stringify(manifest, null, 2) + '\n';
await writeFile(resolve(root, 'companion.json'), bytes, { flag: 'wx', mode: 0o644 });
console.log(JSON.stringify({ directory: root, sourceRevision, target: manifest.target, manifestSha256: createHash('sha256').update(bytes).digest('hex'), providerPackDigest: manifest.providerPackDigest, daemonSha256: manifest.daemonSha256 }));
