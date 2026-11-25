import { describe, expect, it } from "vitest";
import { auditTransportLabel, connectionTransportLabel } from "./connection-transport-label";

describe("connection transport labels", () => {
  it("names a connection type without the raw transport value", () => {
    expect(connectionTransportLabel("mcp_remote")).toBe("Remote HTTP");
    expect(connectionTransportLabel("local_stdio")).toBe("Local command");
  });

  it("labels audit details with the same names", () => {
    expect(auditTransportLabel("mcp_remote")).toBe("Remote HTTP");
    expect(auditTransportLabel("local_stdio")).toBe("Local command");
    expect(auditTransportLabel("other")).toBe("other");
  });
});
