import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import { normalizeEnvironmentConfig, parseEnvironmentDriverConfig } from "../services/environment-config.ts";

describe("environment config helpers", () => {
  it("normalizes SSH config into its canonical stored shape", () => {
    const config = normalizeEnvironmentConfig({
      driver: "ssh",
      config: {
        host: "ssh.example.test",
        port: "2222",
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKeySecretRef: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
          version: "latest",
        },
        knownHosts: "",
      },
    });

    expect(config).toEqual({
      host: "ssh.example.test",
      port: 2222,
      username: "ssh-user",
      remoteWorkspacePath: "/srv/paperclip/workspace",
      privateKey: null,
      privateKeySecretRef: {
        type: "secret_ref",
        secretId: "11111111-1111-1111-1111-111111111111",
        version: "latest",
      },
      knownHosts: null,
      strictHostKeyChecking: true,
    });
  });

  it("rejects raw SSH private keys in the stored config shape", () => {
    expect(() =>
      normalizeEnvironmentConfig({
        driver: "ssh",
        config: {
          host: "ssh.example.test",
          port: "2222",
          username: "ssh-user",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: "PRIVATE KEY",
        },
      }),
    ).toThrow(HttpError);
  });

  it("rejects SSH config without an absolute remote workspace path", () => {
    expect(() =>
      normalizeEnvironmentConfig({
        driver: "ssh",
        config: {
          host: "ssh.example.test",
          username: "ssh-user",
          remoteWorkspacePath: "workspace",
        },
      }),
    ).toThrow(HttpError);

    expect(() =>
      normalizeEnvironmentConfig({
        driver: "ssh",
        config: {
          host: "ssh.example.test",
          username: "ssh-user",
          remoteWorkspacePath: "workspace",
        },
      }),
    ).toThrow("absolute");
  });

  it("parses a persisted SSH environment into a typed driver config", () => {
    const parsed = parseEnvironmentDriverConfig({
      driver: "ssh",
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: null,
        privateKeySecretRef: null,
        knownHosts: null,
        strictHostKeyChecking: false,
      },
    });

    expect(parsed).toEqual({
      driver: "ssh",
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: null,
        privateKeySecretRef: null,
        knownHosts: null,
        strictHostKeyChecking: false,
      },
    });
  });

  it("rejects unsupported environment drivers", () => {
    expect(() =>
      normalizeEnvironmentConfig({
        driver: "sandbox" as any,
        config: {
          provider: "fake",
        },
      }),
    ).toThrow(HttpError);
  });
});
