import { expect, it } from "vitest";
import { buildOpenApiDocument } from "../routes/openapi.js";
import { searchRunnerApi } from "../services/native-runtime/runner-api-catalog.js";

// An agent asked to back up and verify a restore cannot do either. Its API search must give it the real operator
// paths, so it does not invent a backup page: the retention setting, the CLI, and restore into a separate database.
it.each(["backup instance restore snapshot", "database backups list restore"])("search %j describes the real backup and restore paths", query => {
  const operation = searchRunnerApi({ query, limit: 10 }).results.find(row => row.operationId === "POST /api/instance/database-backups");
  expect(operation, query).toBeDefined();
  const description = operation!.description;
  expect(description).toContain("agent credentials receive 403");
  expect(description).toContain("The web UI has no control that creates or restores a backup");
  expect(description).toContain("Backup retention section of the company-prefixed /company/settings page");
  expect(description).toContain("paperclipai db:backup");
  expect(description).toContain("separate, empty PostgreSQL database, never over the live one");
});

// The route answers a successful manual backup with 201. This guards the published document, which agents and
// clients read; the registration and the CREATED_OPERATIONS fixup in openapi.ts both supply that 201.
it("publishes the status the backup route returns on success", () => {
  const responses = buildOpenApiDocument().paths["/api/instance/database-backups"].post.responses;
  expect(Object.keys(responses)).toContain("201");
  expect(Object.keys(responses)).not.toContain("200");
});
