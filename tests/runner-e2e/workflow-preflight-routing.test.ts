import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(await readFile(new URL("../../.github/workflows/runner-full-stack-e2e.yml", import.meta.url), "utf8"));
const jobs = workflow.jobs;
const requiredJobs = ["authorize", "target_lock", "catalog", "daytona_image", "build_runner_artifacts"];

function permits(job: string, { remote = "false", pack = "skipped", cadence = "", cancelled = false, failedJob = "", result = "failure", wrongSource = false, wrongRef = false } = {}) {
  const needs = Object.fromEntries(requiredJobs.map(name => [name, { result: name === failedJob ? result : "success", outputs: {} }]));
  needs.authorize!.outputs = { target_sha: wrongSource ? "other-source" : "reviewed-source" };
  needs.catalog!.outputs = { needs_remote_provider_pack: remote.toLowerCase(), operations_cadence: cadence };
  needs.build_remote_provider_pack = { result: pack, outputs: {} };
  const condition = jobs[job].if.trim().replace(/^\$\{\{\s*|\s*\}\}$/gu, "");
  if (!/\b(?:always|cancelled|failure|success)\(/u.test(condition) && jobs[job].needs.some((name: string) => needs[name]?.result !== "success")) return false;
  return vm.runInNewContext(condition, {
    needs,
    github: { event_name: "workflow_dispatch", sha: "reviewed-source", ref: wrongRef ? "refs/heads/other" : "refs/heads/master", event: { repository: { default_branch: "master" } } },
    cancelled: () => cancelled,
    format: (template: string, value: string) => template.replace("{0}", value),
    vars: {},
  }, { timeout: 1000 });
}

describe("trusted campaign preparation placement", () => {
  it("keeps authorization hosted and places preparation only after its reviewed runner selection", () => {
    expect(jobs.authorize["runs-on"]).toBe("ubuntu-latest");
    for (const id of ["target_lock", "catalog"]) {
      expect(jobs[id]["runs-on"]).toBe("${{ needs.authorize.outputs.test_runner }}");
      expect([jobs[id].needs].flat()).toContain("authorize");
      expect(jobs[id].permissions).toEqual({ contents: "read" });
      const checkout = jobs[id].steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/checkout@"));
      expect(checkout.with).toMatchObject({ ref: "${{ needs.authorize.outputs.target_sha }}", "persist-credentials": false });
    }
  });

  it("does not allocate the remote-pack runner for local or unknown requirements", () => {
    expect(permits("build_remote_provider_pack", { remote: "true" })).toBe(true);
    expect(permits("build_remote_provider_pack", { remote: "TRUE" })).toBe(true);
    for (const remote of ["false", "", "unknown", "not-a-boolean"]) {
      expect(permits("build_remote_provider_pack", { remote }), remote).toBe(false);
    }
    expect(jobs.build_remote_provider_pack.steps.some((step: { name?: string }) => step.name === "No remote provider pack needed")).toBe(false);
  });
});

for (const [job, cadence] of [["test", ""], ["test_recurring", "daily"]] as const) {
  describe(`${job} optional remote-pack dependency`, () => {
    it("admits local intentional skips and successful required remote packs through the protected paid gate", () => {
      expect(permits(job, { cadence })).toBe(true);
      expect(permits(job, { cadence, remote: "true", pack: "success" })).toBe(true);
      expect(jobs[job].environment.name).toBe(job === "test" ? "runner-e2e-paid" : "runner-e2e-private-paid");
      expect(jobs[job].needs).toEqual([...requiredJobs, "build_remote_provider_pack"]);
      expect(jobs[job].if).toContain("!cancelled()");
    });

    it("refuses failed, missing, unknown or mismatched pack states", () => {
      for (const [remote, pack] of [["true", "skipped"], ["true", "failure"], ["false", "failure"], ["false", "success"], ["false", "cancelled"], ["", "skipped"], ["unknown", "success"], ["true", ""], ["false", "unknown"]]) {
        expect(permits(job, { cadence, remote, pack }), `${remote}/${pack}`).toBe(false);
      }
    });

    it("refuses every failed, skipped or cancelled required dependency", () => {
      for (const failedJob of requiredJobs) {
        for (const result of ["failure", "skipped", "cancelled", ""]) {
          expect(permits(job, { cadence, failedJob, result }), `${failedJob}/${result}`).toBe(false);
        }
      }
      expect(permits(job, { cadence, cancelled: true })).toBe(false);
    });

    it("retains the manual or recurring cadence and source boundaries", () => {
      expect(permits(job, { cadence: job === "test" ? "daily" : "" })).toBe(false);
      if (job === "test_recurring") {
        expect(permits(job, { cadence, wrongSource: true })).toBe(false);
        expect(permits(job, { cadence, wrongRef: true })).toBe(false);
      }
    });
  });
}
