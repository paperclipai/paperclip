import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import { buildPaperclipEnv } from "./server-utils.js";

const agent = { id: "agent-1", companyId: "company-1" };

describe("buildPaperclipEnv", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("defaults to localhost when no HOST is set", () => {
    delete process.env.HOST;
    delete process.env.PAPERCLIP_LISTEN_HOST;
    delete process.env.PAPERCLIP_API_URL;
    const env = buildPaperclipEnv(agent);
    expect(env.PAPERCLIP_API_URL).toBe("http://localhost:3100");
  });

  it("uses os.hostname() when HOST is 0.0.0.0 (wildcard bind)", () => {
    delete process.env.PAPERCLIP_LISTEN_HOST;
    delete process.env.PAPERCLIP_API_URL;
    process.env.HOST = "0.0.0.0";
    const env = buildPaperclipEnv(agent);
    expect(env.PAPERCLIP_API_URL).toBe(`http://${os.hostname()}:3100`);
    expect(env.PAPERCLIP_API_URL).not.toContain("localhost");
  });

  it("uses os.hostname() when HOST is :: (IPv6 wildcard)", () => {
    delete process.env.PAPERCLIP_LISTEN_HOST;
    delete process.env.PAPERCLIP_API_URL;
    process.env.HOST = "::";
    const env = buildPaperclipEnv(agent);
    expect(env.PAPERCLIP_API_URL).toBe(`http://${os.hostname()}:3100`);
  });

  it("respects explicit PAPERCLIP_API_URL over HOST", () => {
    process.env.HOST = "0.0.0.0";
    process.env.PAPERCLIP_API_URL = "http://100.64.1.2:3100";
    const env = buildPaperclipEnv(agent);
    expect(env.PAPERCLIP_API_URL).toBe("http://100.64.1.2:3100");
  });

  it("respects PAPERCLIP_LISTEN_HOST over HOST", () => {
    delete process.env.PAPERCLIP_API_URL;
    process.env.HOST = "0.0.0.0";
    process.env.PAPERCLIP_LISTEN_HOST = "192.168.1.50";
    const env = buildPaperclipEnv(agent);
    expect(env.PAPERCLIP_API_URL).toBe("http://192.168.1.50:3100");
  });

  it("uses custom port from PAPERCLIP_LISTEN_PORT", () => {
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_LISTEN_HOST;
    process.env.HOST = "my-machine";
    process.env.PAPERCLIP_LISTEN_PORT = "4200";
    const env = buildPaperclipEnv(agent);
    expect(env.PAPERCLIP_API_URL).toBe("http://my-machine:4200");
  });

  it("wraps bare IPv6 addresses in brackets", () => {
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_LISTEN_HOST;
    process.env.HOST = "fd12:3456:789a::1";
    const env = buildPaperclipEnv(agent);
    expect(env.PAPERCLIP_API_URL).toBe("http://[fd12:3456:789a::1]:3100");
  });

  it("always sets PAPERCLIP_AGENT_ID and PAPERCLIP_COMPANY_ID", () => {
    const env = buildPaperclipEnv(agent);
    expect(env.PAPERCLIP_AGENT_ID).toBe("agent-1");
    expect(env.PAPERCLIP_COMPANY_ID).toBe("company-1");
  });
});
