import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { LegacyJsonReader, type LegacyJsonCursor } from "./legacy-json-reader.js";

it("streams more than 192 MiB losslessly and resumes from a durable page cursor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "legacy-import-"));
  const path = join(directory, "legacy.json");
  const fd = await open(path, "wx", 0o600);
  const payload = "A".repeat(128 * 1024) + ' escaped: \\" ] } λ';
  await fd.write('{"schema":"legacy-test","commands":[],"committedEvents":[');
  for (let index = 0; index < 1600; index++) await fd.write(`${index ? "," : ""}${JSON.stringify({ index, payload })}`);
  await fd.write('],"commandDeliveryCounts":{"first":2},"identity":{"session":"same"}}');
  await fd.close();
  let reader = new LegacyJsonReader(path);
  let cursor: LegacyJsonCursor | null = null;
  let source: string | null = null;
  let seen = 0, pages = 0;
  const fields: Record<string, unknown> = {};
  try {
    for (;;) {
      const page = await reader.page(source, cursor);
      expect(page.entries.length).toBeLessThanOrEqual(128);
      for (const entry of page.entries) {
        if (entry.field === "committedEvents") { expect(entry.key).toBe(String(seen)); expect(entry.value).toEqual({ index: seen++, payload }); }
        else fields[entry.field] = entry.value;
      }
      const before = cursor?.offset ?? 0;
      cursor = page.cursor; source = page.source; pages++;
      expect(cursor.offset).toBeGreaterThan(before);
      if (page.done) break;
      if (pages === 5) { await reader.close(); reader = new LegacyJsonReader(path); }
    }
    expect(seen).toBe(1600);
    expect(cursor!.offset).toBeGreaterThan(192 * 1024 * 1024);
    expect(fields).toEqual({ schema: "legacy-test", commandDeliveryCounts: 2, identity: { session: "same" } });
  } finally { await reader.close(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);

it("rejects a changed source on resume and malformed boundaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "legacy-import-invalid-"));
  const path = join(directory, "legacy.json");
  try {
    for (const content of ['{"commands":[1,]}', '{"a":1,"a":2}', '{"commands":[{"a":]}', '{"a":"unterminated}', '{"a":1} trailing', '{"a":1,}']) {
      await writeFile(path, content, { mode: 0o600 });
      const reader = new LegacyJsonReader(path);
      try { await expect(reader.page(null, null)).rejects.toThrow(); } finally { await reader.close(); }
    }
    await writeFile(path, JSON.stringify({ committedEvents: Array.from({ length: 500 }, (_, i) => ({ i })) }), { mode: 0o600 });
    const reader = new LegacyJsonReader(path);
    try {
      const page = await reader.page(null, null);
      await writeFile(path, '{"changed":true}', { mode: 0o600 });
      await expect(reader.page(page.source, page.cursor)).rejects.toThrow("source changed");
    } finally { await reader.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
