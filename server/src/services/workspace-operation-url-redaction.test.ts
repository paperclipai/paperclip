import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalFileWorkspaceOperationLogStore } from "./workspace-operation-log-store.js";
import {
  createWorkspaceOperationUrlStreamRedactor,
  redactTruncatedWorkspaceOperationOutput,
  redactWorkspaceOperationExcerpt,
  redactWorkspaceOperationUrlUserInfo,
} from "./workspace-operation-url-redaction.js";

describe("workspace operation URL redaction", () => {
  it("masks userinfo even when the scheme and credential arrive in separate chunks", () => {
    const redactor = createWorkspaceOperationUrlStreamRedactor();
    const output = [
      redactor.push("connected to post"),
      redactor.push("gresql://synthetic-user:sy"),
      redactor.push("nthetic-password@db.example.test:5432/app and done"),
      redactor.flush(),
    ].join("");
    expect(output).toContain("postgresql://[REDACTED]@db.example.test:5432/app");
    expect(output).not.toContain("synthetic-user");
    expect(output).not.toContain("synthetic-password");
    expect(redactWorkspaceOperationUrlUserInfo("postgres://reader:one@db.test/app"))
      .toBe("postgres://[REDACTED]@db.test/app");
    expect(redactWorkspaceOperationExcerpt("the tail synthetic-password@db.test/app"))
      .toBe("the tail [REDACTED]@db.test/app");
  });

  it("masks an unfinished URL when a stream ends before the @", () => {
    const redactor = createWorkspaceOperationUrlStreamRedactor();
    const output = redactor.push("connect post")
      + redactor.push("gresql://synthetic-user:synthetic-password")
      + redactor.flush();
    expect(output).toBe("connect postgresql://[REDACTED]");
  });

  it("accepts an apostrophe inside userinfo and hostless PostgreSQL excerpts", () => {
    const credential = "synthetic-reader:it's-a-password";
    const url = `postgresql://${credential}@db.example.test/app`;
    const redactor = createWorkspaceOperationUrlStreamRedactor();
    const output = redactor.push(`connect ${url}`) + redactor.flush();
    expect(output).toBe("connect postgresql://[REDACTED]@db.example.test/app");
    expect(redactWorkspaceOperationUrlUserInfo(url)).toBe("postgresql://[REDACTED]@db.example.test/app");
    for (const hostAndPath of ["/app", "?host=db.example.test/app"]) {
      expect(redactWorkspaceOperationExcerpt(`word tail'password@${hostAndPath}`))
        .toBe(`word [REDACTED]@${hostAndPath}`);
    }
  });

  it("hides the first uncertain token of a truncated process capture", () => {
    const captured = "[output truncated to last 262144 bytes; total 262200 bytes]\n"
      + "thetic'password@db.example.test/app complete";
    expect(redactTruncatedWorkspaceOperationOutput(captured))
      .toContain("\n[REDACTED]@db.example.test/app complete");
    expect(redactWorkspaceOperationExcerpt(captured))
      .toContain("\n[REDACTED]@db.example.test/app complete");
    expect(redactTruncatedWorkspaceOperationOutput(captured)).not.toContain("thetic'password");
  });

  describe("historical byte-range pages", () => {
    let logRoot: string;
    beforeAll(async () => {
      logRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-operation-url-redaction-"));
    });
    afterAll(async () => {
      await fs.rm(logRoot, { recursive: true, force: true });
    });

    it("masks every page across a credential and leaves the forensic file unchanged", async () => {
      const store = createLocalFileWorkspaceOperationLogStore(logRoot);
      const handle = await store.begin({ companyId: randomUUID(), operationId: randomUUID() });
      const credential = "synthetic-reader:synthetic-password";
      await store.append(handle, {
        stream: "stdout",
        chunk: `before postgres://${credential}@db.example.test/app after`,
        ts: new Date().toISOString(),
      });
      const filePath = path.join(logRoot, handle.logRef);
      const original = await fs.readFile(filePath);
      const userinfoStart = original.indexOf(credential);
      expect(userinfoStart).toBeGreaterThan(0);
      const expected = Buffer.from(original);
      expected.fill(0x2a, userinfoStart, userinfoStart + credential.length);

      let offset = 0;
      while (offset < original.length) {
        const page = await store.read(handle, { offset, limitBytes: 7 });
        const nextOffset = page.nextOffset ?? original.length;
        expect(page.content).toBe(expected.subarray(offset, nextOffset).toString("utf8"));
        offset = nextOffset;
      }
      expect(await fs.readFile(filePath)).toEqual(original);
    });

    it("masks a historical URL whose userinfo spans two NDJSON events", async () => {
      const store = createLocalFileWorkspaceOperationLogStore(logRoot);
      const handle = await store.begin({ companyId: randomUUID(), operationId: randomUUID() });
      const first = "synthetic-reader:synthetic-";
      const second = "password";
      const ts = new Date().toISOString();
      await store.append(handle, { stream: "stdout", chunk: `postgres://${first}`, ts });
      await store.append(handle, { stream: "stderr", chunk: "unrelated output", ts });
      await store.append(handle, { stream: "stdout", chunk: `${second}@db.example.test/app`, ts });
      const filePath = path.join(logRoot, handle.logRef);
      const original = await fs.readFile(filePath);
      const expected = Buffer.from(original);
      const firstAt = original.indexOf(first);
      const secondAt = original.indexOf(second);
      expect(firstAt).toBeGreaterThan(0);
      expect(secondAt).toBeGreaterThan(firstAt);
      expected.fill(0x2a, firstAt, firstAt + first.length);
      expected.fill(0x2a, secondAt, secondAt + second.length);

      let offset = 0;
      while (offset < original.length) {
        const page = await store.read(handle, { offset, limitBytes: 9 });
        const nextOffset = page.nextOffset ?? original.length;
        expect(page.content).toBe(expected.subarray(offset, nextOffset).toString("utf8"));
        offset = nextOffset;
      }
      expect(await fs.readFile(filePath)).toEqual(original);
    });

    it("hides a damaged event and the remaining log when it may complete split userinfo", async () => {
      const store = createLocalFileWorkspaceOperationLogStore(logRoot);
      const handle = await store.begin({ companyId: randomUUID(), operationId: randomUUID() });
      const first = "synthetic-reader:synthetic-";
      const second = "password";
      const ts = new Date().toISOString();
      await store.append(handle, { stream: "stdout", chunk: `postgres://${first}`, ts });
      await store.append(handle, { stream: "stdout", chunk: `${second}@db.example.test/app`, ts });
      await store.append(handle, { stream: "stdout", chunk: "later record", ts });
      const filePath = path.join(logRoot, handle.logRef);
      const intact = await fs.readFile(filePath, "utf8");
      const damaged = intact.replace('"chunk":"password@', '"shunk":"password@');
      expect(damaged).not.toBe(intact);
      await fs.writeFile(filePath, damaged);
      const original = await fs.readFile(filePath);
      const expected = Buffer.from(original);
      const firstAt = original.indexOf(first);
      const damagedAt = original.indexOf(0x0a) + 1;
      expected.fill(0x2a, firstAt, firstAt + first.length);
      expected.fill(0x2a, damagedAt);

      let offset = 0;
      while (offset < original.length) {
        const page = await store.read(handle, { offset, limitBytes: 7 });
        const nextOffset = page.nextOffset ?? original.length;
        expect(page.content).toBe(expected.subarray(offset, nextOffset).toString("utf8"));
        offset = nextOffset;
      }
      expect(await fs.readFile(filePath)).toEqual(original);
    });

    it("masks apostrophes and a capture truncated inside userinfo without changing byte offsets", async () => {
      const store = createLocalFileWorkspaceOperationLogStore(logRoot);
      const handle = await store.begin({ companyId: randomUUID(), operationId: randomUUID() });
      const apostropheCredential = "synthetic-reader:it's-a-password";
      const truncatedCredential = "thetic'password";
      await store.append(handle, {
        stream: "stdout",
        chunk: `postgresql://${apostropheCredential}@db.example.test/app`,
        ts: new Date().toISOString(),
      });
      await store.append(handle, {
        stream: "stdout",
        chunk: `[output truncated to last 262144 bytes; total 262200 bytes]\n${truncatedCredential}@db.example.test/app`,
        ts: new Date().toISOString(),
      });
      const filePath = path.join(logRoot, handle.logRef);
      const original = await fs.readFile(filePath);
      const expected = Buffer.from(original);
      for (const credential of [apostropheCredential, truncatedCredential]) {
        const offset = original.indexOf(credential);
        expect(offset).toBeGreaterThan(0);
        expected.fill(0x2a, offset, offset + credential.length);
      }
      let offset = 0;
      while (offset < original.length) {
        const page = await store.read(handle, { offset, limitBytes: 7 });
        const nextOffset = page.nextOffset ?? original.length;
        expect(page.content).toBe(expected.subarray(offset, nextOffset).toString("utf8"));
        offset = nextOffset;
      }
      expect(await fs.readFile(filePath)).toEqual(original);
    });
  });
});
