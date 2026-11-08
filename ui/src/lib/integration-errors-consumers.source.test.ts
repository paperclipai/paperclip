import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const source = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
it("resolves current artifact, run, qualification and archive/audit consumers rather than flattening first-party Errors", () => {
  expect(source("components/artifacts/v1/ArtifactFileRow.tsx")).toContain("describeUiError(data.error).body");
  expect(source("components/QueryView.tsx")).toContain("describeUiError(error");
  expect(source("components/voice/NativeVoiceConversation.tsx")).not.toContain("[companyId, endpointId, issueId, client, connect, journal, t]");
  for (const path of ["pages/AgentDetail.tsx", "pages/AgentDetail.production.tsx"]) {
    expect(source(path)).toContain("describeUiError(cancelRun.error).body");
    expect(source(path)).not.toContain("cancelRun.error.message");
  }
  expect(source("components/AgentConfigForm.tsx")).toContain("describeUiError(error).body");
  expect(source("components/new-agent/NewAgentSetup.tsx")).toContain("describeUiError(errorState.cause).body");
  expect(source("components/OnboardingWizard.tsx")).toContain("describeUiError(visibleAdapterEnvError.cause).body");
  expect(source("pages/CompanyImport.tsx")).toContain('presentation: { error: { cause: err }, title: { key: "agents:package_read_failed" } }');
  for (const path of ["pages/audit/AuditFeed.tsx", "pages/audit/AuditFeed.production.tsx"]) expect(source(path)).toContain("presentation: { error: { cause: error");
});
it("preserves auth console diagnostics as raw log-only records, not UI messages", () => {
  const text = source("api/auth.ts");
  expect(text).toContain('console.error("[auth] request failed at the network layer (no HTTP response)"');
  expect(text).toContain('"This means the browser never got a response from the server. Common causes: " +');
  expect(text).toContain('throw networkError;'); expect(text).not.toContain("localizeUiError");
});
it("does not bypass execution-policy preconditions to manufacture a new error path", () => {
  const props = source("components/issue-properties/IssueProperties.tsx");
  expect(props).toContain("if (!policyAvailable) return;");
  expect(props).toContain("executionPolicy: buildExecutionPolicy({");
  const dialog = source("components/NewIssueDialog.tsx");
  expect(dialog).toContain("const executionPolicy = buildExecutionPolicy({\n      reviewerValues:");
  expect(dialog).toContain("describeUiError(resendError.cause");
});
