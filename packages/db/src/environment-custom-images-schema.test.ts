import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { environmentCustomImageSetupSessions } from "./schema/environment_custom_image_setup_sessions.js";
import { environmentCustomImageTemplates } from "./schema/environment_custom_image_templates.js";

function indexColumns(table: Parameters<typeof getTableConfig>[0], indexName: string): string[] {
  const index = getTableConfig(table).indexes.find((candidate) => candidate.config.name === indexName);
  if (!index) return [];
  return index.config.columns.map((column) => (column as { name: string }).name);
}

function indexWhere(table: Parameters<typeof getTableConfig>[0], indexName: string): unknown {
  return getTableConfig(table).indexes.find((candidate) => candidate.config.name === indexName)?.config.where;
}

describe("environment customImage schema", () => {
  it("scopes template lookup and active uniqueness by environment", () => {
    expect(indexColumns(
      environmentCustomImageTemplates,
      "environment_custom_image_templates_environment_status_idx",
    )).toEqual(["environment_id", "status"]);
    expect(indexColumns(
      environmentCustomImageTemplates,
      "environment_custom_image_templates_environment_active_uq",
    )).toEqual(["environment_id"]);
    expect(indexWhere(
      environmentCustomImageTemplates,
      "environment_custom_image_templates_environment_active_uq",
    )).toBeDefined();
  });

  it("scopes setup-session lookup and active uniqueness by environment", () => {
    expect(indexColumns(
      environmentCustomImageSetupSessions,
      "environment_custom_image_setup_sessions_environment_status_idx",
    )).toEqual(["environment_id", "status"]);
    expect(indexColumns(
      environmentCustomImageSetupSessions,
      "environment_custom_image_setup_sessions_environment_active_uq",
    )).toEqual(["environment_id"]);
    expect(indexWhere(
      environmentCustomImageSetupSessions,
      "environment_custom_image_setup_sessions_environment_active_uq",
    )).toBeDefined();
  });
});
