import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { MappingStore } from "../src/mapping-store.js";
import type { MappingEntry } from "../src/types.js";

let dir: string;
let store: MappingStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dpo-test-"));
  const key = randomBytes(32);
  store = new MappingStore({ path: join(dir, "mappings.db"), key });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("MappingStore", () => {
  it("schreibt und liest Mappings für eine mappingId", () => {
    const mappings: MappingEntry[] = [
      { pseudonym: "[PERSON_A]", plaintext: "Max", type: "PERSON" },
      { pseudonym: "[EMAIL_A]", plaintext: "max@whitestag.de", type: "EMAIL" },
    ];
    store.write("map-1", "whitestag-internal", mappings, 86400);
    const read = store.read("map-1");
    expect(read).toHaveLength(2);
    expect(read).toEqual(expect.arrayContaining(mappings));
  });

  it("verschlüsselt plaintext on disk (kein Klartext lesbar)", () => {
    store.write(
      "map-2",
      "t",
      [{ pseudonym: "[X_A]", plaintext: "GEHEIMNIS_TOKEN", type: "PERSON" }],
      86400,
    );
    store.close();
    const raw = readFileSync(join(dir, "mappings.db"));
    expect(raw.toString("binary")).not.toContain("GEHEIMNIS_TOKEN");
  });

  it("liefert leeres Array für unbekannte mappingId", () => {
    expect(store.read("does-not-exist")).toEqual([]);
  });

  it("löscht abgelaufene Mappings via cleanup()", () => {
    store.write(
      "map-3",
      "t",
      [{ pseudonym: "[X_A]", plaintext: "v", type: "PERSON" }],
      0,
    );
    expect(store.read("map-3")).toHaveLength(1);
    store.cleanup();
    expect(store.read("map-3")).toEqual([]);
  });

  it("trennt Mappings nach tenantId", () => {
    store.write("map-4", "tenant-a", [
      { pseudonym: "[X_A]", plaintext: "A", type: "PERSON" },
    ], 86400);
    expect(store.readByTenant("tenant-a")).toHaveLength(1);
    expect(store.readByTenant("tenant-b")).toHaveLength(0);
  });
});
