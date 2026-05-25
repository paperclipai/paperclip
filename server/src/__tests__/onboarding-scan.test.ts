import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { errorHandler } from "../middleware/index.js";
import { onboardingRoutes } from "../routes/onboarding.js";
import { scanOnboardingDirectory } from "../services/onboarding-scan.js";

let tempRoot: string;

async function writeFile(relativePath: string, contents = "") {
  const target = path.join(tempRoot, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
  return target;
}

async function mkdir(relativePath: string) {
  const target = path.join(tempRoot, relativePath);
  await fs.mkdir(target, { recursive: true });
  return target;
}

function createApp(actor: Partial<Express.Request["actor"]> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      source: "local_implicit",
      userId: "11111111-1111-4111-8111-111111111111",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: true,
      ...actor,
    } as typeof req.actor;
    next();
  });
  app.use("/api", onboardingRoutes());
  app.use(errorHandler);
  return app;
}

describe("onboarding directory scan", () => {
  beforeEach(async () => {
    const tmpBase = process.platform === "darwin" ? "/private/tmp" : os.tmpdir();
    tempRoot = await fs.mkdtemp(path.join(tmpBase, "paperclip-onboarding-scan-"));
  });

  afterEach(async () => {
    await fs.chmod(tempRoot, 0o700).catch(() => undefined);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("rejects relative paths", async () => {
    await expect(
      scanOnboardingDirectory({ path: "relative/project", maxDepth: 3, includeManifests: true }),
    ).rejects.toMatchObject({
      status: 400,
      message: "Path must be absolute",
    });
  });

  it("rejects sensitive roots after canonicalization", async () => {
    await expect(
      scanOnboardingDirectory({ path: "/etc", maxDepth: 3, includeManifests: true }),
    ).rejects.toMatchObject({
      status: 400,
      message: "Path targets a sensitive system or credential directory",
    });
  });

  it("summarizes a brownfield TypeScript project without reading secret files", async () => {
    await writeFile("package.json", JSON.stringify({
      dependencies: { express: "^5.0.0", react: "^19.0.0" },
      devDependencies: { typescript: "^5.0.0", vite: "^6.0.0" },
    }));
    await writeFile("tsconfig.json", "{}");
    await writeFile("src/App.tsx", "export function App() { return null; }");
    await writeFile(".env", "OPENAI_API_KEY=sk-secret");

    const result = await scanOnboardingDirectory({ path: tempRoot, maxDepth: 3, includeManifests: true });

    expect(result.repoKind).toBe("brownfield");
    expect(result.detectedStacks).toEqual(expect.arrayContaining(["node", "react", "typescript"]));
    expect(result.packageManagers).toEqual([]);
    expect(result.safeManifestIndicators).toEqual(expect.arrayContaining(["package.json", "tsconfig.json"]));
    expect(result.boundedSanitizedSummary.dependencies).toEqual(["express", "react"]);
    expect(result.boundedSanitizedSummary.devDependencies).toEqual(["typescript", "vite"]);
    expect(JSON.stringify(result)).not.toContain("sk-secret");
    expect(result.boundedSanitizedSummary.directoryStructure).toContain(".env");
  });

  it("treats an empty or readme-only folder as greenfield empty", async () => {
    await writeFile("README.md", "# New project");
    await writeFile(".gitignore", "node_modules");

    const result = await scanOnboardingDirectory({ path: tempRoot, maxDepth: 3, includeManifests: true });

    expect(result.repoKind).toBe("empty");
    expect(result.boundedSanitizedSummary.hasReadme).toBe(true);
  });

  it("ignores heavy folders and does not count their contents", async () => {
    await writeFile("node_modules/pkg/index.ts", "export const hidden = true;");
    await writeFile("src/index.ts", "export const visible = true;");

    const result = await scanOnboardingDirectory({ path: tempRoot, maxDepth: 3, includeManifests: true });

    expect(result.counts.ignoredDirectories).toBe(1);
    expect(result.boundedSanitizedSummary.directoryStructure).not.toContain("node_modules/pkg/index.ts");
    expect(result.boundedSanitizedSummary.directoryStructure).toContain("src/index.ts");
  });

  it("reports symlinks without following them", async () => {
    await writeFile("outside/secret.ts", "export const secret = true;");
    await mkdir("project");
    await fs.symlink(path.join(tempRoot, "outside"), path.join(tempRoot, "project", "linked-outside"));

    const result = await scanOnboardingDirectory({
      path: path.join(tempRoot, "project"),
      maxDepth: 3,
      includeManifests: true,
    });

    expect(result.counts.symlinks).toBe(1);
    expect(result.boundedSanitizedSummary.directoryStructure).toContain("linked-outside");
    expect(result.boundedSanitizedSummary.directoryStructure).not.toContain("linked-outside/secret.ts");
  });

  it("returns too_large when entry limits are reached", async () => {
    for (let index = 0; index < 5005; index += 1) {
      await writeFile(`many/file-${index}.txt`, "x");
    }

    const result = await scanOnboardingDirectory({ path: tempRoot, maxDepth: 3, includeManifests: true });

    expect(result.repoKind).toBe("too_large");
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "scan_limit_reached" }));
  });

  it("continues with warnings when child directories cannot be read", async () => {
    await writeFile("src/index.ts", "export const visible = true;");
    const unreadable = await mkdir("private");
    await fs.chmod(unreadable, 0o000);

    const result = await scanOnboardingDirectory({ path: tempRoot, maxDepth: 3, includeManifests: true });

    await fs.chmod(unreadable, 0o700);
    expect(result.repoKind).toBe("brownfield");
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "directory_unreadable" }));
  });

  it("exposes the scan through a board-only API route", async () => {
    await writeFile("package.json", JSON.stringify({ dependencies: { express: "^5.0.0" } }));

    const res = await request(createApp())
      .post("/api/onboarding/scan")
      .send({ path: tempRoot });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      repoKind: "brownfield",
      boundedSanitizedSummary: {
        dependencies: ["express"],
      },
    });
  });

  it("rejects agent actors for scan route", async () => {
    const res = await request(createApp({
      type: "agent",
      companyId: "company-1",
      agentId: "agent-1",
      runId: null,
    } as Partial<Express.Request["actor"]>))
      .post("/api/onboarding/scan")
      .send({ path: tempRoot });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Board access required" });
  });
});
