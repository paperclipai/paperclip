import { describe, expect, it } from "vitest";
import {
  EnvironmentCustomImageTerminalConnectionRegistry,
  EnvironmentCustomImageTerminalSessionStore,
  parseCustomImageSetupSshCommand,
  validateCustomImageSetupSshPayload,
} from "./environment-custom-image-terminal-sessions.js";

describe("parseCustomImageSetupSshCommand", () => {
  it("parses supported SSH command shapes", () => {
    expect(parseCustomImageSetupSshCommand("ssh user@example.test")).toEqual({
      username: "user",
      host: "example.test",
      port: 22,
    });
    expect(parseCustomImageSetupSshCommand("ssh user@example.test -p 2222")).toEqual({
      username: "user",
      host: "example.test",
      port: 2222,
    });
    expect(parseCustomImageSetupSshCommand("ssh -p 2200 user@example.test")).toEqual({
      username: "user",
      host: "example.test",
      port: 2200,
    });
  });

  it("parses the redacted Daytona createSshAccess command shape", () => {
    expect(parseCustomImageSetupSshCommand("ssh dtca_redacted-token.123@ssh.app.daytona.io")).toEqual({
      username: "dtca_redacted-token.123",
      host: "ssh.app.daytona.io",
      port: 22,
    });
  });

  it("rejects unsupported or ambiguous SSH command shapes", () => {
    expect(parseCustomImageSetupSshCommand("scp user@example.test")).toBeNull();
    expect(parseCustomImageSetupSshCommand("ssh user@example.test -i key")).toBeNull();
    expect(parseCustomImageSetupSshCommand("ssh user@example.test:2222")).toBeNull();
    expect(parseCustomImageSetupSshCommand("ssh -p not-a-port user@example.test")).toBeNull();
    expect(parseCustomImageSetupSshCommand("ssh -p 70000 user@example.test")).toBeNull();
    expect(parseCustomImageSetupSshCommand("ssh user@@example.test")).toBeNull();
  });
});

describe("validateCustomImageSetupSshPayload", () => {
  it("returns parsed SSH connection details and a valid payload expiry", () => {
    const result = validateCustomImageSetupSshPayload({
      type: "ssh",
      command: "ssh dtca_redacted-token.123@ssh.app.daytona.io",
      expiresAt: "2026-06-25T20:15:00.000Z",
    }, new Date("2026-06-25T20:00:00.000Z"));

    expect(result).toEqual({
      ok: true,
      ssh: {
        username: "dtca_redacted-token.123",
        host: "ssh.app.daytona.io",
        port: 22,
      },
      connectionExpiresAt: new Date("2026-06-25T20:15:00.000Z"),
    });
  });

  it("returns redacted fallback failures for unsupported payloads and parser failures", () => {
    expect(validateCustomImageSetupSshPayload({
      type: "browser_terminal",
      command: "ssh secret-token@203.0.113.10",
    }, new Date("2026-06-25T20:00:00.000Z"))).toMatchObject({
      ok: false,
      status: 422,
      code: "unsupported_payload",
      message: "Setup session terminal connections require an SSH connection payload.",
    });
    expect(validateCustomImageSetupSshPayload({
      type: "ssh",
      command: "ssh secret-token@203.0.113.10 -i /tmp/private-key",
    }, new Date("2026-06-25T20:00:00.000Z"))).toMatchObject({
      ok: false,
      status: 422,
      code: "unsupported_command",
      message: "Setup session SSH payload uses an unsupported command shape.",
    });
  });

  it("returns clear failures for invalid and expired payload expiries", () => {
    expect(validateCustomImageSetupSshPayload({
      type: "ssh",
      command: "ssh token@example.test",
      expiresAt: "not-a-date",
    }, new Date("2026-06-25T20:00:00.000Z"))).toMatchObject({
      ok: false,
      status: 422,
      code: "invalid_expiry",
      message: "Setup session SSH payload has an invalid expiry.",
    });
    expect(validateCustomImageSetupSshPayload({
      type: "ssh",
      command: "ssh token@example.test",
      expiresAt: "2026-06-25T19:59:59.000Z",
    }, new Date("2026-06-25T20:00:00.000Z"))).toMatchObject({
      ok: false,
      status: 409,
      code: "expired_payload",
      message: "Setup session SSH connection payload has expired.",
    });
  });
});

