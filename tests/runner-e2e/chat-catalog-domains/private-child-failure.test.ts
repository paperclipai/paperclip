import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PRIVATE_CHILD_FAILURE_FILENAME, readPrivateChildFailure, recordPrivateChildFailure } from "./private-child-failure.js";
import { WEBHOOK_PRIVATE_STEPS } from "./integrator-webhook-private-steps.js";
import { PRIVATE_BROWSER_STEPS } from "./external-private-browser-steps.js";
import { IDENTITY_PRIVATE_STEPS } from "./identity-private-browser-steps.js";

const secret = "a".repeat(48);
const directories: string[] = [];
async function directory() { const value = await mkdtemp(path.join(tmpdir(), "private-child-failure-")); directories.push(value); return value; }
afterEach(async () => { for (const value of directories.splice(0)) await rm(value, { recursive: true, force: true }); });

describe("private child failure record", () => {
  it("reports only the fixed step and error class, never the error text", async () => {
    const dir = await directory();
    const error = new Error(`locator.click: Timeout waiting for ${secret}`); error.name = "TimeoutError";
    await recordPrivateChildFailure(dir, "reveal-key", error);
    const raw = await readFile(path.join(dir, PRIVATE_CHILD_FAILURE_FILENAME), "utf8");
    expect(raw).not.toContain(secret);
    expect(await readPrivateChildFailure(dir, WEBHOOK_PRIVATE_STEPS)).toBe(" at step reveal-key (TimeoutError)");
  });

  it("never echoes a step outside the caller's closed list or an unknown error class", async () => {
    const dir = await directory();
    await writeFile(path.join(dir, PRIVATE_CHILD_FAILURE_FILENAME), JSON.stringify({ step: secret, errorClass: secret }));
    expect(await readPrivateChildFailure(dir, WEBHOOK_PRIVATE_STEPS)).toBe(" at step unknown (Error)");
    const custom = new Error("x"); custom.name = secret;
    const other = await directory(); await recordPrivateChildFailure(other, `step ${secret}`, custom);
    expect(await readFile(path.join(other, PRIVATE_CHILD_FAILURE_FILENAME), "utf8")).not.toContain(secret);
  });

  it("drops a record with extra fields and reports nothing when the child left none", async () => {
    const dir = await directory();
    expect(await readPrivateChildFailure(dir, WEBHOOK_PRIVATE_STEPS)).toBe("");
    await writeFile(path.join(dir, PRIVATE_CHILD_FAILURE_FILENAME), JSON.stringify({ step: "launch", errorClass: "Error", message: secret }));
    expect(await readPrivateChildFailure(dir, WEBHOOK_PRIVATE_STEPS)).toBe("");
  });

  it("keeps every declared step a credential-free constant", () => {
    for (const step of [...WEBHOOK_PRIVATE_STEPS, ...PRIVATE_BROWSER_STEPS, ...IDENTITY_PRIVATE_STEPS]) expect(step).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
  });
});
