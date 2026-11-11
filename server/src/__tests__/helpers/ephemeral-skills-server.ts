import express from "express";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createDb } from "@paperclipai/db";
import { companySkillRoutes } from "../../routes/company-skills.js";
import { errorHandler } from "../../middleware/error-handler.js";
import { companySkillService } from "../../services/company-skills.js";
import { getStorageService } from "../../storage/index.js";

const db = createDb(process.env.DATABASE_URL!, { maxConnections: 1 });
const storage = getStorageService();
const getObject = storage.getObject.bind(storage), putFile = storage.putFile.bind(storage);
let downloads = 0, downloadedBytes = 0, failUploads = false, crashAfterUpload = false, lostResponse = false;
storage.getObject = async (...args) => {
  downloads++;
  const result = await getObject(...args);
  downloadedBytes += result.contentLength ?? 0;
  return result;
};
storage.putFile = async (...args) => {
  if (failUploads) throw new Error("Qualification upload failure");
  const result = await putFile(...args);
  if (crashAfterUpload) process.kill(process.pid, "SIGKILL");
  return result;
};
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.actor = { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true };
  const json = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (lostResponse && res.statusCode < 400 && req.method !== "GET") {
      lostResponse = false;
      res.socket?.destroy();
      return res;
    }
    return json(body);
  }) as typeof res.json;
  next();
});
app.use("/api", companySkillRoutes(db));
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.send?.({ ready: true, port: typeof address === "object" ? address?.port : null, pid: process.pid });
});
process.on("message", async (message: { id: number; method: string; input?: Record<string, any> }) => {
  try {
    const input = message.input ?? {};
    let result: unknown;
    if (message.method === "faults") {
      failUploads = input.failUploads ?? false;
      crashAfterUpload = input.crashAfterUpload ?? false;
      lostResponse = input.lostResponse ?? false;
      result = true;
    } else if (message.method === "metrics") {
      result = { downloads, downloadedBytes, memory: process.memoryUsage() };
      downloads = 0; downloadedBytes = 0;
    } else if (message.method === "runtime") {
      const started = performance.now();
      result = await companySkillService(db).withRuntimeSkillEntries(input.companyId, {
        onlyKeys: new Set([input.key]), snapshotLatest: true,
        ...(input.versionId ? { versionSelections: new Map([[input.key, input.versionId]]) } : {}),
      }, async entries => {
        const entry = entries[0];
        if (!entry || entry.sourceStatus === "missing") throw new Error(entry?.missingDetail ?? "Missing runtime selection");
        const output = input.execute ? await promisify(execFile)(path.join(entry.source, "scripts/run.sh"), [], { cwd: entry.source }) : null;
        return { versionId: entry.versionId, markdown: await fs.readFile(path.join(entry.source, "SKILL.md"), "utf8"),
          output: output?.stdout, elapsedMs: performance.now() - started };
      });
    } else throw new Error("Unknown fixture method");
    process.send?.({ id: message.id, result });
  } catch (error) { process.send?.({ id: message.id, error: error instanceof Error ? error.message : String(error) }); }
});
