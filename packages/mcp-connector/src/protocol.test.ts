import {
  MCP_CONNECTOR_CREDENTIAL_PREFIX,
  parseMcpConnectorClientFrame,
  parseMcpConnectorServerFrame,
  parseMcpConnectorToken,
} from "@paperclipai/shared/mcp-connector-protocol";
import { describe, expect, it } from "vitest";

describe("connector protocol", () => {
  it("refuses request frames that name a URL instead of an upstream", () => {
    for (const upstream of ["http://169.254.169.254/", "unifi/../x", "UNIFI", "", "a".repeat(80)]) {
      expect(parseMcpConnectorServerFrame(JSON.stringify({
        type: "request", id: "1", upstream, method: "POST", headers: {}, body: null, rpcId: null, timeoutMs: 1000,
      }))).toBeNull();
    }
    expect(parseMcpConnectorServerFrame(JSON.stringify({
      type: "request", id: "1", upstream: "unifi", method: "GET", headers: {}, body: null,
    }))).toBeNull();
  });

  it("clamps timeouts and validates hello frames", () => {
    const parsed = parseMcpConnectorServerFrame(JSON.stringify({
      type: "request", id: "1", upstream: "unifi", method: "POST", headers: {}, body: "{}", rpcId: 1, timeoutMs: 10 ** 9,
    }));
    expect(parsed).toMatchObject({ timeoutMs: 600_000 });
    expect(parseMcpConnectorClientFrame(JSON.stringify({ type: "hello", protocolVersion: 1, version: "0.1.0", upstreams: ["b", "a", "a"] })))
      .toEqual({ type: "hello", protocolVersion: 1, version: "0.1.0", upstreams: ["a", "b"] });
    expect(parseMcpConnectorClientFrame(JSON.stringify({ type: "hello", protocolVersion: 1, version: "x", upstreams: ["http://x"] }))).toBeNull();
    expect(parseMcpConnectorClientFrame("not json")).toBeNull();
  });

  it("parses tokens strictly", () => {
    const id = "3f2f11ed-b349-4412-b647-151c35ba79d6";
    expect(parseMcpConnectorToken(`${MCP_CONNECTOR_CREDENTIAL_PREFIX}${id}.${"a".repeat(43)}`, MCP_CONNECTOR_CREDENTIAL_PREFIX))
      .toEqual({ connectorId: id, secret: "a".repeat(43) });
    expect(parseMcpConnectorToken(`pcmce_${id}.${"a".repeat(43)}`, MCP_CONNECTOR_CREDENTIAL_PREFIX)).toBeNull();
    expect(parseMcpConnectorToken(`${MCP_CONNECTOR_CREDENTIAL_PREFIX}${id}.short`, MCP_CONNECTOR_CREDENTIAL_PREFIX)).toBeNull();
  });
});
