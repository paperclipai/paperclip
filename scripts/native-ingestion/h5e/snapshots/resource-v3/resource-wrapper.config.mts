import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = process.env.PAPERCLIP_INGESTION_HARNESS_ROOT;
assert.ok(root && path.isAbsolute(root));
const { default: frozen } = await import(pathToFileURL(path.join(root, 'tests/e2e/playwright-native-ingestion.config.ts')).href);
export default { ...frozen, testDir: path.dirname(fileURLToPath(import.meta.url)), testMatch: 'resource-wrapper.spec.mts' };
