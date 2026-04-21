import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createDpo } from "paperclip-dpo";
import { buildServer } from "../src/server.js";

const RUN = process.env.DPO_INTEGRATION === "1";
const SUITE = RUN ? describe : describe.skip;

SUITE("integration (real Gemma via LM Studio)", () => {
  it("anonymises a real prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dpo-int-"));
    try {
      const dpo = createDpo({
        mappingDbPath: join(dir, "m.db"),
        mappingKey: randomBytes(32),
        auditDir: join(dir, "audit"),
        classifier: {
          url: process.env.LM_STUDIO_URL ?? "http://localhost:1234",
          model: process.env.LM_STUDIO_MODEL ?? "gemma-4-26b",
          timeoutMs: 30000,
        },
      });
      try {
        const app = await buildServer({
          sharedKey: "integration-key-32-bytes-padding-xxx",
          classifierUrl: "http://localhost:1234",
          dpo,
        });
        try {
          const res = await app.inject({
            method: "POST",
            url: "/anonymize",
            headers: {
              "x-dpo-key": "integration-key-32-bytes-padding-xxx",
              "content-type": "application/json",
            },
            payload: {
              text: "Max Mustermann von WHITESTAG GmbH (max@whitestag.de) grüßt aus Cottbus.",
              targetLlm: "gpt-4o-mini",
              agent: "integration-test",
            },
          });
          expect(res.statusCode).toBe(200);
          const body = res.json();
          expect(body.blocked).toBe(false);
          expect(body.anonymizedText).not.toContain("max@whitestag.de");
        } finally {
          await app.close();
        }
      } finally {
        dpo.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
