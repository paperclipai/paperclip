import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

const uploadHelperPath = path.resolve(
  import.meta.dirname,
  "../../../skills/paperclip/scripts/paperclip-upload-artifact.sh",
);
const issueUpdateHelperPath = path.resolve(
  import.meta.dirname,
  "../../../skills/paperclip/scripts/paperclip-issue-update.sh",
);

const companyId = "company-1";
const issueId = "issue-1";

interface RecordedRequest {
  method: string;
  url: string;
  body: string;
  runId: string | string[] | undefined;
}

interface HelperResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface AttachmentPayload {
  id: string;
  contentPath: string;
  downloadPath: string;
  byteSize: number;
  originalFilename: string;
  contentType: string;
  sha256: string;
  originatingRunId: string | null;
}

function attachmentPayload(overrides: Partial<AttachmentPayload> = {}): AttachmentPayload {
  return {
    id: "attachment-1",
    contentPath: `/api/issues/${issueId}/attachments/attachment-1/content`,
    downloadPath: `/api/issues/${issueId}/attachments/attachment-1/content?download=1`,
    byteSize: 25,
    originalFilename: "artifact.txt",
    contentType: "text/plain",
    sha256: "0".repeat(64),
    originatingRunId: null,
    ...overrides,
  };
}

describe("paperclip skill helpers and the run id header", () => {
  const cleanupFns: Array<() => Promise<void>> = [];
  const tempRoots: string[] = [];

  afterEach(async () => {
    while (cleanupFns.length > 0) {
      const cleanup = cleanupFns.pop();
      if (!cleanup) continue;
      await cleanup().catch(() => undefined);
    }
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (!root) continue;
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function createArtifact(): Promise<{ file: string; sha256: string; stateDir: string }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-id-helper-"));
    tempRoots.push(root);
    const file = path.join(root, "artifact.txt");
    const body = "run id helper artifact body\n";
    await fs.writeFile(file, body);
    const stateDir = path.join(root, "helper-state");
    await fs.mkdir(stateDir, { recursive: true });
    return { file, sha256: createHash("sha256").update(body).digest("hex"), stateDir };
  }

  async function startApi(
    options: {
      uploadedAttachment?: AttachmentPayload;
      existingAttachments?: AttachmentPayload[];
    } = {},
  ): Promise<{ baseUrl: string; requests: RecordedRequest[] }> {
    const requests: RecordedRequest[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", chunk => {
        body += chunk;
      });
      req.on("end", () => {
        const recorded: RecordedRequest = {
          method: req.method ?? "",
          url: req.url ?? "",
          body,
          runId: req.headers["x-paperclip-run-id"],
        };
        requests.push(recorded);
        const url = recorded.url.split("?")[0] ?? "";
        const send = (status: number, payload: unknown): void => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };

        if (recorded.method === "GET" && url === `/api/issues/${issueId}/attachments`) {
          send(200, options.existingAttachments ?? []);
          return;
        }
        if (
          recorded.method === "POST" &&
          url === `/api/companies/${companyId}/issues/${issueId}/attachments`
        ) {
          send(201, options.uploadedAttachment ?? attachmentPayload());
          return;
        }
        if (recorded.method === "POST" && url === `/api/issues/${issueId}/work-products`) {
          send(200, { id: "work-product-1", ...JSON.parse(recorded.body) });
          return;
        }
        if (recorded.method === "POST" && url === `/api/issues/${issueId}/comments`) {
          send(200, { id: "comment-1" });
          return;
        }
        if (recorded.method === "PATCH" && url === `/api/issues/${issueId}`) {
          const payload = JSON.parse(recorded.body) as { status?: string };
          send(200, { id: issueId, status: payload.status ?? "" });
          return;
        }
        send(404, { error: "not found" });
      });
    });
    await new Promise<void>(resolve => {
      server.listen(0, "127.0.0.1", resolve);
    });
    cleanupFns.push(
      () =>
        new Promise<void>(resolve => {
          server.close(() => resolve());
        }),
    );
    const { port } = server.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${port}`, requests };
  }

  function buildEnv(
    baseUrl: string,
    stateDir: string,
    runId?: string,
  ): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PAPERCLIP_API_URL: baseUrl,
      PAPERCLIP_API_KEY: "test-key",
      PAPERCLIP_COMPANY_ID: companyId,
      PAPERCLIP_TASK_ID: issueId,
      PAPERCLIP_HELPER_STATE_DIR: stateDir,
    };
    if (runId !== undefined) env.PAPERCLIP_RUN_ID = runId;
    else delete env.PAPERCLIP_RUN_ID;
    return env;
  }

  function runHelper(
    script: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<HelperResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("bash", [script, ...args], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin.end();
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", chunk => {
        stdout += chunk;
      });
      child.stderr.on("data", chunk => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", code => resolve({ code, stdout, stderr }));
    });
  }

  function workProductBody(requests: RecordedRequest[]): Record<string, unknown> {
    const request = requests.find(
      candidate =>
        candidate.method === "POST" &&
        candidate.url === `/api/issues/${issueId}/work-products`,
    );
    if (!request) throw new Error("no work product request was recorded");
    return JSON.parse(request.body) as Record<string, unknown>;
  }

  const noRunIdCases: Array<[string, string | undefined]> = [
    ["unset", undefined],
    ["empty", ""],
  ];

  it.each(noRunIdCases)(
    "uploads without a run id header when PAPERCLIP_RUN_ID is %s",
    async (_label, runId) => {
      const artifact = await createArtifact();
      const { baseUrl, requests } = await startApi({
        uploadedAttachment: attachmentPayload({ sha256: artifact.sha256 }),
      });

      const result = await runHelper(
        uploadHelperPath,
        [artifact.file, "--title", "Artifact", "--chat-comment", "Here it is", "--output", "json"],
        buildEnv(baseUrl, artifact.stateDir, runId),
      );

      expect(result.code, result.stderr).toBe(0);
      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) {
        expect(request.runId).toBeUndefined();
      }
      expect(workProductBody(requests).createdByRunId).toBeNull();
      const receipt = JSON.parse(result.stdout) as {
        attachment: { id: string };
        workProduct: { id: string };
        chatComment: { id: string };
      };
      expect(receipt.attachment.id).toBe("attachment-1");
      expect(receipt.workProduct.id).toBe("work-product-1");
      expect(receipt.chatComment.id).toBe("comment-1");
    },
  );

  it("sends the run id header on every request when PAPERCLIP_RUN_ID is set", async () => {
    const artifact = await createArtifact();
    const { baseUrl, requests } = await startApi({
      uploadedAttachment: attachmentPayload({ sha256: artifact.sha256 }),
    });

    const result = await runHelper(
      uploadHelperPath,
      [artifact.file, "--title", "Artifact", "--chat-comment", "Here it is", "--output", "json"],
      buildEnv(baseUrl, artifact.stateDir, "test-run"),
    );

    expect(result.code, result.stderr).toBe(0);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.runId).toBe("test-run");
    }
    expect(workProductBody(requests).createdByRunId).toBe("test-run");
  });

  it("reuses an attachment that carries no originating run id", async () => {
    const artifact = await createArtifact();
    const { baseUrl, requests } = await startApi({
      existingAttachments: [
        attachmentPayload({ id: "attachment-existing", sha256: artifact.sha256 }),
      ],
    });

    const result = await runHelper(
      uploadHelperPath,
      [artifact.file, "--title", "Artifact", "--output", "json"],
      buildEnv(baseUrl, artifact.stateDir),
    );

    expect(result.code, result.stderr).toBe(0);
    const uploads = requests.filter(
      request =>
        request.method === "POST" &&
        request.url === `/api/companies/${companyId}/issues/${issueId}/attachments`,
    );
    expect(uploads).toHaveLength(0);
    const receipt = JSON.parse(result.stdout) as { attachment: { id: string } };
    expect(receipt.attachment.id).toBe("attachment-existing");
  });

  it.each(noRunIdCases)(
    "updates an issue without a run id header when PAPERCLIP_RUN_ID is %s",
    async (_label, runId) => {
      const artifact = await createArtifact();
      const { baseUrl, requests } = await startApi();

      const result = await runHelper(
        issueUpdateHelperPath,
        ["--issue-id", issueId, "--status", "done", "--comment", "closing note"],
        buildEnv(baseUrl, artifact.stateDir, runId),
      );

      expect(result.code, result.stderr).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe("PATCH");
      expect(requests[0]?.url).toBe(`/api/issues/${issueId}`);
      expect(requests[0]?.runId).toBeUndefined();
    },
  );

  it("sends the run id header on an issue update when PAPERCLIP_RUN_ID is set", async () => {
    const artifact = await createArtifact();
    const { baseUrl, requests } = await startApi();

    const result = await runHelper(
      issueUpdateHelperPath,
      ["--issue-id", issueId, "--status", "done", "--comment", "closing note"],
      buildEnv(baseUrl, artifact.stateDir, "test-run"),
    );

    expect(result.code, result.stderr).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.runId).toBe("test-run");
  });
});
