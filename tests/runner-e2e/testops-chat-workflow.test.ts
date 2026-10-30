import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { expect, it } from "vitest";
import { validateChatTestOpsDispatch } from "./testops-chat-dispatch.js";

const workflow = parse(readFileSync(new URL("../../.github/workflows/chat-feature-testops.yml", import.meta.url), "utf8"));
function context() {
  return { env: { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: "paperclipai/paperclip", GITHUB_REF: "refs/heads/master",
    GITHUB_WORKFLOW_REF: "paperclipai/paperclip/.github/workflows/chat-feature-testops.yml@refs/heads/master", GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "12345", GITHUB_RUN_ATTEMPT: "1", GITHUB_ACTOR_ID: "123", TESTOPS_ALLOWED_ACTOR_IDS: "[123]" },
    event: { repository: { full_name: "paperclipai/paperclip", private: false, default_branch: "master" }, ref: "refs/heads/master", sender: { id: 123 }, inputs: { ALLURE_JOB_RUN_ID: "456" } as Record<string, string> } };
}
it("admits the actual TestOps service input and only the closed metadata bootstrap alternative", () => {
  const f = context(); expect(validateChatTestOpsDispatch(f.env, f.event, 123).operation).toBe("evaluate");
  f.event.inputs = { operation: "bootstrap" }; expect(validateChatTestOpsDispatch(f.env, f.event, 123).operation).toBe("bootstrap");
  f.event.inputs.operation = "launch-plan"; expect(validateChatTestOpsDispatch(f.env, f.event, 123).operation).toBe("launch-plan");
  f.event.inputs.ALLURE_JOB_RUN_ID = "456"; expect(() => validateChatTestOpsDispatch(f.env, f.event, 123)).toThrow();
  delete f.event.inputs.ALLURE_JOB_RUN_ID;
  f.event.inputs.operation = "other"; expect(() => validateChatTestOpsDispatch(f.env, f.event, 123)).toThrow();
});
it.each(["unlisted-trigger", "wrong-source", "replay", "extra-input", "missing-jobrun", "foreign-repo"])("rejects %s before any service credential operation", kind => {
  const f = context(); let trigger = 123;
  if (kind === "unlisted-trigger") trigger = 456;
  if (kind === "wrong-source") f.env.GITHUB_REF = "refs/heads/unreviewed";
  if (kind === "replay") f.env.GITHUB_RUN_ATTEMPT = "2";
  if (kind === "extra-input") f.event.inputs.target_branch = "other";
  if (kind === "missing-jobrun") f.event.inputs = {};
  if (kind === "foreign-repo") f.event.repository.full_name = "foreign/repo";
  expect(() => validateChatTestOpsDispatch(f.env, f.event, trigger)).toThrow();
});
it("keeps provider and TestOps service credentials in separate jobs", () => {
  const jobs = workflow.jobs;
  for (const [id, job] of Object.entries(jobs) as Array<[string, any]>) {
    const text = JSON.stringify(job);
    if (text.includes("secrets.OPENROUTER_API_KEY")) expect(id).toBe("chat");
    if (text.includes("secrets.ALLURE_TOKEN")) expect(["select", "upload"]).toContain(id);
    if (id !== "chat") expect(text).not.toContain("pnpm test:e2e:runner --");
    expect(job.steps.some((step: any) => step.run === "node tests/runner-e2e/testops-chat-dispatch.ts")).toBe(true);
  }
  expect(jobs.chat.environment).toBe("runner-e2e-private-paid");
  expect(jobs.select.environment).toBe("runner-e2e-testops-reporting");
  expect(jobs.upload.environment).toBe("runner-e2e-testops-reporting");
});
it("requires token-isolated selection before the fixed AWS run and keeps bootstrap outside all model jobs", () => {
  expect(workflow.on).toHaveProperty("workflow_dispatch"); expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(["operation", "ALLURE_JOB_RUN_ID", "ALLURE_USERNAME"]);
  expect(workflow.on.workflow_dispatch.inputs.operation.default).toBe("evaluate");
  expect(workflow.jobs.chat.needs).toContain("select"); expect(workflow.jobs.build.needs).toContain("select");
  expect(workflow.jobs.chat.if).toBe("needs.authorize.outputs.operation == 'evaluate'");
  expect(workflow.jobs.build.if).toBe("needs.authorize.outputs.operation == 'evaluate'");
  const paid = workflow.jobs.chat.steps.find((s: any) => s.env?.OPENROUTER_API_KEY);
  expect(paid.run).toContain("--id chat-features.runner-opencode-deepseek-1017.local.create-backlog --max-parallel 1 --max-automatic-retries 0");
  expect(workflow.jobs.chat.steps.findIndex((s: any) => s.name === "Verify immutable outputs and token-free TestOps selection")).toBeLessThan(workflow.jobs.chat.steps.indexOf(paid));
  expect(workflow.jobs.authorize.outputs.runner).toBe("runs-on/fleet=paperclip-public-pr-x64/env=public-ci");
  expect(workflow.jobs.chat["runs-on"]).toBe("${{ needs.authorize.outputs.runner }}");
});
it("uploads only the trusted safe projection after successful strict private report retention", () => {
  const steps = workflow.jobs.report.steps;
  expect(steps.find((s: any) => s.id === "export").if).toBe("always() && steps.private_report.outcome == 'success'");
  expect(steps.find((s: any) => s.with?.name?.startsWith("runner-e2e-testops-")).with.path).toBe("runner-e2e-testops/");
  expect(JSON.stringify(workflow)).not.toContain("MANUAL_PRIVATE_APPROVALS_JSON");
  expect(Object.values(workflow.jobs).flatMap((j: any) => j.steps).filter((s: any) => s.uses?.startsWith("actions/upload-artifact")).some((s: any) => s.with.path === "tests/runner-e2e/results/")).toBe(false);
});