describe("EnvironmentCustomImageTerminalSessionStore", () => {
  it("mints opaque connect tokens and tracks live session expiry separately", () => {
    const store = new EnvironmentCustomImageTerminalSessionStore();
    const now = new Date("2026-06-25T20:00:00.000Z");
    const minted = store.create({
      setupSessionId: "session-1",
      companyId: "company-1",
      environmentId: "env-1",
      provider: "daytona",
      ssh: { username: "ssh-token-secret", host: "203.0.113.10", port: 2222 },
      setupExpiresAt: new Date("2026-06-25T20:30:00.000Z"),
      connectionExpiresAt: new Date("2026-06-25T20:10:00.000Z"),
      now,
    });

    expect(minted.token).toHaveLength(43);
    expect(minted.session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(minted.session.connectExpiresAt.toISOString()).toBe("2026-06-25T20:05:00.000Z");
    expect(minted.session.sessionExpiresAt.toISOString()).toBe("2026-06-25T20:30:00.000Z");
    expect(minted.session.hostKeySha256).toBeNull();
    expect(store.get({
      id: minted.session.id,
      token: minted.token,
    }, new Date("2026-06-25T20:01:59.000Z"))?.ssh).toEqual({
      username: "ssh-token-secret",
      host: "203.0.113.10",
      port: 2222,
    });
    expect(store.get({
      id: minted.session.id,
      token: "wrong-token",
    }, new Date("2026-06-25T20:01:59.000Z"))).toBeNull();
    expect(store.getById(minted.session.id, new Date("2026-06-25T20:05:00.000Z"))?.id)
      .toBe(minted.session.id);
    expect(store.cleanupExpired(new Date("2026-06-25T20:05:00.000Z"))).toBe(0);
    expect(store.get({
      id: minted.session.id,
      token: minted.token,
    }, new Date("2026-06-25T20:05:00.000Z"))).toBeNull();
  });

  it("retains post-connection session records until setup-session expiry", () => {
    const store = new EnvironmentCustomImageTerminalSessionStore();
    const now = new Date("2026-06-25T20:00:00.000Z");
    const minted = store.create({
      setupSessionId: "session-1",
      companyId: "company-1",
      environmentId: "env-1",
      provider: "daytona",
      ssh: { username: "ssh-token-secret", host: "203.0.113.10", port: 2222 },
      setupExpiresAt: new Date("2026-06-25T20:30:00.000Z"),
      connectionExpiresAt: new Date("2026-06-25T20:01:00.000Z"),
      now,
    });

    expect(store.getById(minted.session.id, new Date("2026-06-25T20:05:00.000Z"))?.id)
      .toBe(minted.session.id);
    expect(store.cleanupExpired(new Date("2026-06-25T20:05:00.000Z"))).toBe(0);
    expect(store.getById(minted.session.id, new Date("2026-06-25T20:05:00.000Z"))?.id)
      .toBe(minted.session.id);

    expect(store.cleanupExpired(new Date("2026-06-25T20:30:00.000Z"))).toBe(1);
    expect(store.getById(minted.session.id, new Date("2026-06-25T20:30:00.000Z"))).toBeNull();
  });

  it("pins the first SSH host key fingerprint for a terminal session", () => {
    const store = new EnvironmentCustomImageTerminalSessionStore();
    const now = new Date("2026-06-25T20:00:00.000Z");
    const minted = store.create({
      setupSessionId: "session-1",
      companyId: "company-1",
      environmentId: "env-1",
      provider: "daytona",
      ssh: { username: "ssh-token-secret", host: "203.0.113.10", port: 2222 },
      setupExpiresAt: new Date("2026-06-25T20:30:00.000Z"),
      now,
    });

    expect(store.verifyOrPinHostKey({
      id: minted.session.id,
      hostKeySha256: "first-host-key-sha256",
    }, now)).toBe(true);
    expect(store.getById(minted.session.id, now)?.hostKeySha256).toBe("first-host-key-sha256");
    expect(store.verifyOrPinHostKey({
      id: minted.session.id,
      hostKeySha256: "first-host-key-sha256",
    }, now)).toBe(true);
    expect(store.verifyOrPinHostKey({
      id: minted.session.id,
      hostKeySha256: "changed-host-key-sha256",
    }, now)).toBe(false);
    expect(store.verifyOrPinHostKey({
      id: minted.session.id,
      hostKeySha256: "",
    }, now)).toBe(false);
    expect(store.verifyOrPinHostKey({
      id: minted.session.id,
      hostKeySha256: "first-host-key-sha256",
    }, new Date("2026-06-25T20:30:00.000Z"))).toBe(false);
  });

  it("deletes all tokens for a setup session", () => {
    const store = new EnvironmentCustomImageTerminalSessionStore();
    const now = new Date("2026-06-25T20:00:00.000Z");
    const first = store.create({
      setupSessionId: "session-1",
      companyId: "company-1",
      environmentId: "env-1",
      provider: "daytona",
      ssh: { username: "one", host: "example.test", port: 22 },
      setupExpiresAt: new Date("2026-06-25T20:30:00.000Z"),
      now,
    });
    const second = store.create({
      setupSessionId: "session-1",
      companyId: "company-1",
      environmentId: "env-1",
      provider: "daytona",
      ssh: { username: "two", host: "example.test", port: 22 },
      setupExpiresAt: new Date("2026-06-25T20:30:00.000Z"),
      now,
    });

    expect(store.deleteBySetupSessionId("session-1")).toBe(2);
    expect(store.get({ id: first.session.id, token: first.token }, now)).toBeNull();
    expect(store.get({ id: second.session.id, token: second.token }, now)).toBeNull();
  });
});

describe("EnvironmentCustomImageTerminalConnectionRegistry", () => {
  it("closes active terminal connections for a setup session", () => {
    const registry = new EnvironmentCustomImageTerminalConnectionRegistry();
    const firstReasons: string[] = [];
    const secondReasons: string[] = [];
    const removeFirst = registry.add({
      setupSessionId: "session-1",
      close: (reason) => firstReasons.push(reason),
    });
    registry.add({
      setupSessionId: "session-1",
      close: (reason) => secondReasons.push(reason),
    });

    expect(registry.closeBySetupSessionId("session-1", "setup_finished")).toBe(2);
    expect(firstReasons).toEqual(["setup_finished"]);
    expect(secondReasons).toEqual(["setup_finished"]);

    removeFirst();
    expect(registry.closeBySetupSessionId("session-1", "setup_cancelled")).toBe(1);
    expect(firstReasons).toEqual(["setup_finished"]);
    expect(secondReasons).toEqual(["setup_finished", "setup_cancelled"]);
  });
});
