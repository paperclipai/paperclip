import { describe, expect, it } from "vitest";
import { createAgentIdentityRedactor, secretNamedEnvironmentValues } from "./agent-identity-redaction.js";

const REDACTED = "***REDACTED***";

const BOUND_SECRET = "graph-synthetic-secret-0123456789";
const MAIL_PASSWORD = "mail-synthetic-pass";
const SERVICE_KEY = "svc-synthetic-api-key-24680";
const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const SERVICE_URL = "https://service.example.test/v1";

function redactorFor(...envs: readonly unknown[]) {
  return createAgentIdentityRedactor(undefined, secretNamedEnvironmentValues(...envs));
}

describe("secret-named environment values", () => {
  it("selects values whose key names a credential and leaves the other keys alone", () => {
    expect(secretNamedEnvironmentValues({
      MS_GRAPH_CLIENT_SECRET: BOUND_SECRET,
      MAIL_PASS: MAIL_PASSWORD,
      SERVICE_API_KEY: SERVICE_KEY,
      ACCOUNT_CREDENTIALS: "account-synthetic-credentials",
      MS_GRAPH_CLIENT_ID: CLIENT_ID,
      SERVICE_URL,
      INSTANCE_NAME: "primary",
      AGENT_PUBLIC_KEY: "public-synthetic-material",
      EMPTY: "",
      NUMBER: 12345678,
    })).toEqual([BOUND_SECRET, MAIL_PASSWORD, SERVICE_KEY, "account-synthetic-credentials"]);
  });

  it("takes no value from a key that does not name a credential, including a connection URL", () => {
    expect(secretNamedEnvironmentValues({
      DATABASE_URL: "postgres://app:Sup3rSynthetic0@db.example.test:5432/app",
      SERVICE_URL,
      AGENT_KEY_ID: CLIENT_ID,
      SORT_ORDER: "ascending",
    })).toEqual([]);
  });

  it("reads every environment source, deduplicates, and ignores what is not a string", () => {
    expect(secretNamedEnvironmentValues(
      { SERVICE_API_KEY: SERVICE_KEY },
      { OTHER_API_KEY: SERVICE_KEY, INHERITED_TOKEN: BOUND_SECRET },
      null,
      "not-an-environment",
      ["not-an-environment"],
    )).toEqual([SERVICE_KEY, BOUND_SECRET]);
    expect(secretNamedEnvironmentValues()).toEqual([]);
  });

  it("masks a selected value in run output and keeps the non-secret values readable", () => {
    const env = { MS_GRAPH_CLIENT_SECRET: BOUND_SECRET, MS_GRAPH_CLIENT_ID: CLIENT_ID, SERVICE_URL };
    const redactor = redactorFor(env);
    expect(redactor.chunk("stdout", `MS_GRAPH_CLIENT_SECRET=${BOUND_SECRET}\n`) + redactor.finish("stdout"))
      .toBe(`MS_GRAPH_CLIENT_SECRET=${REDACTED}\n`);
    const second = redactorFor(env);
    expect(second.chunk("stdout", `${CLIENT_ID} ${SERVICE_URL}\n`) + second.finish("stdout"))
      .toBe(`${CLIENT_ID} ${SERVICE_URL}\n`);
    expect(redactorFor(env).redact({ output: `echo ${BOUND_SECRET}`, clientId: CLIENT_ID }))
      .toEqual({ output: `echo ${REDACTED}`, clientId: CLIENT_ID });
  });

  it("masks a selected value that arrives split across two output chunks", () => {
    const redactor = redactorFor({ INHERITED_TOKEN: BOUND_SECRET });
    const first = redactor.chunk("stdout", `token is ${BOUND_SECRET.slice(0, 11)}`);
    const rest = redactor.chunk("stdout", `${BOUND_SECRET.slice(11)} done\n`) + redactor.finish("stdout");
    expect(first + rest).toBe(`token is ${REDACTED} done\n`);
  });

  it("leaves a selected value shorter than the minimum form length readable", () => {
    const redactor = redactorFor({ SHORT_TOKEN: "pin4242" });
    expect(redactor.chunk("stdout", "SHORT_TOKEN=pin4242\n") + redactor.finish("stdout"))
      .toBe("SHORT_TOKEN=pin4242\n");
  });
});