it("initializes the actual TestOps association and never fabricates setup results", () => {
  const steps = workflow.jobs.select.steps;
  const installer = steps.find((s: any) => s.uses?.startsWith("allure-framework/setup-allurectl@"));
  expect(installer.uses).toBe("allure-framework/setup-allurectl@2d89ee0b7ba2f59dbe9849b6df5763cab78e14db");
  expect(installer.with["allurectl-version"]).toBe("2.23.1");
  const bootstrap = steps.find((s: any) => s.run?.includes("testops-chat-reporter.mjs bootstrap"));
  expect(bootstrap.run).toContain("mkdir -m 700");
  expect(bootstrap.run).toContain("allurectl watch -- node");
  expect(bootstrap.env.ALLURE_RESULTS).toBe("${{ runner.temp }}/chat-testops-bootstrap-results");
  const select = steps.find((s: any) => s.id === "selection");
  expect(select.run).toContain("allurectl watch -- node");
  for (const name of ["CHAT_TESTOPS_CASE_ID", "CHAT_TESTOPS_PLAN_ID", "CHAT_TESTOPS_JOB_ID"])
    expect(select.env[name]).toBe(`\${{ vars.${name} }}`);
  const metadata = steps.find((s: any) => s.with?.name?.startsWith("chat-testops-setup-"));
  expect(metadata.if).toBe("always() && needs.authorize.outputs.operation == 'bootstrap'");
  expect(metadata.with.path).not.toContain("results");
});
it("authenticates the same-run selection again before converting and uploading", () => {
  const steps = workflow.jobs.upload.steps;
  const receipt = steps.find((s: any) => s.with?.path === "chat-testops-selection");
  expect(receipt.with["artifact-ids"]).toBe("${{ needs.select.outputs.artifact_id }}");
  const upload = steps.find((s: any) => s.run?.includes("testops-chat-reporter.mjs upload"));
  expect(upload.run).toContain("allurectl watch -- node");
  expect(upload.env.EXPECTED_SELECTION_SHA256).toBe("${{ needs.select.outputs.sha256 }}");
  expect(steps.indexOf(receipt)).toBeLessThan(steps.indexOf(upload));
  expect(JSON.stringify(workflow.jobs.select)).not.toContain("OPENROUTER_API_KEY");
  expect(JSON.stringify(workflow.jobs.upload)).not.toContain("OPENROUTER_API_KEY");
});

