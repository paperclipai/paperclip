import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Own every setup resource immediately, including failures before native launch. */
export async function withCopilotSmokeResources(installation, callback, dependencies = { mkdtemp, rm, createServer }) {
  const lease = await installation.openCommand();
  let root;
  let fixture;
  const fixtureRequests = [];
  try {
    root = await dependencies.mkdtemp(join(tmpdir(), "paperclip-copilot-pack-smoke-"));
    fixture = dependencies.createServer((request, response) => {
      fixtureRequests.push({ method: request.method, path: request.url?.split("?")[0] });
      response.writeHead(request.method === "GET" ? 200 : 503, { "content-type": "application/json" });
      response.end(JSON.stringify(request.method === "GET" ? { object: "list", data: [{ id: "gpt-4.1", object: "model", owned_by: "fixture" }] } : { error: "This initialize-only fixture cannot run inference" }));
    });
    fixture.listen(0, "127.0.0.1");
    await once(fixture, "listening");
    return await callback({ lease, root, fixture, fixtureRequests });
  } finally {
    try {
      if (fixture) {
        fixture.closeAllConnections();
        await new Promise((resolve, reject) => fixture.close(error => {
          if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
          else resolve();
        }));
      }
    } finally {
      try { await lease.close(); }
      finally { if (root) await dependencies.rm(root, { recursive: true, force: true }); }
    }
  }
}
