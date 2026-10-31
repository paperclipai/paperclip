import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PATCHED_POSTGRES_DRIVER, verifyPostgresDriverPayload } from "../postgres-driver-integrity.js";

const PATCHED_POSTGRES_SOURCE = path.resolve(
  path.dirname(createRequire(path.resolve(__dirname, "../../../packages/db/package.json")).resolve("postgres")),
  "../..",
);

describe("postgres driver payload verifier", () => {
  let payload: string;

  const rootDriver = () => path.join(payload, "node_modules", "postgres");
  const copyDriver = (target: string) => fs.cpSync(PATCHED_POSTGRES_SOURCE, target, { recursive: true, dereference: true });
  const writePackage = (directory: string, name: string) => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, version: "0.3.1" }));
    return directory;
  };
  const writeDrizzle = (directory: string) => {
    writePackage(directory, "drizzle-orm");
    fs.mkdirSync(path.join(directory, "postgres-js"), { recursive: true });
    fs.writeFileSync(path.join(directory, "postgres-js", "driver.js"), "import pgClient from \"postgres\";\n");
  };

  beforeEach(() => {
    payload = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-postgres-payload-"));
    writePackage(path.join(payload, "node_modules", "paperclipai"), "paperclipai");
    writePackage(path.join(payload, "node_modules", "@paperclipai", "db"), "@paperclipai/db");
    writeDrizzle(path.join(payload, "node_modules", "drizzle-orm"));
    copyDriver(rootDriver());
  });

  afterEach(() => fs.rmSync(payload, { recursive: true, force: true }));

  it("accepts a payload whose callers and drizzle driver resolve the one patched root driver", async () => {
    const resolutions = await verifyPostgresDriverPayload(payload);
    const expected = fs.realpathSync(rootDriver());
    expect(resolutions.map((entry) => entry.caller)).toEqual(["paperclipai", "@paperclipai/db", path.join("node_modules", "drizzle-orm", "postgres-js", "driver.js")]);
    for (const entry of resolutions) {
      expect(entry.packageRoot).toBe(expected);
      expect(entry.import).toBe(path.join(expected, "src", "index.js"));
      expect(entry.require).toBe(path.join(expected, "cjs", "src", "index.js"));
    }
  });

  it("checks every installed drizzle-orm wherever npm placed it", async () => {
    writeDrizzle(path.join(payload, "node_modules", "paperclipai", "node_modules", "drizzle-orm"));
    const resolutions = await verifyPostgresDriverPayload(payload);
    expect(resolutions.map((entry) => entry.caller)).toContain(path.join("node_modules", "paperclipai", "node_modules", "drizzle-orm", "postgres-js", "driver.js"));
    expect(new Set(resolutions.map((entry) => entry.packageRoot)).size).toBe(1);
  });

  it.each(Object.keys(PATCHED_POSTGRES_DRIVER.files))("rejects a reverted or changed %s", async (file) => {
    fs.appendFileSync(path.join(rootDriver(), file), "\n");
    await expect(verifyPostgresDriverPayload(payload)).rejects.toThrow(file);
  });

  it("rejects a missing driver file", async () => {
    fs.rmSync(path.join(rootDriver(), "cjs", "src", "index.js"));
    await expect(verifyPostgresDriverPayload(payload)).rejects.toThrow(/cjs\/src\/index\.js is missing/);
  });

  it("rejects a changed driver version", async () => {
    const manifestPath = path.join(rootDriver(), "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: "3.4.10" }));
    await expect(verifyPostgresDriverPayload(payload)).rejects.toThrow(/postgres@3\.4\.10/);
  });

  it("rejects any second copy, even a patched one, that a caller could load instead", async () => {
    copyDriver(path.join(payload, "node_modules", "@paperclipai", "db", "node_modules", "postgres"));
    await expect(verifyPostgresDriverPayload(payload)).rejects.toThrow(/exactly one postgres driver/);
  });

  it("rejects a payload whose only driver is nested instead of at the root", async () => {
    const nested = path.join(payload, "node_modules", "@paperclipai", "db", "node_modules", "postgres");
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.renameSync(rootDriver(), nested);
    await expect(verifyPostgresDriverPayload(payload)).rejects.toThrow(/exactly one postgres driver/);
  });

  describe("with packages linked from outside the payload", () => {
    let outside: string;
    beforeEach(() => {
      outside = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-postgres-outside-"));
      writeDrizzle(path.join(outside, "node_modules", "drizzle-orm"));
      copyDriver(path.join(outside, "node_modules", "postgres"));
      fs.writeFileSync(path.join(outside, "node_modules", "postgres", "src", "index.js"), "export default null;\n");
    });
    afterEach(() => fs.rmSync(outside, { recursive: true, force: true }));
    const dbModules = () => path.join(payload, "node_modules", "@paperclipai", "db", "node_modules");

    it("rejects a linked driver that a caller would load", async () => {
      fs.mkdirSync(dbModules(), { recursive: true });
      fs.symlinkSync(path.join(outside, "node_modules", "postgres"), path.join(dbModules(), "postgres"));
      await expect(verifyPostgresDriverPayload(payload)).rejects.toThrow(/must not contain linked packages.*@paperclipai\/db\/node_modules\/postgres/);
    });

    it("rejects a linked drizzle-orm whose own driver import resolves outside the payload", async () => {
      fs.mkdirSync(dbModules(), { recursive: true });
      fs.symlinkSync(path.join(outside, "node_modules", "drizzle-orm"), path.join(dbModules(), "drizzle-orm"));
      await expect(verifyPostgresDriverPayload(payload)).rejects.toThrow(/must not contain linked packages.*@paperclipai\/db\/node_modules\/drizzle-orm/);
    });

    it("rejects a linked nested node_modules directory", async () => {
      fs.symlinkSync(path.join(outside, "node_modules"), dbModules());
      await expect(verifyPostgresDriverPayload(payload)).rejects.toThrow(/must not contain linked packages.*@paperclipai\/db\/node_modules/);
    });

    it("rejects a linked scoped package", async () => {
      fs.renameSync(path.join(payload, "node_modules", "@paperclipai", "db"), path.join(outside, "db"));
      fs.symlinkSync(path.join(outside, "db"), path.join(payload, "node_modules", "@paperclipai", "db"));
      await expect(verifyPostgresDriverPayload(payload)).rejects.toThrow(/must not contain linked packages.*@paperclipai\/db/);
    });
  });

  it("rejects a payload without any postgres driver", async () => {
    fs.rmSync(rootDriver(), { recursive: true });
    await expect(verifyPostgresDriverPayload(payload)).rejects.toThrow(/contains no postgres driver/);
  });

  it("rejects a payload without a drizzle-orm postgres-js driver", async () => {
    fs.rmSync(path.join(payload, "node_modules", "drizzle-orm"), { recursive: true });
    await expect(verifyPostgresDriverPayload(payload)).rejects.toThrow(/no drizzle-orm postgres-js driver/);
  });
});
