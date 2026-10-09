import { describe, expect, it } from "vitest";
import { forbidden, unprocessable } from "../errors.js";
import {
  aiConnectionConfigurationFailure,
  aiConnectionCredentialNotSharedFailure,
  isAiConnectionConfigurationReason,
  readAiConnectionConfigurationFailure,
} from "./ai-connection-configuration-failure.js";

describe("AI selection failure provenance", () => {
  it("preserves HTTP behavior while retaining only an owned bounded reason", () => {
    const error = aiConnectionConfigurationFailure("ai_connection_default_missing", "Choose an account", { connectionId: "synthetic-connection" });
    expect(error).toMatchObject({ status: 422, message: "Choose an account", details: {
      code: "ai_connection_default_missing", connectionId: "synthetic-connection",
    } });
    expect(readAiConnectionConfigurationFailure(error)).toBe("ai_connection_default_missing");
    expect(Object.keys(error)).toEqual(["status", "details"]);
  });

  it("preserves the credential sharing 403 without adding public error details", () => {
    const error = aiConnectionCredentialNotSharedFailure();
    expect(error).toMatchObject({ status: 403, message: "This credential is not shared with the responsible user" });
    expect(error.details).toBeUndefined();
    expect(Object.keys(error)).toEqual(["status", "details"]);
    expect(readAiConnectionConfigurationFailure(error)).toBe("ai_connection_credential_not_shared");
    expect(readAiConnectionConfigurationFailure(Object.freeze(error))).toBe("ai_connection_credential_not_shared");
  });

  it.each([
    new Error("Connect an account and choose your personal default"),
    unprocessable("Choose an account", { code: "ai_connection_default_missing" }),
    { status: 422, details: { code: "ai_connection_default_missing" } },
    Object.assign(new Error("database failed"), { code: "configuration_incomplete" }),
    forbidden("This credential is not shared with the responsible user"),
    forbidden("This credential is not shared with the responsible user", { code: "ai_connection_credential_not_shared" }),
    null,
  ])("does not infer provenance from an error name, message, or HTTP shape: %j", (error) => {
    expect(readAiConnectionConfigurationFailure(error)).toBeNull();
  });

  it.each([null, undefined, {}, [], "ai_connection_busy", "provider_error", "toString"])(
    "rejects unknown or malformed persisted reasons: %j", (value) => {
      expect(isAiConnectionConfigurationReason(value)).toBe(false);
    },
  );
});
