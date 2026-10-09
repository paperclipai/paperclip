import { describe, expect, it } from "vitest";
import { runnerMatrix, runnerSuites, suiteDefinitionHash } from "./catalog.js";
import { captureHermesApiAccountOwner, gradeHermesApiConnection, hermesBedrockConnectionChoice } from "./hermes-api-connections.js";
import { buildPaperclipServerEnvironment, buildRunnerE2EProcessEnvironment } from "./harness-env.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";

describe("Hermes managed Bedrock qualification", () => {
  const suite = runnerSuites.find(value => value.id === "hermes-bedrock-connections")!;
  const cells = runnerMatrix.filter(value => value.suite.id === suite.id);
  const routing = structuredClone(hermesBedrockConnectionChoice.routing);
  const model = hermesBedrockConnectionChoice.model;

  it("registers only two explicit pending single-attempt cells with exact routing", () => {
    expect(cells).toHaveLength(2);
    expect(new Set(cells.map(value => value.environment.id))).toEqual(new Set(["local", "daytona"]));
    expect(suite).toMatchObject({ manualOnly: true, definitionMetadata: { qualification: "pending", accountMode: "delegated", providerTurns: 1, maximumAttemptsPerCell: 1, budgetMonthlyCents: 200 } });
    for (const cell of cells) {
      expect(cell.profile).toMatchObject({ credential: "AWS_BEARER_TOKEN_BEDROCK", model, managedConnectionRouting: routing, modelQualification: { source: "candidate_runner_profile" } });
      expect(cell.requiredCredentials).toContain("AWS_BEARER_TOKEN_BEDROCK");
      expect(cell.task).toMatchObject({ id: "hello-complete", expectedRunCount: 1, automaticRetryPolicy: "single_attempt" });
      expect(JSON.parse(buildRunnerE2EProcessEnvironment({}, [cell]).PAPERCLIP_RUNNER_ACPX_QUALIFICATION!)).toEqual([{ agent: "hermes", model }]);
    }
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(value => value.suite.id === suite.id)).toBe(false);
    expect(() => buildRunnerE2EProcessEnvironment({}, [{ ...cells[0]!, suite: { ...suite, manualOnly: false } }])).toThrow("explicit");
  });

  it("records routing changes in the historical definition digest", () => {
    const changed = { ...suite, profiles: suite.profiles.map(profile => ({ ...profile, managedConnectionRouting: { ...routing, region: "us-west-2" } })) };
    expect(suiteDefinitionHash(changed)).not.toBe(suiteDefinitionHash(suite));
  });

  it("keeps ambient AWS identities and the selected bearer out of the server environment", () => {
    const source = { PATH: "/fixture/bin", AWS_PROFILE: "operator", AWS_ACCESS_KEY_ID: "fixture-access", AWS_SECRET_ACCESS_KEY: "fixture-secret", AWS_SESSION_TOKEN: "fixture-session", AWS_BEARER_TOKEN_BEDROCK: "fixture-bearer", AWS_SHARED_CREDENTIALS_FILE: "/operator/credentials", AWS_CONFIG_FILE: "/operator/config", AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/operator/role" };
    const server = buildPaperclipServerEnvironment(buildRunnerE2EProcessEnvironment(source, [cells[0]!]));
    expect(server.PATH).toBe(source.PATH);
    for (const key of Object.keys(source).filter(key => key.startsWith("AWS_"))) expect(server[key]).toBeUndefined();
  });

  it.each(["valid", "region", "protocol", "auth", "model", "missing-routing", "grant", "missing-grant"])("rejects incorrect public routing before a paid task: %s", async fault => {
    const observed: Record<string, unknown> = structuredClone(routing);
    if (fault === "region") observed.region = "us-west-2";
    if (fault === "protocol") observed.protocol = "messages";
    if (fault === "auth") observed.auth = "api_key";
    if (fault === "model") observed.models = [{ id: "wrong-model" }];
    const receipt = await captureHermesApiAccountOwner({ companyId: "company", connectionId: "account", provider: "anthropic", expectedRouting: routing, expectedGrantId: "grant", api: {
      async get<T>() { return { currentUserId: "user", connections: [{ id: "account", companyId: "company", provider: "anthropic", method: "api_key", ownership: "personal", ownerUserId: "user", status: "connected", routing: fault === "missing-routing" ? undefined : observed, grantId: fault === "missing-grant" ? undefined : fault === "grant" ? "foreign" : "grant" }] } as T; },
    } });
    expect(receipt.checks.every(check => check.passed)).toBe(fault === "valid");
    expect(receipt.routing?.observed).toEqual(fault === "missing-routing" ? null : observed);
  });

  it.each(["valid", "grant", "missing-grant", "mode", "owner", "model"])("grades the actual explicitly selected native account and inference profile: %s", fault => {
    const account = { connectionId: "account", grantId: "grant", provider: "anthropic", method: "api_key", mode: "delegated", responsibleUserId: "user" };
    if (fault === "grant") account.grantId = "foreign";
    if (fault === "missing-grant") account.grantId = "";
    if (fault === "mode") account.mode = "responsible_user";
    if (fault === "owner") account.responsibleUserId = "foreign";
    const checks = gradeHermesApiConnection({ companyId: "company", agentId: "agent", issueId: "task", connectionId: "account", expectedGrantId: "grant", provider: "anthropic", model, expectedResponsibleUserId: "user", accountMode: "delegated", runs: [{ companyId: "company", agentId: "agent", issueId: "task", responsibleUserId: "user", status: "succeeded", runtimeMode: "native", contextSnapshot: { aiConnection: account }, runnerProfileJson: { nativeExecutionInput: { provider: { kind: "acpx", agent: "hermes", model } }, sessionCheckpoint: { providerIdentity: { kind: "acpx", requestedModel: model, effectiveModel: fault === "model" ? "wrong-model" : model } } } }] });
    expect(checks.every(check => check.passed)).toBe(fault === "valid");
  });
});
