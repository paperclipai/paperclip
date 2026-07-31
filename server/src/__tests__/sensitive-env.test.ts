import { describe, expect, it } from "vitest";
import { isSensitiveEnvKey } from "../services/sensitive-env.js";

describe("isSensitiveEnvKey", () => {
  it.each([
    "AUTH",
    "AUTH-HEADER",
    "AUTHHEADER",
    "AUTH_HEADER",
    "AUTHTOKEN",
    "SYNTHETIC_CREDENTIAL_ZETA",
    "SYNTHETIC_CREDENTIAL_BETA",
    "ACCESSTOKEN",
    "GITHUB-AUTH",
    "GITHUBAUTH",
    "GITHUB_AUTH",
    "OPENAI_API_KEY_ENGINEER",
    "PAPERCLIP_POSTHOG_API_KEY",
    "QA_DATABASE_URL",
    "READINESS_READ_TOKEN",
    "SYNTHETIC_CREDENTIAL_DELTA",
    "VERCEL_AUTOMATION_BYPASS_SECRET",
    "SYNTHETIC_CREDENTIAL_EPSILON",
    "buffer_api_key",
    "SYNTHETIC_CREDENTIAL_GAMMA",
    "SYNTHETIC_CREDENTIAL_GAMMA_2",
    "SYNTHETIC_CREDENTIAL_ALPHA",
  ])("classifies %s as sensitive", (key) => {
    expect(isSensitiveEnvKey(key)).toBe(true);
  });

  it.each([
    "AUTHOR_NAME",
    "AUTH_MODE",
    "AUTHORITY_URL",
    "AUTHENTICATION_MODE",
    "AUTHORIZED_USERS",
    "OAUTH_MODE",
    "PATH",
    "PAPERCLIP_API_URL",
    "PAPERCLIP_WORKSPACE_ROOT",
    "COMPATIBILITY_MODE",
    "GITHUB_AUTH_MODE",
    "TOKENIZATION_MODE",
  ])("does not classify %s as sensitive", (key) => {
    expect(isSensitiveEnvKey(key)).toBe(false);
  });
});
