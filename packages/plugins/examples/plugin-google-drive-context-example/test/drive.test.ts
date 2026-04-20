import { describe, expect, it, vi } from "vitest";
import {
  parseDriveTarget,
  parseGoogleCredentialSecret,
  resolveGoogleAccessToken,
} from "../src/drive.js";

describe("parseDriveTarget", () => {
  it("parses Drive folder URLs", () => {
    expect(parseDriveTarget("https://drive.google.com/drive/folders/folder_123?usp=sharing")).toEqual({
      id: "folder_123",
      kindHint: "folder",
    });
  });

  it("parses Google Docs URLs", () => {
    expect(parseDriveTarget("https://docs.google.com/document/d/doc_123/edit")).toEqual({
      id: "doc_123",
      kindHint: "file",
    });
  });

  it("parses Google Sheets URLs", () => {
    expect(parseDriveTarget("https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=0")).toEqual({
      id: "sheet_123",
      kindHint: "file",
    });
  });

  it("parses Google Slides URLs", () => {
    expect(parseDriveTarget("https://docs.google.com/presentation/d/slides_123/edit")).toEqual({
      id: "slides_123",
      kindHint: "file",
    });
  });

  it("parses generic Drive file URLs", () => {
    expect(parseDriveTarget("https://drive.google.com/file/d/file_123/view?usp=sharing")).toEqual({
      id: "file_123",
      kindHint: "file",
    });
  });

  it("treats raw values as Drive IDs", () => {
    expect(parseDriveTarget("raw_id_123")).toEqual({
      id: "raw_id_123",
      kindHint: null,
    });
  });
});

describe("Google credential parsing", () => {
  it("accepts raw OAuth access tokens", () => {
    expect(parseGoogleCredentialSecret("ya29.access-token")).toEqual({
      kind: "access_token",
      accessToken: "ya29.access-token",
    });
  });

  it("exchanges JSON refresh-token credentials for an access token", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "fresh-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const ctx = {
      secrets: { resolve: vi.fn().mockResolvedValue(JSON.stringify({
        client_id: "client-id",
        client_secret: "client-secret",
        refresh_token: "refresh-token",
      })) },
      http: { fetch },
    };

    await expect(resolveGoogleAccessToken(ctx, "secret-id")).resolves.toBe("fresh-token");
    expect(fetch).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects invalid JSON credential secrets", () => {
    expect(() => parseGoogleCredentialSecret("{ nope")).toThrow("Google credential secret JSON is invalid.");
  });

  it("rejects refresh-token credential JSON with missing fields", () => {
    expect(() => parseGoogleCredentialSecret(JSON.stringify({ client_id: "client-id" }))).toThrow(
      "Google credential secret JSON must include client_id, client_secret, and refresh_token.",
    );
  });

  it("surfaces failed refresh-token responses", async () => {
    const ctx = {
      secrets: { resolve: vi.fn().mockResolvedValue(JSON.stringify({
        client_id: "client-id",
        client_secret: "client-secret",
        refresh_token: "refresh-token",
      })) },
      http: {
        fetch: vi.fn().mockResolvedValue(new Response("bad", { status: 400, statusText: "Bad Request" })),
      },
    };

    await expect(resolveGoogleAccessToken(ctx, "secret-id")).rejects.toThrow(
      "Google OAuth token refresh failed: 400 Bad Request",
    );
  });
});
