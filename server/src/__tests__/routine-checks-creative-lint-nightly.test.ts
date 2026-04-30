import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { creativeLintNightly } from "../services/routine-checks/checks/creative-lint-nightly.js";

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };
const fsStub = {} as unknown as typeof import("node:fs/promises");

describe("creative-lint-nightly", () => {
  let tmp: string;
  let stubLint: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pc-lint-"));
    process.env.PAPERCLIP_CREATIVE_ROOT = tmp;
    // Stub lint.mjs that emits JSON based on directory name pattern
    stubLint = path.join(tmp, "stub-lint.mjs");
    await fs.writeFile(stubLint, `#!/usr/bin/env node
import { basename } from "node:path";
const args = process.argv.slice(2);
const projectArg = args.find((a) => !a.startsWith("--"));
const dir = basename(projectArg);
// Conventional names: "fail-N" => N errors, "warn-N" => N warnings, anything else clean
let errors = 0, warnings = 0;
const fm = dir.match(/^fail-(\\d+)$/); if (fm) errors = parseInt(fm[1], 10);
const wm = dir.match(/^warn-(\\d+)$/); if (wm) warnings = parseInt(wm[1], 10);
process.stdout.write(JSON.stringify({ errors, warnings, violations: [] }));
process.exit(errors > 0 ? 1 : 0);
`);
    process.env.PAPERCLIP_CREATIVE_LINT = stubLint;
  });

  afterEach(async () => {
    delete process.env.PAPERCLIP_CREATIVE_ROOT;
    delete process.env.PAPERCLIP_CREATIVE_LINT;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns ok with 0 errors when no projects exist", async () => {
    const r = await creativeLintNightly.run({ db: {} as any, fs: fsStub, logger: noopLogger, now: () => new Date() });
    expect(r.status).toBe("ok");
    expect(r.findings).toBe(0);
    expect((r.payload as any).projects).toEqual([]);
  });

  it("returns ok when projects are clean", async () => {
    await fs.mkdir(path.join(tmp, "clean-1"));
    await fs.mkdir(path.join(tmp, "clean-2"));
    const r = await creativeLintNightly.run({ db: {} as any, fs: fsStub, logger: noopLogger, now: () => new Date() });
    expect(r.status).toBe("ok");
    expect(r.findings).toBe(0);
    expect((r.payload as any).projects).toHaveLength(2);
  });

  it("aggregates errors across projects", async () => {
    await fs.mkdir(path.join(tmp, "fail-2"));
    await fs.mkdir(path.join(tmp, "fail-3"));
    await fs.mkdir(path.join(tmp, "clean"));
    const r = await creativeLintNightly.run({ db: {} as any, fs: fsStub, logger: noopLogger, now: () => new Date() });
    expect(r.status).toBe("warn");
    expect(r.findings).toBe(5);
    expect((r.payload as any).totals.errors).toBe(5);
  });

  it("counts warnings separately from errors (status stays ok if no errors)", async () => {
    await fs.mkdir(path.join(tmp, "warn-3"));
    const r = await creativeLintNightly.run({ db: {} as any, fs: fsStub, logger: noopLogger, now: () => new Date() });
    expect(r.status).toBe("ok");
    expect(r.findings).toBe(0);
    expect((r.payload as any).totals.warnings).toBe(3);
  });

  it("returns error status when creative root does not exist", async () => {
    process.env.PAPERCLIP_CREATIVE_ROOT = "/nonexistent/path/should/not/exist";
    const r = await creativeLintNightly.run({ db: {} as any, fs: fsStub, logger: noopLogger, now: () => new Date() });
    expect(r.status).toBe("error");
  });
});
