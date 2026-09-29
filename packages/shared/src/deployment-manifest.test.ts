import { describe, expect, it } from "vitest";
import { deploymentManifestSchema } from "./deployment-manifest.js";

const company = { fields: { name: "Example" } };
const agent = { company: "example", fields: { name: "Worker", adapterType: "process" } };
describe("deployment manifest", () => {
  it("requires one explicit primary and a valid source for each declared project workspace", () => {
    const manifest = {
      version: 1, owner: "deployment", companies: { example: company },
      projects: { main: { company: "example", fields: { name: "Main" } } },
      projectWorkspaces: { checkout: { project: "main", fields: {
        name: "Checkout", sourceType: "remote_managed", remoteWorkspaceRef: "project-key", isPrimary: true,
      } } },
    };
    expect(deploymentManifestSchema.parse(manifest).projectWorkspaces.checkout.project).toBe("main");
    for (const projectWorkspaces of [
      { checkout: { ...manifest.projectWorkspaces.checkout, project: "missing" } },
      { checkout: { project: "main", fields: { name: "No source", isPrimary: true } } },
      { checkout: { ...manifest.projectWorkspaces.checkout, fields: { cwd: "/checkout", isPrimary: false } } },
      { ...manifest.projectWorkspaces, other: manifest.projectWorkspaces.checkout },
    ]) expect(deploymentManifestSchema.safeParse({ ...manifest, projectWorkspaces }).success).toBe(false);
  });
  it("accepts native execution policy and rejects unmanaged database references", () => {
    const policy = { enabled: true, defaultMode: "shared_workspace", sharedWorkspaceConcurrency: "serialize",
      allowIssueOverride: false, workspaceStrategy: { type: "project_primary" } };
    const manifest = { version: 1, owner: "deployment", companies: { example: company },
      projects: { main: { company: "example", fields: { name: "Main", executionWorkspacePolicy: policy } } } };
    expect(deploymentManifestSchema.parse(manifest).projects.main.fields.executionWorkspacePolicy).toEqual(policy);
    for (const invalid of [
      { ...policy, sharedWorkspaceConcurrency: "sometimes" },
      { ...policy, writableRepositories: ["arbitrary"] },
      { ...policy, defaultProjectWorkspaceId: "00000000-0000-4000-8000-000000000001" },
      { ...policy, environmentId: "00000000-0000-4000-8000-000000000001" },
    ]) expect(deploymentManifestSchema.safeParse({ ...manifest,
      projects: { main: { ...manifest.projects.main, fields: { name: "Main", executionWorkspacePolicy: invalid } } },
    }).success).toBe(false);
  });
  it("keeps keys independent of display names", () => {
    const parsed = deploymentManifestSchema.parse({ version: 1, owner: "deployment", companies: { example: company } });
    expect(parsed.companies.example.fields.name).toBe("Example");
  });
  it("rejects unsupported versions, fields and state restoration", () => {
    for (const input of [
      { version: 2, owner: "deployment", companies: {} },
      { version: 1, owner: "deployment", companies: {}, unknown: true },
      { version: 1, owner: "deployment", companies: { example: { fields: { name: "Example", spentMonthlyCents: 0 } } } },
    ]) expect(deploymentManifestSchema.safeParse(input).success).toBe(false);
  });
  it("rejects invalid references and reporting cycles before writes", () => {
    for (const agents of [
      { worker: { ...agent, company: "missing" } },
      { worker: { ...agent, reportsTo: "missing" } },
      { worker: { ...agent, reportsTo: "worker" } },
      { worker: { ...agent, reportsTo: "manager" }, manager: { ...agent, reportsTo: "worker" } },
    ]) expect(deploymentManifestSchema.safeParse({ version: 1, owner: "deployment", companies: { example: company }, agents }).success).toBe(false);
  });
});
