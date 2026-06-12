import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGoogleSheetsMcpConfig, readConfigFromEnv } from "./config.js";

const serviceAccount = {
  client_email: "service@example.test",
  private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
  project_id: "project-1",
};

describe("Google Sheets MCP config", () => {
  it("reads inline service-account JSON and de-duplicates allowed spreadsheet IDs", () => {
    const config = createGoogleSheetsMcpConfig({
      serviceAccountJson: JSON.stringify(serviceAccount),
      allowedSpreadsheetIds: "sheet-1,sheet-2\nsheet-1",
    });

    expect(config.serviceAccount.client_email).toBe("service@example.test");
    expect(config.allowedSpreadsheetIds).toEqual(["sheet-1", "sheet-2"]);
    expect(config.secretRedactions).toContain(serviceAccount.private_key);
  });

  it("reads service-account JSON from a path", () => {
    const dir = mkdtempSync(join(tmpdir(), "paperclip-sheets-mcp-"));
    try {
      const file = join(dir, "service-account.json");
      writeFileSync(file, JSON.stringify(serviceAccount));

      const config = readConfigFromEnv(
        {
          GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_PATH: file,
          GOOGLE_SHEETS_ALLOWED_SPREADSHEET_IDS: "sheet-1",
        } as NodeJS.ProcessEnv,
        [],
      );

      expect(config.serviceAccount.project_id).toBe("project-1");
      expect(config.allowedSpreadsheetIds).toEqual(["sheet-1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires an allowlist", () => {
    expect(() =>
      createGoogleSheetsMcpConfig({
        serviceAccountJson: JSON.stringify(serviceAccount),
        allowedSpreadsheetIds: "",
      })
    ).toThrow("At least one allowed spreadsheet ID is required.");
  });
});
