import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { buildCoreMutationTools } from "../services/builder/tools/core-mutation.js";
import { buildCoreReadOnlyTools } from "../services/builder/tools/core-read.js";

describe("builder core tool catalogs", () => {
  it("includes the expanded read-only management surface", () => {
    const tools = buildCoreReadOnlyTools({} as Db);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    for (const name of [
      "list_projects",
      "get_project",
      "get_agent",
      "get_goal",
      "get_issue",
      "get_routine",
      "list_approvals",
      "get_approval",
      "list_invites",
      "list_activity",
      "list_issue_comments",
      "list_approval_comments",
      "list_agent_keys",
      "list_routine_triggers",
      "get_routine_trigger",
      "list_routine_runs",
    ]) {
      expect(byName.get(name), `${name} should exist`).toBeTruthy();
      expect(byName.get(name)?.requiresApproval).toBe(false);
    }
  });

  it("includes the expanded mutation/admin surface with the expected approval policy", () => {
    const tools = buildCoreMutationTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    for (const name of ["add_issue_comment", "add_approval_comment", "run_routine"]) {
      expect(byName.get(name), `${name} should exist`).toBeTruthy();
      expect(byName.get(name)?.requiresApproval).toBe(false);
    }

    for (const name of [
      "create_project",
      "update_project",
      "update_agent",
      "pause_agent",
      "resume_agent",
      "terminate_agent",
      "delete_agent",
      "create_invite",
      "revoke_invite",
      "approve_approval",
      "reject_approval",
      "revoke_agent_key",
      "create_routine_trigger",
      "update_routine_trigger",
      "rotate_routine_trigger_secret",
    ]) {
      expect(byName.get(name), `${name} should exist`).toBeTruthy();
      expect(byName.get(name)?.requiresApproval).toBe(true);
    }
  });
});
