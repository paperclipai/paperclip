import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startResourceCapture, finishResourceCapture } from './resource-capture.mjs';
const root = process.env.PAPERCLIP_INGESTION_HARNESS_ROOT;
assert.ok(root && path.isAbsolute(root));
const { test } = createRequire(path.join(root, 'package.json'))('@playwright/test');
type Hook = { setTimeout(value: number): void; attach(name: string, value: { body: string; contentType: string }): Promise<void> };
test.beforeAll('start external resource observers before owning emissions', async ({}, info: Hook) => {
  info.setTimeout(20_000); await startResourceCapture();
});
test.afterAll('finish external and Node counters before ordinary app teardown', async ({}, info: Hook) => {
  info.setTimeout(20_000);
  const receipt = await finishResourceCapture();
  await info.attach('combined-resource-independent-flush', { body: JSON.stringify(receipt), contentType: 'application/json' });
});
await import(pathToFileURL(path.join(root, 'tests/e2e/native-event-ingestion.journey.ts')).href);
