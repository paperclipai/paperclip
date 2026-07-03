import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { generateCodexIssueImage } from "../services/codex-image-generation.ts";

const cleanupDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(Array.from(cleanupDirs, (dir) => fs.rm(dir, { recursive: true, force: true })));
  cleanupDirs.clear();
});

describe("generateCodexIssueImage", () => {
  it("passes reference images to Codex and reads the generated image from CODEX_HOME", async () => {
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-image-paperclip-home-"));
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-image-home-"));
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(codexHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    await fs.writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
    const threadId = "019f286b-9bae-7961-bb48-e5c658f53427";

    const runProcess = vi.fn<typeof runChildProcess>(
      async (_runId, command, args, opts) => {
        expect(command).toBe("codex");
        expect(opts.env.CODEX_HOME).toContain(path.join(paperclipHome, "instances", "default", "data", "codex-image-runtime"));
        expect(opts.env.OPENAI_API_KEY).toBe("");
        await expect(fs.readlink(path.join(opts.env.CODEX_HOME, "auth.json"))).resolves.toBe(path.join(codexHome, "auth.json"));
        expect(args).toContain("--image");
        expect(args).toContain("--ignore-user-config");
        expect(args).toContain("--model");
        expect(args).toContain("gpt-5.5");
        const imageArgIndex = args.indexOf("--image");
        const imagePath = args[imageArgIndex + 1];
        expect(imagePath).toBeTruthy();
        await expect(fs.readFile(String(imagePath), "utf8")).resolves.toBe("PNGDATA");
        expect(String(opts.stdin)).toContain("Use those attached image inputs as visual references");

        const outputDir = path.join(opts.env.CODEX_HOME, "generated_images", threadId);
        await fs.mkdir(outputDir, { recursive: true });
        await fs.writeFile(path.join(outputDir, "ig_test.png"), Buffer.from("generated-png"));
        return {
          exitCode: 0,
          signal: null,
          stdout: `${JSON.stringify({ type: "thread.started", thread_id: threadId })}\n`,
          stderr: "",
          timedOut: false,
          pid: 123,
          startedAt: "2026-01-01T00:00:00.000Z",
        };
      },
    );

    try {
      const result = await generateCodexIssueImage({
        companyId: "company-1",
        prompt: "Generate a cafe founder carousel image.",
        size: "1080x1350",
        quality: "high",
        codexHome,
        references: [{
          attachmentId: "2d8a654e-2ece-43cf-9000-ab0fe254e1a6",
          filename: "foto_event.png",
          contentType: "image/png",
          bytes: Buffer.from("PNGDATA"),
        }],
        runProcess,
      });

      expect(result.provider).toBe("codex_native");
      expect(result.model).toBe("gpt-image-2");
      expect(result.generationMode).toBe("reference_backed");
      expect(result.actualImageInputsBound).toEqual(["2d8a654e-2ece-43cf-9000-ab0fe254e1a6"]);
      expect(result.codexThreadId).toBe(threadId);
      expect(result.outputBytes.toString()).toBe("generated-png");
    } finally {
      if (previousPaperclipHome === undefined) {
        delete process.env.PAPERCLIP_HOME;
      } else {
        process.env.PAPERCLIP_HOME = previousPaperclipHome;
      }
    }
  });
});
