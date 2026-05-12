import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
const spawnMock = vi.hoisted(() => vi.fn());

vi.stubGlobal("fetch", fetchMock);

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import plugin from "./plugin.js";

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = {
    written: "" as string,
    ended: false,
    write: (chunk: string) => {
      this.stdin.written += chunk;
      return true;
    },
    end: () => {
      this.stdin.ended = true;
    },
  };
  kill = vi.fn();

  constructor(input: { code?: number; signal?: string | null; stdout?: string; stderr?: string }) {
    super();
    queueMicrotask(() => {
      if (input.stdout) this.stdout.emit("data", input.stdout);
      if (input.stderr) this.stderr.emit("data", input.stderr);
      this.emit("close", input.code ?? 0, input.signal ?? null);
    });
  }
}

function queueSpawnResult(input: { code?: number; signal?: string | null; stdout?: string; stderr?: string }) {
  spawnMock.mockImplementationOnce(() => new MockChildProcess(input));
}

describe("exe.dev sandbox provider plugin", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    spawnMock.mockReset();
    delete process.env.EXE_API_KEY;
  });

  it("declares environment lifecycle handlers", async () => {
    expect(await plugin.definition.onHealth?.()).toEqual({
      status: "ok",
      message: "exe.dev sandbox provider plugin healthy",
    });
    expect(plugin.definition.onEnvironmentAcquireLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentExecute).toBeTypeOf("function");
  });

  it("normalizes config and emits SSH guidance warnings", async () => {
    process.env.EXE_API_KEY = "host-key";

    const result = await plugin.definition.onEnvironmentValidateConfig?.({
      driverKey: "exe-dev",
      config: {
        apiUrl: "https://exe.dev",
        namePrefix: " Paperclip Sandbox ",
        image: " ubuntu:22.04 ",
        cpu: "4.8",
        memory: " 8GB ",
        disk: " 50GB ",
        env: {
          FOO: " bar ",
        },
        integrations: [" github "],
        tags: "prod, sandbox",
        timeoutMs: "450000.9",
        reuseLease: true,
        sshPort: "2222",
      },
    });

    expect(result).toEqual({
      ok: true,
      warnings: [
        "The Paperclip host must have SSH access to the created exe.dev VM, and its SSH key must be registered with exe.dev. The API token only covers provisioning.",
        "reuseLease keeps the VM alive between runs; this provider does not suspend retained VMs.",
      ],
      normalizedConfig: {
        apiKey: null,
        apiUrl: "https://exe.dev/exec",
        namePrefix: "paperclip-sandbox",
        image: "ubuntu:22.04",
        command: null,
        cpu: 4,
        memory: "8GB",
        disk: "50GB",
        comment: null,
        env: { FOO: "bar" },
        integrations: ["github"],
        tags: ["prod", "sandbox"],
        setupScript: null,
        prompt: null,
        timeoutMs: 450000,
        reuseLease: true,
        sshUser: null,
        sshPrivateKey: null,
        sshIdentityFile: null,
        sshPort: 2222,
        strictHostKeyChecking: "accept-new",
      },
    });
  });

  it("normalizes trailing /exec apiUrl inputs without duplication", async () => {
    process.env.EXE_API_KEY = "host-key";

    const result = await plugin.definition.onEnvironmentValidateConfig?.({
      driverKey: "exe-dev",
      config: {
        apiUrl: "https://exe.dev/exec/",
      },
    });

    expect(result).toMatchObject({
      ok: true,
      normalizedConfig: {
        apiUrl: "https://exe.dev/exec",
      },
    });
  });

  it("rejects invalid config", async () => {
    await expect(plugin.definition.onEnvironmentValidateConfig?.({
      driverKey: "exe-dev",
      config: {
        apiUrl: "not-a-url",
        cpu: 0,
        env: {
          "BAD-KEY": "value",
        },
        sshPort: 70000,
        strictHostKeyChecking: "",
        timeoutMs: 0,
      },
    })).resolves.toEqual({
      ok: false,
      warnings: [
        "The Paperclip host must have SSH access to the created exe.dev VM, and its SSH key must be registered with exe.dev. The API token only covers provisioning.",
      ],
      errors: [
        "apiUrl must be a valid URL.",
        "timeoutMs must be between 1 and 86400000.",
        "cpu must be greater than 0 when provided.",
        "sshPort must be between 1 and 65535.",
        "exe.dev environments require an API key in config or EXE_API_KEY.",
        "env contains an invalid key: BAD-KEY",
        "strictHostKeyChecking cannot be empty.",
      ],
    });
  });

  it("acquires a lease by creating a VM and preparing the SSH workspace", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        vm_name: "paperclip-env-run",
        ssh_dest: "paperclip-env-run.exe.xyz",
        https_url: "https://paperclip-env-run.exe.xyz",
        status: "running",
      }), { status: 200 }),
    );
    queueSpawnResult({ stdout: "/home/exe\nbash\n" });
    queueSpawnResult({});

    const lease = await plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "exe-dev",
      companyId: "company-1",
      environmentId: "env-1",
      runId: "run-1",
      requestedCwd: "/workspace/custom",
      config: {
        apiKey: "api-key",
        namePrefix: "paperclip",
        image: "ubuntu:22.04",
        timeoutMs: 300000,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[1]?.body ?? "")).toContain("new --json --no-email");
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(lease).toMatchObject({
      providerLeaseId: "paperclip-env-run",
      metadata: {
        provider: "exe-dev",
        vmName: "paperclip-env-run",
        sshDest: "paperclip-env-run.exe.xyz",
        remoteCwd: "/workspace/custom",
        shellCommand: "bash",
        reuseLease: false,
      },
    });
  });

  it("uses a pasted sshPrivateKey when connecting to the VM", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        vm_name: "paperclip-env-run",
        ssh_dest: "paperclip-env-run.exe.xyz",
        https_url: "https://paperclip-env-run.exe.xyz",
        status: "running",
      }), { status: 200 }),
    );
    queueSpawnResult({ stdout: "/home/exe\nbash\n" });
    queueSpawnResult({});

    await plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "exe-dev",
      companyId: "company-1",
      environmentId: "env-1",
      runId: "run-1",
      config: {
        apiKey: "api-key",
        sshPrivateKey: "-----BEGIN PRIVATE KEY-----\npretend\n-----END PRIVATE KEY-----",
      },
    });

    const firstSpawnArgs = spawnMock.mock.calls[0]?.[1] as string[] | undefined;
    expect(firstSpawnArgs).toContain("-i");
    expect(firstSpawnArgs).toContain("-o");
    expect(firstSpawnArgs).toContain("IdentitiesOnly=yes");
  });

  it("supplies a default Node-install setup script when none is provided", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        vm_name: "paperclip-env-run",
        ssh_dest: "paperclip-env-run.exe.xyz",
        https_url: "https://paperclip-env-run.exe.xyz",
        status: "running",
      }), { status: 200 }),
    );
    queueSpawnResult({ stdout: "/home/exedev\nbash\n" });
    queueSpawnResult({});

    await plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "exe-dev",
      companyId: "company-1",
      environmentId: "env-1",
      runId: "run-1",
      config: {
        apiKey: "api-key",
      },
    });

    const body = String(fetchMock.mock.calls[0]?.[1]?.body ?? "");
    expect(body).toContain("--setup-script=");
    expect(body).toContain("nodesource.com/setup_20.x");
    expect(body).toContain("sudo apt-get install -y nodejs");
  });

  it("preserves an operator-supplied setup script and does not append the default", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        vm_name: "paperclip-env-run",
        ssh_dest: "paperclip-env-run.exe.xyz",
        https_url: "https://paperclip-env-run.exe.xyz",
        status: "running",
      }), { status: 200 }),
    );
    queueSpawnResult({ stdout: "/home/exedev\nbash\n" });
    queueSpawnResult({});

    await plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "exe-dev",
      companyId: "company-1",
      environmentId: "env-1",
      runId: "run-1",
      config: {
        apiKey: "api-key",
        setupScript: "echo custom",
      },
    });

    const body = String(fetchMock.mock.calls[0]?.[1]?.body ?? "");
    expect(body).toContain("--setup-script='echo custom'");
    expect(body).not.toContain("nodesource.com");
  });

  it("does not redact the built-in default setup script in API errors", async () => {
    fetchMock.mockResolvedValueOnce(new Response("upstream boom", { status: 500 }));

    const acquirePromise = plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "exe-dev",
      companyId: "company-1",
      environmentId: "env-1",
      runId: "run-1",
      config: {
        apiKey: "api-key",
      },
    });

    await expect(acquirePromise).rejects.toMatchObject({
      name: "ExeDevApiError",
      status: 500,
    });

    await acquirePromise?.catch((error: Error) => {
      // Operator did not supply a setupScript, so the visible default install
      // is not a secret and stays in the error for debuggability.
      expect(error.message).toContain("nodesource.com/setup_20.x");
      expect(error.message).not.toContain("[REDACTED]");
    });
  });

  it("surfaces exe.dev SSH onboarding guidance during lease acquisition", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({
        vm_name: "paperclip-env-run",
        ssh_dest: "paperclip-env-run.exe.xyz",
        https_url: "https://paperclip-env-run.exe.xyz",
        status: "running",
      }), { status: 200 }),
    );
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    queueSpawnResult({ code: 1, stdout: "Please complete registration by running: ssh exe.dev\n" });

    await expect(plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "exe-dev",
      companyId: "company-1",
      environmentId: "env-1",
      runId: "run-1",
      config: {
        apiKey: "api-key",
        timeoutMs: 300000,
      },
    })).rejects.toThrow(
      "the Paperclip host SSH key is not registered with exe.dev",
    );

    expect(String(fetchMock.mock.calls[1]?.[1]?.body ?? "")).toBe("rm --json 'paperclip-env-run'");
  });

  it("redacts sensitive lifecycle flags in API errors", async () => {
    fetchMock.mockResolvedValueOnce(new Response("upstream boom", { status: 500 }));

    const acquirePromise = plugin.definition.onEnvironmentAcquireLease?.({
      driverKey: "exe-dev",
      companyId: "company-1",
      environmentId: "env-1",
      runId: "run-1",
      config: {
        apiKey: "api-key",
        env: {
          SECRET: "super-secret",
        },
        prompt: "build me a secret app",
        setupScript: "export TOKEN=super-secret",
      },
    });

    await expect(acquirePromise).rejects.toMatchObject({
      name: "ExeDevApiError",
      status: 500,
      body: "upstream boom",
    });

    await acquirePromise?.catch((error: Error) => {
      expect(error.message).toContain("--env='SECRET=[REDACTED]'");
      expect(error.message).toContain("--prompt='[REDACTED]'");
      expect(error.message).toContain("--setup-script='[REDACTED]'");
      expect(error.message).not.toContain("super-secret");
    });
  });

  it("returns an expired lease when the retained VM no longer exists", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ vms: [] }), { status: 200 }),
    );

    const lease = await plugin.definition.onEnvironmentResumeLease?.({
      driverKey: "exe-dev",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "missing-vm",
      config: {
        apiKey: "api-key",
      },
      leaseMetadata: {
        sshDest: "missing-vm.exe.xyz",
      },
    });

    expect(lease).toEqual({
      providerLeaseId: null,
      metadata: {
        expired: true,
      },
    });
  });

  it("executes commands over SSH with cwd, env, and stdin", async () => {
    queueSpawnResult({ code: 0, stdout: "hello\n", stderr: "" });

    const result = await plugin.definition.onEnvironmentExecute?.({
      driverKey: "exe-dev",
      companyId: "company-1",
      environmentId: "env-1",
      config: {
        apiKey: "api-key",
        timeoutMs: 300000,
      },
      lease: {
        providerLeaseId: "vm-1",
        metadata: {
          sshDest: "vm-1.exe.xyz",
        },
      },
      command: "node",
      args: ["-e", "process.stdout.write('hello\\n')"],
      cwd: "/workspace",
      env: {
        FOO: "bar",
      },
      stdin: "input-body",
      timeoutMs: 1000,
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[0]).toBe("ssh");
    expect(String(spawnMock.mock.calls[0]?.[1]?.at(-1) ?? "")).toContain("/workspace");
    expect(String(spawnMock.mock.calls[0]?.[1]?.at(-1) ?? "")).toContain("FOO='");
    const child = spawnMock.mock.results[0]?.value as MockChildProcess;
    expect(child.stdin.written).toBe("input-body");
    expect(child.stdin.ended).toBe(true);
    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      stdout: "hello\n",
      stderr: "",
      metadata: {
        provider: "exe-dev",
        vmName: "vm-1",
      },
    });
  });

  it("returns exe.dev SSH onboarding guidance for command execution failures", async () => {
    queueSpawnResult({ code: 1, stdout: "Please complete registration by running: ssh exe.dev\n" });

    const result = await plugin.definition.onEnvironmentExecute?.({
      driverKey: "exe-dev",
      companyId: "company-1",
      environmentId: "env-1",
      config: {
        apiKey: "api-key",
        timeoutMs: 300000,
      },
      lease: {
        providerLeaseId: "vm-1",
        metadata: {
          sshDest: "vm-1.exe.xyz",
        },
      },
      command: "node",
      args: ["-v"],
    });

    expect(result?.exitCode).toBe(1);
    expect(String(result?.stderr ?? "")).toContain("the Paperclip host SSH key is not registered with exe.dev");
    expect(String(result?.stderr ?? "")).toContain("ssh exe.dev");
  });

  it("probes by creating and then deleting a VM after SSH verification", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          vm_name: "paperclip-probe",
          ssh_dest: "paperclip-probe.exe.xyz",
          status: "running",
        }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    queueSpawnResult({ stdout: "/home/exe\nbash\n" });
    queueSpawnResult({});

    const result = await plugin.definition.onEnvironmentProbe?.({
      driverKey: "exe-dev",
      companyId: "company-1",
      environmentId: "env-1",
      config: {
        apiKey: "api-key",
      },
    });

    expect(result).toMatchObject({
      ok: true,
      summary: "Connected to exe.dev VM paperclip-probe.",
      metadata: {
        provider: "exe-dev",
        vmName: "paperclip-probe",
        sshDest: "paperclip-probe.exe.xyz",
        shellCommand: "bash",
      },
    });
    expect(String(fetchMock.mock.calls[1]?.[1]?.body ?? "")).toBe("rm --json 'paperclip-probe'");
  });

  it("cleans up the probe VM when SSH verification fails", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          vm_name: "paperclip-probe",
          ssh_dest: "paperclip-probe.exe.xyz",
          status: "running",
        }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    queueSpawnResult({ code: 1, stderr: "permission denied" });

    const result = await plugin.definition.onEnvironmentProbe?.({
      driverKey: "exe-dev",
      companyId: "company-1",
      environmentId: "env-1",
      config: {
        apiKey: "api-key",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      summary: "exe.dev environment probe failed.",
      metadata: {
        provider: "exe-dev",
      },
    });
    expect(String(result?.metadata?.error ?? "")).toContain("permission denied");
    expect(String(fetchMock.mock.calls[1]?.[1]?.body ?? "")).toBe("rm --json 'paperclip-probe'");
  });

  it("returns onboarding guidance when probe hits exe.dev SSH registration", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          vm_name: "paperclip-probe",
          ssh_dest: "paperclip-probe.exe.xyz",
          status: "running",
        }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    queueSpawnResult({ code: 1, stdout: "Please complete registration by running: ssh exe.dev\n" });

    const result = await plugin.definition.onEnvironmentProbe?.({
      driverKey: "exe-dev",
      companyId: "company-1",
      environmentId: "env-1",
      config: {
        apiKey: "api-key",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      summary: "exe.dev environment probe failed.",
    });
    expect(String(result?.metadata?.error ?? "")).toContain("the Paperclip host SSH key is not registered with exe.dev");
    expect(String(fetchMock.mock.calls[1]?.[1]?.body ?? "")).toBe("rm --json 'paperclip-probe'");
  });

  it("deletes non-reusable leases on release", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await plugin.definition.onEnvironmentReleaseLease?.({
      driverKey: "exe-dev",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "vm-1",
      config: {
        apiKey: "api-key",
        reuseLease: false,
      },
      leaseMetadata: {},
    });

    expect(String(fetchMock.mock.calls[0]?.[1]?.body ?? "")).toBe("rm --json 'vm-1'");
  });

  it("destroys leases on demand", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await plugin.definition.onEnvironmentDestroyLease?.({
      driverKey: "exe-dev",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "vm-2",
      config: {
        apiKey: "api-key",
      },
      leaseMetadata: {},
    });

    expect(String(fetchMock.mock.calls[0]?.[1]?.body ?? "")).toBe("rm --json 'vm-2'");
  });

  it("realizes a workspace by mkdir-ing the remote cwd over SSH when VM metadata is present", async () => {
    queueSpawnResult({ code: 0, stdout: "", stderr: "" });

    const result = await plugin.definition.onEnvironmentRealizeWorkspace?.({
      driverKey: "exe-dev",
      companyId: "company-1",
      environmentId: "env-1",
      config: {
        apiKey: "api-key",
        timeoutMs: 300000,
      },
      lease: {
        providerLeaseId: "vm-1",
        metadata: {
          sshDest: "vm-1.exe.xyz",
          remoteCwd: "/srv/paperclip/run-1",
        },
      },
      workspace: {
        localPath: "/local/paperclip",
        remotePath: undefined,
      },
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[0]).toBe("ssh");
    const sshCommand = String(spawnMock.mock.calls[0]?.[1]?.at(-1) ?? "");
    expect(sshCommand).toContain("mkdir -p");
    expect(sshCommand).toContain("/srv/paperclip/run-1");
    expect(result).toMatchObject({
      cwd: "/srv/paperclip/run-1",
      metadata: {
        provider: "exe-dev",
        remoteCwd: "/srv/paperclip/run-1",
      },
    });
  });

  it("falls back through workspace.remotePath then workspace.localPath when lease.metadata.remoteCwd is missing", async () => {
    queueSpawnResult({ code: 0, stdout: "", stderr: "" });

    const result = await plugin.definition.onEnvironmentRealizeWorkspace?.({
      driverKey: "exe-dev",
      companyId: "company-1",
      environmentId: "env-1",
      config: {
        apiKey: "api-key",
        timeoutMs: 300000,
      },
      lease: {
        providerLeaseId: "vm-1",
        metadata: {
          sshDest: "vm-1.exe.xyz",
        },
      },
      workspace: {
        localPath: "/local/paperclip",
        remotePath: "/srv/paperclip/remote-fallback",
      },
    });

    expect(result?.cwd).toBe("/srv/paperclip/remote-fallback");
  });

  it("skips ensureRemoteWorkspace and returns the resolved cwd when no VM metadata is available", async () => {
    const result = await plugin.definition.onEnvironmentRealizeWorkspace?.({
      driverKey: "exe-dev",
      companyId: "company-1",
      environmentId: "env-1",
      config: {
        apiKey: "api-key",
        timeoutMs: 300000,
      },
      lease: {
        providerLeaseId: null,
        metadata: {
          remoteCwd: "/srv/paperclip/no-vm",
        },
      },
      workspace: {
        localPath: "/local/paperclip",
      },
    });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(result?.cwd).toBe("/srv/paperclip/no-vm");
  });
});
