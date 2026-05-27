import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentMemberships,
  agents,
  activityLog,
  coachDecisions,
  companies,
  companyMemberships,
  environments,
  createDb,
  goals,
  issues,
  opcBlueprints,
  projectGoals,
  projectWorkspaces,
  projects,
  proposalArtifacts,
  principalPermissionGrants,
  routineTriggers,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { opcService } from "../services/opc.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres OPC service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("opcService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let svc!: ReturnType<typeof opcService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-opc-service-");
    db = createDb(tempDb.connectionString);
    svc = opcService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(agentMemberships);
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projectGoals);
    await db.delete(projects);
    await db.delete(opcBlueprints);
    await db.delete(coachDecisions);
    await db.delete(proposalArtifacts);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("creates a proposal artifact and draft blueprint from pasted text", async () => {
    const result = await svc.createProposal(
      {
        sourceType: "paste",
        text: "# FocusFlow\nBuild an AI workflow coach for solo consultants. MVP should launch quickly.",
      },
      { userId: "user-1" },
    );

    expect(result.proposal.extractedText).toContain("FocusFlow");
    expect(result.blueprint.summary).toContain("Build an AI workflow coach");
    expect(result.blueprint.agentPlan).toHaveLength(7);
    expect(result.blueprint.issuePlan.length).toBeGreaterThan(0);
    expect(result.blueprint.routinePlan.length).toBeGreaterThan(0);
  });

  it("decodes text uploads and rejects opaque binary uploads without extracted text", async () => {
    const txt = Buffer.from("Uploaded proposal for a customer feedback assistant.").toString("base64");
    const result = await svc.createProposal(
      {
        sourceType: "txt",
        filename: "proposal.txt",
        fileContentBase64: txt,
      },
      { userId: "user-1" },
    );

    expect(result.proposal.filename).toBe("proposal.txt");
    expect(result.proposal.extractedText).toContain("Uploaded proposal");

    await expect(
      svc.createProposal(
        {
          sourceType: "pdf",
          filename: "proposal.pdf",
          fileContentBase64: Buffer.from("%PDF-1.7").toString("base64"),
        },
        { userId: "user-1" },
      ),
    ).rejects.toThrow(/binary extraction requires a document parser/i);
  });

  it("uses a current project path or link as intake context", async () => {
    const result = await svc.createProposal(
      {
        sourceType: "paste",
        text: "Need advice on the launch quality and next product direction.",
        projectPath: "/Users/match/work/syncbuddy",
        projectLink: "https://github.com/example/syncbuddy",
        projectMode: "take_charge",
      },
      { userId: "user-1" },
    );

    expect(result.proposal.extractedText).toContain("Project path: /Users/match/work/syncbuddy");
    expect(result.proposal.extractedText).toContain("Mode: take_charge");
    expect(result.blueprint.summary).toContain("Existing project:");
    expect(result.blueprint.architectureNotes).toContain("Take-charge mode");
    expect(result.blueprint.issuePlan.map((issue) => issue.title)).toContain("Audit current project state and repo risks");
  });

  it("requires blueprint approval before creating a company", async () => {
    const result = await svc.createProposal(
      {
        sourceType: "paste",
        text: "Build LaunchDesk for one-person SaaS founders who need weekly operating reviews.",
      },
      { userId: "user-1" },
    );

    await expect(
      svc.createCompany(result.proposal.id, { adapterType: "process", adapterConfig: {} }, { userId: "user-1" }),
    ).rejects.toThrow(/Approve the OPC blueprint/i);
  });

  it("creates company, agents, issues, routines, and blocks duplicate creation", async () => {
    const result = await svc.createProposal(
      {
        sourceType: "paste",
        text: "Build BugPilot for indie app builders. The product detects release blockers and summarizes QA risk.",
      },
      { userId: "user-1" },
    );
    await svc.approveBlueprint(result.proposal.id, { userId: "user-1" });

    const created = await svc.createCompany(
      result.proposal.id,
      {
        name: "BugPilot OPC",
        adapterType: "process",
        adapterConfig: { command: "echo", args: ["noop"] },
      },
      { userId: "user-1" },
    );
    const repeated = await svc.createCompany(
      result.proposal.id,
      {
        name: "BugPilot OPC",
        adapterType: "process",
        adapterConfig: { command: "echo", args: ["noop"] },
      },
      { userId: "user-1" },
    );

    expect(created.company.name).toBe("BugPilot OPC");
    expect(created.agents).toHaveLength(7);
    expect(created.goals).toHaveLength(1);
    expect(created.issues.length).toBeGreaterThanOrEqual(6);
    expect(created.routines).toHaveLength(5);
    expect(repeated.company.id).toBe(created.company.id);

    const companyRows = await db.select().from(companies);
    expect(companyRows).toHaveLength(1);
  });

  it("creates a Paperclip project workspace for take-charge current projects", async () => {
    const result = await svc.createProposal(
      {
        sourceType: "paste",
        text: "Improve SyncBuddy reliability and launch operations.",
        projectPath: "/Users/match/work/syncbuddy",
        projectMode: "take_charge",
      },
      { userId: "user-1" },
    );
    await svc.approveBlueprint(result.proposal.id, { userId: "user-1" });

    const created = await svc.createCompany(
      result.proposal.id,
      {
        name: "SyncBuddy OPC",
        adapterType: "process",
        adapterConfig: { command: "echo", args: ["noop"] },
      },
      { userId: "user-1" },
    );

    const [project] = await db.select().from(projects);
    const [workspace] = await db.select().from(projectWorkspaces);
    const issueRows = await db.select().from(issues);
    const routineRows = await db.select().from(routines);
    const agentRows = await db.select().from(agents);

    expect(project?.name).toBe("Syncbuddy");
    expect(workspace).toMatchObject({
      projectId: project.id,
      sourceType: "local_path",
      cwd: "/Users/match/work/syncbuddy",
      isPrimary: true,
    });
    expect(issueRows.every((issue) => issue.projectId === project.id)).toBe(true);
    expect(routineRows.every((routine) => routine.projectId === project.id)).toBe(true);
    expect(agentRows.every((agent) => (agent.adapterConfig as Record<string, unknown>).cwd === "/Users/match/work/syncbuddy")).toBe(true);
    expect(created.issues.map((issue) => issue.title)).toContain("Audit current project state and repo risks");
  });
});
