import { describe, expect, it } from "vitest";

import { HttpError } from "../errors.js";
import { PaperclipCloudConnectorError } from "../services/paperclip-cloud-connector.js";
import { paperclipCloudConnectorCallbackFailure } from "./tool-access.js";

describe("Paperclip Cloud OAuth callback diagnostics", () => {
  it.each([
    ["CONNECTOR_REQUEST_FAILED", 503],
    ["REAUTHORIZATION_REQUIRED", 409],
  ])("preserves a Cloud Connector error code and status (%s)", (code, status) => {
    const error = new PaperclipCloudConnectorError(
      `Paperclip Cloud connector rejected the request (${code}) private-secret-value`,
      code,
      status,
    );

    expect(paperclipCloudConnectorCallbackFailure(error)).toEqual({
      code,
      status,
      installationUrl: undefined,
      managementUrl: undefined,
    });
    expect(JSON.stringify(paperclipCloudConnectorCallbackFailure(error))).not.toContain(
      "private-secret-value",
    );
  });

  it("keeps Paperclip-authored HttpError details and status", () => {
    expect(
      paperclipCloudConnectorCallbackFailure(
        new HttpError(400, "OAuth denied", {
          code: "oauth_authorization_denied",
          installationUrl: "https://github.com/apps/paperclip/installations/new",
        }),
      ),
    ).toEqual({
      code: "oauth_authorization_denied",
      status: 400,
      installationUrl: "https://github.com/apps/paperclip/installations/new",
      managementUrl: undefined,
    });
  });

  it("does not expose arbitrary error text or provider payloads", () => {
    const failure = paperclipCloudConnectorCallbackFailure(
      new Error("provider-body access-token cookie-value"),
    );

    expect(failure).toEqual({
      code: "paperclip_cloud_connector_callback_failed",
      status: 500,
      installationUrl: undefined,
      managementUrl: undefined,
    });
    expect(JSON.stringify(failure)).not.toMatch(
      /provider-body|access-token|cookie-value/,
    );
  });
});
