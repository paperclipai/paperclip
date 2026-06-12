import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { googleSheetsRobotEmailFromEnv } from "../services/tool-access.js";

describe("Google Sheets app gallery availability", () => {
  it("reads the robot email from inline service-account JSON", () => {
    expect(googleSheetsRobotEmailFromEnv({
      GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: "robot@example.iam.gserviceaccount.com",
        private_key: "secret",
      }),
    })).toEqual({
      available: true,
      robotEmail: "robot@example.iam.gserviceaccount.com",
    });
  });

  it("reads the robot email from a service-account JSON file path", () => {
    const dir = mkdtempSync(join(tmpdir(), "paperclip-sheets-"));
    try {
      const path = join(dir, "service-account.json");
      writeFileSync(path, JSON.stringify({ client_email: "robot-from-file@example.com" }));
      expect(googleSheetsRobotEmailFromEnv({
        GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_PATH: path,
      })).toEqual({
        available: true,
        robotEmail: "robot-from-file@example.com",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when no robot email is configured", () => {
    expect(googleSheetsRobotEmailFromEnv({})).toMatchObject({
      available: false,
      reason: "Google Sheets is not available on this instance yet.",
    });
  });
});
