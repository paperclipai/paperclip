import { describe, expect, it } from "vitest";
import { projectService } from "../services/projects.js";

// Regression for PAPERCLIP-BACKEND-8G: unresolved project shortnames reaching
// getById must be treated as "not found" instead of hitting the uuid column.
describe("projectService.getById with non-UUID ids", () => {
  it("returns null without querying the database", async () => {
    let queried = false;
    const db = new Proxy({}, {
      get() {
        queried = true;
        throw new Error("database should not be queried for non-UUID ids");
      },
    });
    const svc = projectService(db as never);
    await expect(svc.getById("paperclip-app")).resolves.toBeNull();
    expect(queried).toBe(false);
  });
});
