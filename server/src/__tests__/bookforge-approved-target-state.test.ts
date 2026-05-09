import { describe, expect, it } from "vitest";
import {
  buildBookforgeApprovedTargetState,
  normalizeBookforgeApprovedTargetPolicy,
} from "../services/bookforge-approved-target-state.js";

describe("Bookforge approved target state", () => {
  it("treats the JSON file target as proposed/stale-check-needed instead of active approval", () => {
    const state = buildBookforgeApprovedTargetState({
      dbTarget: null,
      jsonFileTarget: {
        yaml: "the_widow_in_room_twelve.yaml",
        itemId: "995ead91-6865-4b34-a77b-8ffbee40f57f",
        projectName: "the_widow_in_room_twelve",
      },
      envTarget: null,
      approvedTargetFilePath: "/Users/begilhan/.paperclip/bookforge-approved-target.json",
    });

    expect(state.authority).toBe("none_read_only");
    expect(state.status).toBe("proposed_stale_check_needed");
    expect(state.activeTarget).toBeNull();
    expect(state.candidateTarget).toMatchObject({
      source: "json_file",
      yaml: "the_widow_in_room_twelve.yaml",
      itemId: "995ead91-6865-4b34-a77b-8ffbee40f57f",
      projectName: "the_widow_in_room_twelve",
    });
    expect(state.stopConditions).toContain("no_active_first_class_approved_target");
    expect(state.warnings).toContain("json_file_is_not_production_approval");
  });

  it("surfaces stale config conflict when env/instruction target disagrees with the JSON candidate", () => {
    const state = buildBookforgeApprovedTargetState({
      dbTarget: null,
      jsonFileTarget: {
        yaml: "the_widow_in_room_twelve.yaml",
        itemId: "995ead91-6865-4b34-a77b-8ffbee40f57f",
        projectName: "the_widow_in_room_twelve",
      },
      envTarget: {
        yaml: "the_last_safe_lie.yaml",
        itemId: null,
        projectName: "the_last_safe_lie",
      },
      approvedTargetFilePath: "/Users/begilhan/.paperclip/bookforge-approved-target.json",
    });

    expect(state.status).toBe("mismatch_blocked");
    expect(state.warnings).toContain("json_env_target_conflict");
    expect(state.stopConditions).toEqual(expect.arrayContaining([
      "no_active_first_class_approved_target",
      "stale_target_config_conflict",
    ]));
    expect(state.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "yaml",
        jsonFileValue: "the_widow_in_room_twelve.yaml",
        envValue: "the_last_safe_lie.yaml",
      }),
    ]));
  });

  it("reports a DB active target as authoritative while still warning about stale file conflicts", () => {
    const state = buildBookforgeApprovedTargetState({
      dbTarget: {
        id: "target-1",
        status: "active",
        yaml: "the_last_safe_lie.yaml",
        itemId: "item-last-safe-lie",
        projectName: "the_last_safe_lie",
        source: "db",
        approvedAt: "2026-05-08T08:00:00.000Z",
        expiresAt: "2026-05-09T08:00:00.000Z",
        approvalIssueId: "BOO-100",
        approvalCommentId: "comment-1",
      },
      jsonFileTarget: {
        yaml: "the_widow_in_room_twelve.yaml",
        itemId: "995ead91-6865-4b34-a77b-8ffbee40f57f",
        projectName: "the_widow_in_room_twelve",
      },
      envTarget: null,
      approvedTargetFilePath: "/Users/begilhan/.paperclip/bookforge-approved-target.json",
    });

    expect(state.authority).toBe("db");
    expect(state.status).toBe("active_with_stale_config_warning");
    expect(state.activeTarget).toMatchObject({
      source: "db",
      yaml: "the_last_safe_lie.yaml",
      itemId: "item-last-safe-lie",
    });
    expect(state.warnings).toContain("db_json_target_conflict");
    expect(state.stopConditions).toContain("stale_target_config_conflict");
  });

  it("normalizes blank target fields to null", () => {
    expect(normalizeBookforgeApprovedTargetPolicy({ yaml: " ", itemId: "item", projectName: "" })).toEqual({
      yaml: null,
      itemId: "item",
      projectName: null,
    });
  });
});
