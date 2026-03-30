// @vitest-environment node

import { describe, expect, it } from "vitest";
import { createValuesForAdapterType } from "./NewAgent";

describe("NewAgent runtime profile defaults", () => {
  it("seeds CrewAI defaults for http adapter create flow", () => {
    const values = createValuesForAdapterType("http");
    expect(values.adapterType).toBe("http");
    expect(values.httpRuntimeProfile).toBe("http+crewai");
    expect(values.httpRuntimeHeader).toBe("CrewAI");
    expect(values.url).toBe("http://127.0.0.1:8000/webhook");
    expect(values.heartbeatEnabled).toBe(true);
  });
});
