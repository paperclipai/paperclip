import { describe, expect, it } from "vitest";
import {
  assertPublicRemoteHttpEndpoint,
  isPrivateOrReservedIp,
  resolveApprovedRemoteHttpAddresses,
} from "../services/remote-http-endpoint-guard.js";


function guardError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

describe("remote HTTP endpoint guard", () => {
  it.each(["ENOTFOUND", "ENODATA", "EAI_AGAIN"])("retains proven DNS failure %s across the public wrapper", async (code) => {
    const failure = await assertPublicRemoteHttpEndpoint(new URL("https://missing.example.test/mcp"), {
      lookup: async () => { throw Object.assign(new Error("lookup failed"), { code }); },
    }, guardError).catch((error) => error);
    expect(failure).toMatchObject({ code: "remote_http_dns_failed" });
    expect(readRemoteConnectionFailure(failure)).toBe("dns_failure");
  });

  it("marks its exact DNS deadline without trusting unknown lookup exceptions", async () => {
    const timedOut = await assertPublicRemoteHttpEndpoint(new URL("https://silent.example.test/mcp"), {
      lookup: async () => new Promise(() => {}), dnsTimeoutMs: 1,
    }, guardError).catch((error) => error);
    expect(timedOut).toMatchObject({ code: "remote_http_dns_failed" });
    expect(readRemoteConnectionFailure(timedOut)).toBe("connection_timeout");
    const unknown = await assertPublicRemoteHttpEndpoint(new URL("https://broken.example.test/mcp"), {
      lookup: async () => { throw new TypeError("internal lookup bug: ENOTFOUND"); },
    }, guardError).catch((error) => error);
    expect(unknown).toMatchObject({ code: "remote_http_dns_failed" });
    expect(readRemoteConnectionFailure(unknown)).toBeNull();
  });

  it("blocks hostnames that resolve to private network addresses", async () => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL("https://metadata.example/mcp"),
      { lookup: async () => [{ address: "10.0.0.12", family: 4 }] },
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });

  it("allows hostnames when every resolved address is public", async () => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL("https://public.example/mcp"),
      { lookup: async () => [{ address: "93.184.216.34", family: 4 }] },
      guardError,
    )).resolves.toBeUndefined();
  });

  it.each([
    "64:ff9b::8fcc:3779",
    "64:ff9b::143.204.55.121",
    "0064:FF9B:0000:0000:0000:0000:8FCC:3779",
    "64:ff9b::808:808",
  ])("allows public IPv4 destination encoded as NAT64 %s", async (address) => {
    expect(isPrivateOrReservedIp(address)).toBe(false);
    await expect(assertPublicRemoteHttpEndpoint(
      new URL(`https://[${address}]/attachment`),
      {},
      guardError,
    )).resolves.toBeUndefined();
    await expect(resolveApprovedRemoteHttpAddresses(
      new URL("https://cdn.agentmail.to/attachment"),
      { lookup: async () => [{ address, family: 6 }] },
      guardError,
    )).resolves.toEqual([address]);
  });

  it.each([
    "64:ff9b::",
    "64:ff9b::1",
    "64:ff9b::a00:1",
    "64:ff9b::7f00:1",
    "64:ff9b::6440:1",
    "64:ff9b::ac10:1",
    "64:ff9b::c0a8:1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::c000:201",
    "64:ff9b::c612:1",
    "64:ff9b::e000:1",
    "64:ff9b::ffff:ffff",
  ])("blocks non-public IPv4 destination encoded as NAT64 %s", async (address) => {
    expect(isPrivateOrReservedIp(address)).toBe(true);
    await expect(assertPublicRemoteHttpEndpoint(
      new URL(`https://[${address}]/attachment`),
      {},
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
    await expect(assertPublicRemoteHttpEndpoint(
      new URL("https://cdn.agentmail.to/attachment"),
      { lookup: async () => [{ address, family: 6 }] },
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });

  it("rejects mixed public and private NAT64 DNS answers", async () => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL("https://cdn.agentmail.to/attachment"),
      { lookup: async () => [
        { address: "64:ff9b::8fcc:3779", family: 6 },
        { address: "64:ff9b::a00:1", family: 6 },
      ] },
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });

  it.each([
    "169.254.0.1",
    "169.254.169.254",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::169.254.169.254",
    "0064:FF9B:0000:0000:0000:0000:A9FE:A9FE",
    "fe80::1",
    "febf::1",
  ])("always rejects link-local literal %s when private networking is allowed", async (address) => {
    const url = address.includes(":") ? `http://[${address}]/mcp` : `http://${address}/mcp`;
    await expect(assertPublicRemoteHttpEndpoint(
      new URL(url),
      { allowPrivateNetwork: true },
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });

  it.each([
    "169.254.42.1",
    "fe80::1234",
    "64:ff9b::a9fe:a9fe",
    "0064:FF9B:0000:0000:0000:0000:A9FE:A9FE",
    "64:ff9b::a9fe:a9fe%eth0",
  ])(
    "always rejects link-local DNS answer %s when private networking is allowed",
    async (address) => {
      await expect(assertPublicRemoteHttpEndpoint(
        new URL("https://operator-endpoint.example/mcp"),
        { allowPrivateNetwork: true, lookup: async () => [{ address, family: address.includes(":") ? 6 : 4 }] },
        guardError,
      )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
    },
  );

  it.each(["127.0.0.1", "10.1.2.3", "fd00::1"])(
    "allows intended private address %s when private networking is allowed",
    async (address) => {
      const url = address.includes(":") ? `http://[${address}]/mcp` : `http://${address}/mcp`;
      await expect(assertPublicRemoteHttpEndpoint(
        new URL(url),
        { allowPrivateNetwork: true },
        guardError,
      )).resolves.toBeUndefined();
    },
  );

  it.each([
    "http://[2001::1]/mcp",
    "http://[2001:20::1]/mcp",
    "http://[2001:2f::1]/mcp",
    "http://[64:ff9b:1::1]/mcp",
    "http://[0064:ff9b:0001::808:808]/mcp",
  ])("rejects reserved IPv6 endpoint %s", async (url) => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL(url),
      {},
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });

  it("keeps network-specific NAT64 DNS answers blocked", async () => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL("https://cdn.agentmail.to/attachment"),
      { lookup: async () => [{ address: "0064:FF9B:0001::808:808", family: 6 }] },
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });
});
