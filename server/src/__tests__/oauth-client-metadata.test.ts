import { describe, expect, it } from "vitest";

import {
  OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH,
  resolveOAuthClientIdMetadataDocumentUrl,
} from "../services/tool-access.js";

describe("OAuth Client ID Metadata Document selection", () => {
  it("uses a publicly resolved HTTPS callback origin", async () => {
    const redirectUri = "https://paperclip.example:42001/api/tools/oauth/callback";

    await expect(resolveOAuthClientIdMetadataDocumentUrl(
      redirectUri,
      async () => [{ address: "93.184.216.34", family: 4 }],
    )).resolves.toBe(`https://paperclip.example:42001${OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH}`);
  });

  it("rejects a Tailscale-range hostname so OAuth can fall back to DCR", async () => {
    await expect(resolveOAuthClientIdMetadataDocumentUrl(
      "https://paperclip.tailnet.example:42001/api/tools/oauth/callback",
      async () => [{ address: "100.100.100.100", family: 4 }],
    )).resolves.toBeNull();
  });

  it.each([
    "http://localhost:3100/api/tools/oauth/callback",
    "https://127.0.0.1:3100/api/tools/oauth/callback",
  ])("rejects a non-public callback origin %s", async (redirectUri) => {
    await expect(resolveOAuthClientIdMetadataDocumentUrl(redirectUri)).resolves.toBeNull();
  });
});
