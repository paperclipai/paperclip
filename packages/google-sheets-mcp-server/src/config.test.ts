import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGoogleSheetsMcpConfig, readConfigFromEnv, readHttpConfigFromEnv } from "./config.js";

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

  it("reads HTTP host, port, and token while reusing MCP config env", () => {
    const config = readHttpConfigFromEnv(
      {
        GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount),
        GOOGLE_SHEETS_ALLOWED_SPREADSHEET_IDS: "sheet-1",
        GOOGLE_SHEETS_MCP_PORT: "9911",
        GOOGLE_SHEETS_MCP_HOST: "0.0.0.0",
        GOOGLE_SHEETS_MCP_TOKEN: " local-token ",
      } as NodeJS.ProcessEnv,
      [],
    );

    expect(config.port).toBe(9911);
    expect(config.host).toBe("0.0.0.0");
    expect(config.token).toBe("local-token");
    expect(config.mcpConfig.allowedSpreadsheetIds).toEqual(["sheet-1"]);
  });

  it("lets PORT override GOOGLE_SHEETS_MCP_PORT for platform hosts", () => {
    const config = readHttpConfigFromEnv(
      {
        GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount),
        GOOGLE_SHEETS_ALLOWED_SPREADSHEET_IDS: "sheet-1",
        PORT: "8080",
        GOOGLE_SHEETS_MCP_PORT: "9911",
      } as NodeJS.ProcessEnv,
      [],
    );

    expect(config.port).toBe(8080);
    expect(config.host).toBe("127.0.0.1");
    expect(config.token).toBeNull();
  });

  it("requires a token for non-loopback HTTP binds", () => {
    expect(() =>
      readHttpConfigFromEnv(
        {
          GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount),
          GOOGLE_SHEETS_ALLOWED_SPREADSHEET_IDS: "sheet-1",
          GOOGLE_SHEETS_MCP_HOST: "0.0.0.0",
        } as NodeJS.ProcessEnv,
        [],
      )
    ).toThrow("GOOGLE_SHEETS_MCP_TOKEN is required when GOOGLE_SHEETS_MCP_HOST is not loopback.");
  });

  it("allows loopback HTTP binds without a token", () => {
    const config = readHttpConfigFromEnv(
      {
        GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount),
        GOOGLE_SHEETS_ALLOWED_SPREADSHEET_IDS: "sheet-1",
        GOOGLE_SHEETS_MCP_HOST: "::1",
      } as NodeJS.ProcessEnv,
      [],
    );

    expect(config.host).toBe("::1");
    expect(config.token).toBeNull();
  });
});
