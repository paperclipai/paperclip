import { describe, expect, it } from "bun:test";
import { unauthorized } from "../errors.js";
import type { HttpActor } from "./actor-context.js";
import { createCredentialBridge } from "./credential-bridge.js";

describe("HTTP credential bridge", () => {
  it("passes the web request to the injected credential resolver", async () => {
    const request = new Request("http://localhost/api/companies", {
      headers: { authorization: "Bearer test" },
    });
    const actor: HttpActor = {
      type: "agent",
      source: "agent_key",
      agentId: "agent-1",
      companyId: "company-a",
    };
    let received: Request | undefined;

    const bridge = createCredentialBridge(async (candidate) => {
      received = candidate;
      return actor;
    });

    await expect(bridge.resolve(request)).resolves.toBe(actor);
    expect(received).toBe(request);
  });

  it("fails closed when credentials do not resolve an actor", async () => {
    const bridge = createCredentialBridge(async () => null);

    await expect(bridge.resolve(new Request("http://localhost/api/companies"))).rejects.toMatchObject({
      status: 401,
      message: "Unauthorized",
    });
  });

  it("propagates resolver errors without replacing them", async () => {
    const error = unauthorized("Invalid credentials");
    const bridge = createCredentialBridge(async () => {
      throw error;
    });

    await expect(bridge.resolve(new Request("http://localhost/api/companies"))).rejects.toBe(error);
  });
});
