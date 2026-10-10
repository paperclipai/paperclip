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
      brokerReason: undefined,
      errorClass: "PaperclipCloudConnectorError",
      originLayer: "paperclip_cloud_connector",
      isPaperclipCloudConnectorError: true,
      isHttpError: false,
      isProviderError: false,
      isGenericError: false,
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
      brokerReason: undefined,
      errorClass: "HttpError",
      originLayer: "provider_callback",
      isPaperclipCloudConnectorError: false,
      isHttpError: true,
      isProviderError: true,
      isGenericError: false,
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
      brokerReason: undefined,
      errorClass: "Error",
      originLayer: "unknown",
      isPaperclipCloudConnectorError: false,
      isHttpError: false,
      isProviderError: false,
      isGenericError: true,
      installationUrl: undefined,
      managementUrl: undefined,
    });
    expect(JSON.stringify(failure)).not.toMatch(
      /provider-body|access-token|cookie-value/,
    );
  });

  it("preserves an allowlisted broker rejection reason without retaining its message", () => {
    const failure = paperclipCloudConnectorCallbackFailure(
      new PaperclipCloudConnectorError(
        "broker private response body",
        "CONNECTOR_REQUEST_FAILED",
        502,
        "PROVIDER_OPERATION_FAILED",
      ),
    );

    expect(failure).toMatchObject({
      code: "CONNECTOR_REQUEST_FAILED",
      status: 502,
      brokerReason: "PROVIDER_OPERATION_FAILED",
      errorClass: "PaperclipCloudConnectorError",
      originLayer: "paperclip_cloud_connector",
    });
    expect(JSON.stringify(failure)).not.toContain("private response body");
  });
});