it("keeps the one plan launch outside Allure watch and every AWS/model job", () => {
  const steps = workflow.jobs.select.steps;
  const launch = steps.find((s: any) => s.run?.endsWith("testops-chat-reporter.mjs launch-plan"));
  expect(launch.if).toBe("needs.authorize.outputs.operation == 'launch-plan'");
  expect(launch.run).not.toContain("watch");
  expect(launch.env.CHAT_TESTOPS_OPERATION_PARAMETER_ID).toBe("${{ vars.CHAT_TESTOPS_OPERATION_PARAMETER_ID }}");
  expect(launch.env.CHAT_TESTOPS_INTEGRATION_ID).toBe("${{ vars.CHAT_TESTOPS_INTEGRATION_ID }}");
  expect(launch.env.CHAT_TESTOPS_LAUNCH_NONCE).toBe("${{ vars.CHAT_TESTOPS_LAUNCH_NONCE }}");
  expect(launch.env.CHAT_TESTOPS_LAUNCH_RUN_NUMBER).toBe("${{ vars.CHAT_TESTOPS_LAUNCH_RUN_NUMBER }}");
  expect(launch.env.TESTOPS_TRIGGERING_ACTOR_ID).toBe("${{ needs.authorize.outputs.triggering_actor_id }}");
  expect(launch.env.TESTOPS_ALLOWED_ACTOR_IDS).toBe("${{ vars.RUNNER_E2E_ALLOWED_ACTOR_IDS }}");
  expect(launch.env.GH_TOKEN).toBe("${{ github.token }}");
  expect(launch.run).not.toContain("sleep");
  expect(steps.find((s: any) => s.uses?.startsWith("allure-framework/setup-allurectl@")).if).toBe("needs.authorize.outputs.operation != 'launch-plan'");
  for (const name of ["build", "chat"]) expect(workflow.jobs[name].if).toBe("needs.authorize.outputs.operation == 'evaluate'");
  expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
});

it("accepts the documented TestOps username metadata without treating it as an actor", () => {
  const f = context(); f.event.inputs.ALLURE_USERNAME = "service-metadata";
  expect(validateChatTestOpsDispatch(f.env, f.event, 123).operation).toBe("evaluate");
  expect(() => validateChatTestOpsDispatch(f.env, f.event, 456)).toThrow();
  expect(JSON.stringify(workflow.jobs)).not.toContain("inputs.ALLURE_USERNAME");
});

it("includes every native Node helper control in the normal unit owner", () => {
  const launcher = readFileSync(new URL("./run-unit.mjs", import.meta.url), "utf8");
  const config = readFileSync(new URL("./vitest.config.ts", import.meta.url), "utf8");
  for (const file of ["chat-feature-testops-api.test.mjs", "chat-feature-testops-cli.test.mjs", "chat-feature-testops-results.test.mjs", "testops-chat-reporter.test.mjs"]) {
    expect(launcher).toContain(`"tests/runner-e2e/${file}"`);
    expect(config).toContain(`"${file}"`);
  }
});

it("verifies the actual server outcome after watch without masking an original failed upload", () => {
  const steps = workflow.jobs.upload.steps;
  const watch = steps.find((s: any) => s.id === "allure_upload");
  const verify = steps.find((s: any) => s.id === "verify_upload");
  expect(watch.run).toContain("allurectl watch -- node");
  expect(watch["continue-on-error"]).toBeUndefined();
  expect(verify.run).toBe("node tests/runner-e2e/testops-chat-reporter.mjs verify-upload runner-e2e-testops");
  expect(verify.if).toBe("always() && !cancelled() && (steps.allure_upload.outcome == 'success' || steps.allure_upload.outcome == 'failure')");
  expect(verify.env).toEqual(watch.env);
  expect(steps.indexOf(verify)).toBeGreaterThan(steps.indexOf(watch));
  const proof = steps.find((s: any) => s.with?.name?.startsWith("chat-testops-verification-"));
  expect(proof.with.path.split("\n").filter(Boolean)).toHaveLength(2);
  expect(proof.with.path).not.toContain("allure-results");
});

it("carries only the existing source-reviewed lock through build and worker install", () => {
  const build = workflow.jobs.build.steps;
  const install = build.find((s: any) => s.run?.includes("pnpm install --frozen-lockfile"));
  expect(install.run).toContain("node tests/runner-e2e/testops-chat-lock.ts > chat-testops-lock.json");
  expect(install.run).not.toContain("--lockfile-only");
  const archive = build.find((s: any) => s.run?.includes("tar -czf chat-testops-build"));
  expect(archive.run).toContain("node tests/runner-e2e/testops-chat-lock.ts > chat-testops-lock.json");
  expect(archive.run).toContain("chat-testops-lock.json pnpm-lock.yaml");
  const worker = workflow.jobs.chat.steps.find((s: any) => s.name === "Verify immutable outputs and token-free TestOps selection");
  expect(worker.run).toContain("node tests/runner-e2e/testops-chat-lock.ts > chat-testops-worker-lock.json");
  expect(worker.run).toContain("cmp chat-testops-lock.json chat-testops-worker-lock.json");
  expect(worker.run.indexOf("cmp chat-testops-lock.json")).toBeLessThan(worker.run.indexOf("pnpm install --frozen-lockfile"));
});
