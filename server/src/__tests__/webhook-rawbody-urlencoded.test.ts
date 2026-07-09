import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

/**
 * Guards the body-parser wiring in `server/src/app.ts`. Slack signs the *raw*
 * request body and sends slash commands / interactivity as
 * application/x-www-form-urlencoded. Before the urlencoded parser was added,
 * only express.json() captured `req.rawBody`, so form-encoded webhooks left it
 * undefined and HMAC signature verification ran against an empty buffer and
 * always failed (mvanhorn/paperclip-plugin-slack#19).
 *
 * This mirrors the exact middleware order app.ts installs: json first, then
 * urlencoded, both sharing one captureRawBody verify callback.
 */
function buildApp() {
  const app = express();
  const captureRawBody = (req: express.Request, _res: express.Response, buf: Buffer) => {
    (req as unknown as { rawBody: Buffer }).rawBody = buf;
  };
  app.use(express.json({ verify: captureRawBody }));
  app.use(express.urlencoded({ extended: false, verify: captureRawBody }));
  app.post("/hook", (req, res) => {
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    res.json({
      hasRawBody: rawBody !== undefined,
      rawBody: rawBody ? rawBody.toString("utf8") : null,
      parsedKeys: Object.keys(req.body ?? {}),
    });
  });
  return app;
}

const SLACK_SECRET = "test-signing-secret";

function slackSignature(timestamp: string, rawBody: string) {
  const base = `v0:${timestamp}:${rawBody}`;
  return `v0=${createHmac("sha256", SLACK_SECRET).update(base).digest("hex")}`;
}

describe("webhook raw body capture", () => {
  it("captures rawBody for application/x-www-form-urlencoded so Slack HMAC verifies", async () => {
    const formBody = "token=abc&command=%2Fclip&text=help&team_id=T123";
    const timestamp = "1700000000";
    const signature = slackSignature(timestamp, formBody);

    const res = await request(buildApp())
      .post("/hook")
      .set("Content-Type", "application/x-www-form-urlencoded")
      .set("X-Slack-Request-Timestamp", timestamp)
      .set("X-Slack-Signature", signature)
      .send(formBody);

    expect(res.status).toBe(200);
    expect(res.body.hasRawBody).toBe(true);
    expect(res.body.rawBody).toBe(formBody);
    // The captured rawBody reproduces Slack's signature exactly.
    expect(slackSignature(timestamp, res.body.rawBody)).toBe(signature);
    // The form is still parsed into req.body for handlers that want it.
    expect(res.body.parsedKeys).toEqual(["token", "command", "text", "team_id"]);
  });

  it("still captures rawBody for application/json (no regression)", async () => {
    const res = await request(buildApp())
      .post("/hook")
      .set("Content-Type", "application/json")
      .send({ hello: "world" });

    expect(res.status).toBe(200);
    expect(res.body.hasRawBody).toBe(true);
    expect(JSON.parse(res.body.rawBody)).toEqual({ hello: "world" });
  });
});
