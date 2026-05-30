import { describe, expect, it } from "vitest";
import { getAdapterDisplay } from "../adapters/adapter-display-registry";
import { isAgentAdapterType } from "./NewAgentDialog";

describe("NewAgentDialog adapter picker filtering", () => {
  it("keeps process hidden while allowing HTTP Webhook as an operator-selectable adapter", () => {
    expect(isAgentAdapterType("process")).toBe(false);
    expect(isAgentAdapterType("http")).toBe(true);

    const httpDisplay = getAdapterDisplay("http");
    expect(httpDisplay.label).toBe("HTTP Webhook");
    expect(httpDisplay.description).toBe("Remote HTTP webhook adapter (bridges, external services)");
    expect(httpDisplay.comingSoon).toBeUndefined();
  });
});
