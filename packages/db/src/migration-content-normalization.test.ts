import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { migrationContentHashes, normalizeMigrationContent } from "./client.js";

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

function readPublishedMigration(fileName: string): string {
  // Compare against the LF form regardless of how this checkout stored it.
  return readFileSync(new URL(`./migrations/${fileName}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

describe("normalizeMigrationContent", () => {
  it("leaves LF content unchanged so published journal hashes stay valid", () => {
    const published = readPublishedMigration("0001_fast_northstar.sql");
    expect(normalizeMigrationContent(published)).toBe(published);
    expect(sha256(normalizeMigrationContent(published))).toBe(sha256(published));
  });

  it("hashes a CRLF checkout of a migration the same as the published LF file", () => {
    const published = readPublishedMigration("0001_fast_northstar.sql");
    const crlfCheckout = published.replace(/\n/g, "\r\n");
    expect(sha256(crlfCheckout)).not.toBe(sha256(published));
    expect(sha256(normalizeMigrationContent(crlfCheckout))).toBe(sha256(published));
  });

  it("recognises both the LF hash and the legacy CRLF journal hash", () => {
    const published = readPublishedMigration("0001_fast_northstar.sql");
    const legacyCrlfHash = sha256(published.replace(/\n/g, "\r\n"));

    const hashes = migrationContentHashes(published);

    // New journal entries record the LF hash, so it comes first.
    expect(hashes[0]).toBe(sha256(published));
    expect(hashes).toContain(legacyCrlfHash);
    // Reading a CRLF checkout yields the same set, so either journal form matches.
    expect(migrationContentHashes(published.replace(/\n/g, "\r\n"))).toEqual(hashes);
  });

  it("returns a single hash for a migration without line breaks", () => {
    expect(migrationContentHashes('ALTER TABLE "a" ADD COLUMN "b" text;')).toHaveLength(1);
  });

  it("keeps statement breakpoints intact after normalisation", () => {
    const crlf = 'CREATE TABLE "a" ("id" int);\r\n--> statement-breakpoint\r\nCREATE TABLE "b" ("id" int);\r\n';
    expect(normalizeMigrationContent(crlf)).toBe(
      'CREATE TABLE "a" ("id" int);\n--> statement-breakpoint\nCREATE TABLE "b" ("id" int);\n',
    );
  });
});
