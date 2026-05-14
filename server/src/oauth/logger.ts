import { logger } from "../middleware/logger.js";

export const OAUTH_REDACT_PATHS = [
  "access_token", "refresh_token", "id_token",
  "code", "code_verifier", "client_secret",
  "*.access_token", "*.refresh_token", "*.id_token",
  "*.code", "*.code_verifier", "*.client_secret",
  "data.access_token", "data.refresh_token", "data.id_token",
];

export const oauthLogger = logger.child(
  { component: "oauth" },
  { redact: { paths: OAUTH_REDACT_PATHS, censor: "[REDACTED]" } },
);
