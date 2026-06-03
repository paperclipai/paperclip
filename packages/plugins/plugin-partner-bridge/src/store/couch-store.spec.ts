import { describe, expect, it } from "vitest";
import { CouchStore } from "./couch-store.js";
import { createCouchHttp } from "./couch-http.js";

const URL = process.env.COUCH_TEST_URL;
const d = URL ? describe : describe.skip;

d("CouchStore (live)", () => {
  it("cursor + mapping + approval round-trip", async () => {
    const http = createCouchHttp({ baseUrl: URL!, user: process.env.COUCH_TEST_USER, password: process.env.COUCH_TEST_PASSWORD });
    const store = new CouchStore(http, `pb_test_${Date.now()}`);
    await store.ensure();
    await store.setCursor("L", "iss", "2026-06-03T10:00:00Z");
    expect(await store.getCursor("L", "iss")).toBe("2026-06-03T10:00:00Z");
    await store.putMapping({ bridgeMsgId: "B", sourceItemId: "s", mirroredItemId: "m", flags: { mirrored: true, notified: true, emailed: false } });
    expect((await store.findMappingBySource("s"))?.mirroredItemId).toBe("m");
  });
});
