import { expect, it } from "vitest";
import { searchRunnerApi } from "../services/native-runtime/runner-api-catalog.js";

it.each(["archive project update project", "unarchive restore project"])("search %j says where a person restores an archived project", query => {
  const operation = searchRunnerApi({ query, limit: 10 }).results.find(row => row.operationId === "PATCH /api/projects/{id}");
  expect(operation, query).toBeDefined();
  const description = operation!.description;
  expect(description).toContain("keeps the project, its tasks and their history");
  expect(description).toContain("Restoring sets archivedAt to null");
  expect(description).toContain("/<prefix>/projects/<projectId>/configuration, with the Unarchive button");
  expect(description).toContain("not restored from the company Status page");
});
