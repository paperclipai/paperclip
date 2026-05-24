import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, {
  BRIEFING_ANALYST_AGENT_KEY,
  BRIEFS_MANAGED_ROUTINE_KEYS,
  BRIEFS_MANAGED_SKILL_CANONICAL_KEYS,
  BRIEFS_MANAGED_SKILL_KEYS,
  BRIEFS_PROJECT_KEY,
  MANUAL_REFRESH_ROUTINE_KEY,
} from "../src/manifest.js";
import plugin from "../src/worker.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const bridgeActor = {
  actorType: "user" as const,
  actorId: "signed-in-user",
  userId: "signed-in-user",
  agentId: null,
  runId: null,
  source: "session",
};

describe("Briefs managed resources", () => {
  it("declares the Briefing Analyst, skills, routines, and agent tools", () => {
    expect(manifest.capabilities).toEqual(expect.arrayContaining([
      "projects.managed",
      "agents.resume",
      "agents.managed",
      "skills.managed",
      "routines.managed",
      "agent.tools.register",
    ]));
    expect(manifest.agents?.[0]).toMatchObject({
      agentKey: BRIEFING_ANALYST_AGENT_KEY,
      displayName: "Briefing Analyst",
      status: "paused",
      capabilities: expect.stringContaining("writes grounded card titles and descriptions"),
      budgetMonthlyCents: 500,
      adapterConfig: {
        dangerouslyBypassApprovalsAndSandbox: true,
        extraArgs: ["--skip-git-repo-check"],
        paperclipSkillSync: {
          desiredSkills: BRIEFS_MANAGED_SKILL_CANONICAL_KEYS,
        },
      },
      permissions: {
        pluginTools: [manifest.id],
      },
    });
    expect(manifest.agents?.[0]?.instructions?.content).toContain("You are the LLM that generates Briefing card titles and descriptions");
    expect(manifest.agents?.[0]?.instructions?.content).toContain('summaryModel: "agent-generated"');
    expect(manifest.agents?.[0]?.instructions?.content).toContain("executive standup updates");
    expect(manifest.agents?.[0]?.instructions?.content).toContain("Do not put issue identifiers");
    expect(manifest.agents?.[0]?.instructions?.content).toContain("focus more on what is left to do");
    expect(manifest.agents?.[0]?.instructions?.content).toContain("Dismissed cards are intentional user feedback");
    expect(manifest.skills?.find((skill) => skill.skillKey === "briefs-discover-cards")?.markdown).toContain("includeHidden: true");
    expect(manifest.skills?.find((skill) => skill.skillKey === "briefs-update-cards")?.markdown).toContain("refresh every visible card");
    expect(manifest.skills?.find((skill) => skill.skillKey === "briefs-update-cards")?.markdown).toContain("Hidden cards were dismissed by the user");
    expect(manifest.routines?.find((routine) => routine.routineKey === "briefs-discover-cards")?.description).toContain("skip hidden/dismissed roots");
    expect(manifest.routines?.find((routine) => routine.routineKey === "briefs-update-cards")?.description).toContain("manual/API runs are rewrite passes");
    expect(manifest.skills?.map((skill) => skill.skillKey)).toEqual([...BRIEFS_MANAGED_SKILL_KEYS]);
    expect(manifest.projects).toEqual([
      expect.objectContaining({
        projectKey: BRIEFS_PROJECT_KEY,
        displayName: "Briefs",
        status: "in_progress",
      }),
    ]);
    expect(manifest.routines?.map((routine) => routine.routineKey)).toEqual([...BRIEFS_MANAGED_ROUTINE_KEYS]);
    expect(manifest.routines?.every((routine) =>
      routine.projectRef?.resourceKind === "project"
      && routine.projectRef.resourceKey === BRIEFS_PROJECT_KEY
    )).toBe(true);
    expect(manifest.routines?.find((routine) => routine.routineKey === MANUAL_REFRESH_ROUTINE_KEY)).toMatchObject({
      assigneeRef: { resourceKind: "agent", resourceKey: BRIEFING_ANALYST_AGENT_KEY },
      projectRef: { resourceKind: "project", resourceKey: BRIEFS_PROJECT_KEY },
      issueTemplate: {
        surfaceVisibility: "plugin_operation",
        billingCode: "plugin-briefs:manual-refresh",
      },
    });
    expect(manifest.tools?.map((tool) => tool.name)).toEqual([
      "briefs_list_cards",
      "briefs_save_card",
      "briefs_refresh_issue_tree",
    ]);
    expect(manifest.tools?.find((tool) => tool.name === "briefs_refresh_issue_tree")?.description).toContain("inspect deterministic rows");
    expect(manifest.ui?.slots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "sidebar",
        displayName: "Briefing",
        exportName: "SidebarLink",
      }),
      expect.objectContaining({
        type: "page",
        displayName: "Briefing",
        routePath: "briefs",
        exportName: "BriefingPage",
      }),
      expect.objectContaining({
        type: "settingsPage",
        displayName: "Briefing",
        exportName: "SettingsPage",
      }),
    ]));
  });

  it("can reset the managed analyst when declared instructions change", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup?.(harness.ctx);
    await harness.performAction("reconcile-managed-resources", { companyId });

    const result = await harness.performAction<{ status: string; agentId: string | null }>(
      "reset-managed-agent",
      { companyId },
    );

    expect(result).toMatchObject({ status: "reset" });
    expect(result.agentId).toBeTruthy();
  });

  it("can reset managed skills and routines when declared defaults change", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup?.(harness.ctx);
    await harness.performAction("reconcile-managed-resources", { companyId });

    const skills = await harness.performAction<{ managedSkills: Array<{ status: string; skillId: string | null }> }>(
      "reset-managed-skills",
      { companyId },
    );
    const routine = await harness.performAction<{ status: string; routineId: string | null }>(
      "reset-managed-routine",
      { companyId, routineKey: MANUAL_REFRESH_ROUTINE_KEY },
    );

    expect(skills.managedSkills.map((skill) => skill.status)).toEqual(["reset", "reset"]);
    expect(skills.managedSkills.every((skill) => skill.skillId)).toBe(true);
    expect(routine).toMatchObject({ status: "reset" });
    expect(routine.routineId).toBeTruthy();
  });

  it("reconciles resources in dependency order so routines resolve their managed refs", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup?.(harness.ctx);

    const result = await harness.performAction<{
      managedProject: { status: string; projectId: string | null };
      managedAgent: { status: string; agentId: string | null };
      managedSkills: Array<{ status: string; skillId: string | null }>;
      managedRoutines: Array<{ status: string; routineId: string | null; routine: { projectId: string | null } | null; missingRefs: unknown[] }>;
    }>("reconcile-managed-resources", { companyId });

    expect(result.managedProject).toMatchObject({ status: "created" });
    expect(result.managedAgent).toMatchObject({ status: "created" });
    expect(result.managedSkills.map((skill) => skill.status)).toEqual(["created", "created"]);
    expect(result.managedRoutines).toHaveLength(3);
    for (const routine of result.managedRoutines) {
      expect(routine.status).toBe("created");
      expect(routine.routineId).toBeTruthy();
      expect(routine.routine?.projectId).toBe(result.managedProject.projectId);
      expect(routine.missingRefs).toEqual([]);
    }
  });

  it("reconciles managed routines through the plugin-managed project from settings", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup?.(harness.ctx);

    const result = await harness.performAction<{
      managedProject: { status: string; projectId: string | null };
      managedAgent: { status: string; agentId: string | null };
      managedRoutines: Array<{ status: string; routineId: string | null; routine: { projectId: string | null } | null; missingRefs: unknown[] }>;
    }>("reconcile-managed-routines", { companyId });

    expect(result.managedProject).toMatchObject({ status: "created" });
    expect(result.managedProject.projectId).toBeTruthy();
    expect(result.managedAgent.agentId).toBeTruthy();
    expect(result.managedRoutines).toHaveLength(3);
    for (const routine of result.managedRoutines) {
      expect(routine.status).toBe("created");
      expect(routine.routine?.projectId).toBe(result.managedProject.projectId);
      expect(routine.missingRefs).toEqual([]);
    }
  });

  it("ignores caller-supplied project overrides when repairing Briefs routines", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup?.(harness.ctx);

    const routine = await harness.performAction<{
      status: string;
      routineId: string | null;
      routine: { projectId: string | null } | null;
      missingRefs: unknown[];
    }>("reconcile-managed-routine", {
      companyId,
      routineKey: MANUAL_REFRESH_ROUTINE_KEY,
      projectId: "operator-selected-project",
    });
    const managedProject = await harness.ctx.projects.managed.get(BRIEFS_PROJECT_KEY, companyId);

    expect(routine.status).toBe("created");
    expect(routine.routineId).toBeTruthy();
    expect(routine.routine?.projectId).toBe(managedProject.projectId);
    expect(routine.routine?.projectId).not.toBe("operator-selected-project");
    expect(routine.missingRefs).toEqual([]);
  });

  it("repairs legacy Briefs routines that are not linked to the plugin-managed project", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup?.(harness.ctx);
    const managedProject = await harness.ctx.projects.managed.reconcile(BRIEFS_PROJECT_KEY, companyId);
    const managedAgent = await harness.ctx.agents.managed.reconcile(BRIEFING_ANALYST_AGENT_KEY, companyId);
    const legacy = await harness.ctx.routines.managed.reconcile(MANUAL_REFRESH_ROUTINE_KEY, companyId, {
      assigneeAgentId: managedAgent.agentId,
      projectId: "legacy-project",
    });
    expect(legacy.routine?.projectId).toBe("legacy-project");

    const result = await harness.performAction<{
      managedRoutines: Array<{ status: string; resourceKey: string; routine: { projectId: string | null } | null }>;
    }>("reconcile-managed-resources", { companyId });
    const repaired = result.managedRoutines.find((routine) => routine.resourceKey === MANUAL_REFRESH_ROUTINE_KEY);

    expect(repaired?.status).toBe("reset");
    expect(repaired?.routine?.projectId).toBe(managedProject.projectId);
  });

  it("resumes the managed analyst before running user briefing routines", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup?.(harness.ctx);
    await harness.performAction("reconcile-managed-resources", { companyId });

    const before = await harness.ctx.agents.managed.get(BRIEFING_ANALYST_AGENT_KEY, companyId);
    expect(before.agent?.status).toBe("paused");

    const managedProject = await harness.ctx.projects.managed.get(BRIEFS_PROJECT_KEY, companyId);
    const result = await harness.performAction<{
      runs: Array<{ status: string; triggerPayload: { variables: Record<string, unknown> } | null }>;
    }>("run-briefing-routines", { companyId, projectId: "operator-selected-project" }, { actor: bridgeActor });

    const after = await harness.ctx.agents.managed.get(BRIEFING_ANALYST_AGENT_KEY, companyId);
    expect(after.agent?.status).toBe("idle");
    for (const routineKey of BRIEFS_MANAGED_ROUTINE_KEYS.filter((routineKey) => routineKey !== MANUAL_REFRESH_ROUTINE_KEY)) {
      const routine = await harness.ctx.routines.managed.get(routineKey, companyId);
      expect(routine.routine?.projectId).toBe(managedProject.projectId);
      expect(routine.routine?.projectId).not.toBe("operator-selected-project");
    }
    expect(result.runs).toHaveLength(2);
    expect(result.runs.map((run) => run.status)).toEqual(["queued", "queued"]);
    expect(result.runs.map((run) => run.triggerPayload?.variables?.userId)).toEqual([
      "signed-in-user",
      "signed-in-user",
    ]);
  });

  it("rejects user-scoped UI bridge calls for a different user", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup?.(harness.ctx);
    const victimParams = { companyId, userId: "victim-user" };
    const context = { actor: bridgeActor };

    await expect(harness.getData("page", victimParams, context)).rejects.toThrow("Briefs user scope mismatch");
    await expect(harness.getData("preferences", victimParams, context)).rejects.toThrow("Briefs user scope mismatch");
    await expect(harness.performAction("pin-card", {
      ...victimParams,
      cardId: "card-1",
      pinned: true,
    }, context)).rejects.toThrow("Briefs user scope mismatch");
    await expect(harness.performAction("dismiss-card", {
      ...victimParams,
      cardId: "card-1",
    }, context)).rejects.toThrow("Briefs user scope mismatch");
    await expect(harness.performAction("update-preferences", {
      ...victimParams,
      cadence: "daily",
    }, context)).rejects.toThrow("Briefs user scope mismatch");
    await expect(harness.performAction("run-managed-routine", {
      companyId,
      routineKey: BRIEFS_MANAGED_ROUTINE_KEYS[0],
      variables: { userId: "victim-user" },
    }, context)).rejects.toThrow("Briefs user scope mismatch");
    await expect(harness.performAction("save-deterministic-card", {
      bundle: { userId: "victim-user" },
    }, context)).rejects.toThrow("Briefs user scope mismatch");
    await expect(harness.performAction("refresh-issue-tree", {
      companyId,
      userId: "victim-user",
      rootIssueId: "issue-1",
    }, context)).rejects.toThrow("Briefs user scope mismatch");
  });

});
