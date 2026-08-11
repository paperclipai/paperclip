import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { definePlugin } from "../src/define-plugin.js";
import {
  createRequest,
  isJsonRpcResponse,
  parseMessage,
  serializeMessage,
  type JsonRpcResponse,
} from "../src/protocol.js";
import { startWorkerRpcHost } from "../src/worker-rpc-host.js";

/**
 * Exercises the repository-provider hooks through the real JSON-RPC worker
 * host, not just as function calls: a hook that is defined must be advertised
 * in `initialize` and reachable by its method name, and one that is not defined
 * must fail closed rather than resolve to undefined.
 */

const HOST = "github.acme-corp.example";
const PROVIDER = "github-enterprise";
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

function makeWorker(plugin: ReturnType<typeof definePlugin>) {
  const hostToWorker = new PassThrough();
  const workerToHost = new PassThrough();
  const hostReadline = createInterface({ input: workerToHost });
  const pending = new Map<string, (response: JsonRpcResponse) => void>();
  let nextRequestId = 1;

  const worker = startWorkerRpcHost({ plugin, stdin: hostToWorker, stdout: workerToHost });

  hostReadline.on("line", (line) => {
    const message = parseMessage(line);
    if (!isJsonRpcResponse(message)) return;
    pending.get(String(message.id))?.(message);
    pending.delete(String(message.id));
  });

  function callWorker(method: string, params: unknown) {
    const id = `host-${nextRequestId++}`;
    const result = new Promise<unknown>((resolve, reject) => {
      pending.set(id, (response) => {
        if ("error" in response && response.error) {
          reject(Object.assign(new Error(response.error.message), { code: response.error.code }));
          return;
        }
        resolve((response as { result?: unknown }).result);
      });
    });
    hostToWorker.write(serializeMessage(createRequest(method, params, id)));
    return result;
  }

  async function initialize() {
    return await callWorker("initialize", {
      manifest: {
        id: "acme.github-enterprise",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "GitHub Enterprise",
        description: "Test provider",
        author: "Paperclip",
        categories: ["connector"],
        capabilities: ["repository.providers.register"],
        entrypoints: { worker: "dist/worker.js" },
        repositoryProviders: [{ providerKey: PROVIDER, displayName: "GitHub Enterprise", host: HOST }],
      },
      config: {},
      databaseNamespace: null,
    });
  }

  function stop() {
    worker.stop();
    hostReadline.close();
    hostToWorker.destroy();
    workerToHost.destroy();
  }

  return { callWorker, initialize, stop };
}

describe("repository provider worker RPC", () => {
  it("advertises implemented hooks and dispatches to them", async () => {
    const seen: string[] = [];
    const plugin = definePlugin({
      async setup() {},
      async onRepositoryProviderBeginInstallation(params) {
        seen.push(`begin:${params.companyId}:${params.host}`);
        return {
          installUrl: `https://${HOST}/install?state=abc`,
          state: "abc",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
      async onRepositoryProviderDiscover(params) {
        seen.push(`discover:${params.connection.id}`);
        return { items: [], nextCursor: null, total: 0 };
      },
    });
    const { callWorker, initialize, stop } = makeWorker(plugin);

    try {
      const initialized = await initialize() as { supportedMethods: string[] };
      expect(initialized.supportedMethods).toContain("repositoryProviderBeginInstallation");
      expect(initialized.supportedMethods).toContain("repositoryProviderDiscover");
      // Not implemented by this plugin, so not advertised — the host uses this
      // to refuse registration of a partially implemented connector.
      expect(initialized.supportedMethods).not.toContain("repositoryProviderResolveCloneCredential");

      const begun = await callWorker("repositoryProviderBeginInstallation", {
        providerKey: PROVIDER,
        host: HOST,
        companyId: COMPANY_ID,
        userId: "22222222-2222-4222-8222-222222222222",
        redirectPath: null,
      }) as { state: string };
      expect(begun.state).toBe("abc");
      expect(seen).toContain(`begin:${COMPANY_ID}:${HOST}`);
    } finally {
      stop();
    }
  });

  it("fails closed when a repository provider method is not implemented", async () => {
    const plugin = definePlugin({ async setup() {} });
    const { callWorker, initialize, stop } = makeWorker(plugin);

    try {
      await initialize();
      await expect(
        callWorker("repositoryProviderResolveCloneCredential", {
          providerKey: PROVIDER,
          host: HOST,
          companyId: COMPANY_ID,
          connection: {},
          repository: {},
        }),
      ).rejects.toThrow(/repositoryProviderResolveCloneCredential/);
    } finally {
      stop();
    }
  });
});
