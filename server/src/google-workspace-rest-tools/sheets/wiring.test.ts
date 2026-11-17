import { googleWorkspaceToolName, googleWorkspaceToolTarget } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import { googleRequestUrl, type GoogleRequest } from "../google-http.js";
import { googleWorkspaceRestProbeFor, probeGoogleWorkspaceRestService } from "../probe.js";
import { callGoogleWorkspaceRestTool, listGoogleWorkspaceRestTools } from "../tools.js";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { FORMATTED_VALUES, SPREADSHEET_ID } from "./fixtures/sheets-rest.js";

const scope = (name: string) => `https://www.googleapis.com/auth/${name}`;
const GET: GoogleRequest = { method: "GET", host: "sheets.googleapis.com", path: `/v4/spreadsheets/${SPREADSHEET_ID}` };

describe("sheets.googleapis.com host", () => {
  it.each([
    `/v4/spreadsheets/${SPREADSHEET_ID}`,
    `/v4/spreadsheets/${SPREADSHEET_ID}/values/Sheet1!A1%3AB2`,
    `/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`,
  ])("allows %s", (path) => {
    expect(googleRequestUrl({ ...GET, path })).toBe(`https://sheets.googleapis.com${path}`);
  });

  it.each([
    "/v4/spreadsheets",
    "/v3/spreadsheets/x",
    "/v4/spreadsheetsx/y",
    "/v4/spreadsheets/../../drive/v3/files",
    "/v4/spreadsheets/%2e%2e/%2e%2e/v4/other",
    "/upload/v4/spreadsheets/x",
    "/v4/other/x",
  ])("refuses %s", (path) => {
    expect(() => googleRequestUrl({ ...GET, path })).toThrow(/not allowed/);
  });

  it("does not let other hosts serve Sheets paths", () => {
    expect(() => googleRequestUrl({ ...GET, host: "www.googleapis.com" })).toThrow(/not allowed/);
  });
});

describe("Sheets service", () => {
  it("lists the six allowlisted tools, each runnable with exactly its allowlisted scope", () => {
    const tools = listGoogleWorkspaceRestTools("sheets");
    expect(tools.map((tool) => tool.name)).toEqual(["get_values", "get_spreadsheet", "update_spreadsheet", "update_values", "update_formulas", "insert_dimension"]);
    const scopes = Object.fromEntries(tools.map((tool) => [tool.name, googleWorkspaceToolTarget(googleWorkspaceToolName("sheets", tool.name))?.requiredScopes]));
    expect(scopes).toMatchObject({
      get_values: [[scope("spreadsheets.readonly"), scope("spreadsheets")]],
      get_spreadsheet: [[scope("spreadsheets.readonly"), scope("spreadsheets")]],
      update_spreadsheet: [[scope("spreadsheets")]],
      update_values: [[scope("spreadsheets")]],
      update_formulas: [[scope("spreadsheets")]],
      insert_dimension: [[scope("spreadsheets")]],
    });
  });

  it("calls a Sheets tool through the service entry point", async () => {
    const { fetch, calls } = fakeGoogle(() => json(FORMATTED_VALUES));
    const result = await callGoogleWorkspaceRestTool({ service: "sheets", name: "get_values", arguments: { spreadsheetId: SPREADSHEET_ID, range: "'Q1 Plan'!A1:D4" }, accessToken: "token-1", fetch });
    expect(result.structuredContent).toMatchObject({ range: FORMATTED_VALUES.range });
    expect(calls[0]!.url.host).toBe("sheets.googleapis.com");
    expect(calls[0]!.headers.authorization).toBe("Bearer token-1");
  });

  it("is listed without a network probe, since every Sheets read needs a spreadsheet ID", async () => {
    expect(googleWorkspaceRestProbeFor("sheets", [scope("spreadsheets.readonly"), scope("spreadsheets")])).toBeNull();
    const fetch = vi.fn();
    await expect(probeGoogleWorkspaceRestService({ service: "sheets", accessToken: "t", grantedScopes: [scope("spreadsheets")], fetch }))
      .resolves.toEqual({ ok: true, probed: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});
