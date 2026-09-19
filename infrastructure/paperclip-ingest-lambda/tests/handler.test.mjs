import assert from "node:assert/strict";
import test from "node:test";

import { handler } from "../src/handler.mjs";

test("handler returns success response for mock EventBridge payload", async () => {
  process.env.ENTITLEMENTS_TABLE_NAME = "kinetica-entitlements";
  process.env.DEPLOYMENT_STAGE = "dev";

  const result = await handler({
    source: "kinetica.notion",
    "detail-type": "notion.webhook.received",
    detail: {
      taskId: "KIN-375",
      operation: "upsert",
    },
  });

  assert.equal(result.statusCode, 200);

  const parsed = JSON.parse(result.body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.config.entitlementsTableName, "kinetica-entitlements");
  assert.equal(parsed.received.source, "kinetica.notion");
});
