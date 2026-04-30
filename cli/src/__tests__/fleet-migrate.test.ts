import { describe, expect, it } from "vitest";
import { fleetMigrateCommand } from "../commands/fleet-migrate.js";

describe("fleet:migrate", () => {
  it("exports the command handler", () => {
    expect(typeof fleetMigrateCommand).toBe("function");
  });
});
