import { describe, expect, it } from "vitest";
import * as db from "./index.js";

describe("seat model schema exports", () => {
  it("exports seat foundation tables", () => {
    expect("seats" in db).toBe(true);
    expect("seatOccupancies" in db).toBe(true);
    expect("agentExecutionBindings" in db).toBe(true);
    expect("costEventSeatAttributions" in db).toBe(true);
  });

  it("exposes seat ownership columns on existing business tables", () => {
    expect("seatId" in db.agents).toBe(true);
    expect("seatRole" in db.agents).toBe(true);

    expect("ownerSeatId" in db.issues).toBe(true);
    expect("leadSeatId" in db.projects).toBe(true);
    expect("ownerSeatId" in db.goals).toBe(true);
    expect("assigneeSeatId" in db.routines).toBe(true);
  });
});
