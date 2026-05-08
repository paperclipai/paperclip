import { describe, expect, it } from "vitest";
import { buildSshSpawnTarget, parseSshRemoteExecutionSpec, type SshRemoteExecutionSpec } from "./ssh.js";

const baseSpec: SshRemoteExecutionSpec = {
  host: "example.com",
  port: 22,
  username: "ec2-user",
  remoteCwd: "/home/ec2-user/workspace",
  remoteWorkspacePath: "/home/ec2-user/workspace",
  privateKey: null,
  knownHosts: null,
  strictHostKeyChecking: false,
};

describe("ssh ProxyCommand support", () => {
  it("round-trips proxyCommand through parseSshRemoteExecutionSpec", () => {
    const proxyCommand = "aws ssm start-session --target i-deadbeef --document-name AWS-StartSSHSession --parameters portNumber=%p --region us-east-1";
    const parsed = parseSshRemoteExecutionSpec({
      host: baseSpec.host,
      port: baseSpec.port,
      username: baseSpec.username,
      remoteCwd: baseSpec.remoteCwd,
      remoteWorkspacePath: baseSpec.remoteWorkspacePath,
      privateKey: null,
      knownHosts: null,
      strictHostKeyChecking: false,
      proxyCommand,
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.proxyCommand).toBe(proxyCommand);
  });

  it("treats empty proxyCommand as null when parsed", () => {
    const parsed = parseSshRemoteExecutionSpec({
      ...baseSpec,
      proxyCommand: "",
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.proxyCommand).toBeNull();
  });

  it("emits -o ProxyCommand=… flag when proxyCommand is set", async () => {
    const proxyCommand = "aws ssm start-session --target i-abc --document-name AWS-StartSSHSession --parameters portNumber=%p --region us-east-1";
    const target = await buildSshSpawnTarget({
      spec: { ...baseSpec, proxyCommand },
      command: "echo",
      args: ["hi"],
      env: {},
    });
    try {
      expect(target.command).toBe("ssh");
      expect(target.args).toContain("-o");
      expect(target.args).toContain(`ProxyCommand=${proxyCommand}`);
    } finally {
      await target.cleanup();
    }
  });

  it("does not emit ProxyCommand flag when proxyCommand is null", async () => {
    const target = await buildSshSpawnTarget({
      spec: { ...baseSpec, proxyCommand: null },
      command: "echo",
      args: ["hi"],
      env: {},
    });
    try {
      const proxyArg = target.args.find((arg) => arg.startsWith("ProxyCommand="));
      expect(proxyArg).toBeUndefined();
    } finally {
      await target.cleanup();
    }
  });
});
