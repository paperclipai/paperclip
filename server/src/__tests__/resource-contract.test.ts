import { describe, expect, it } from "vitest";
import { createResourceSchema, workflowResourceManifestSchema } from "@paperclipai/shared";

describe("resource contracts", () => {
  it("accepts Git resource configuration and defaults", () => {
    expect(createResourceSchema.parse({
      key: "platform_code",
      repository: "https://github.com/example/platform.git",
      mountPath: "platform_code",
    })).toMatchObject({ type: "git", defaultRef: "main", labels: {} });
  });

  it("rejects unsafe mount paths", () => {
    expect(createResourceSchema.safeParse({
      key: "unsafe",
      repository: "/tmp/repo",
      mountPath: "../outside",
    }).success).toBe(false);
    expect(createResourceSchema.safeParse({
      key: "dot-prefixed",
      repository: "/tmp/repo",
      mountPath: "./repo",
    }).success).toBe(false);
  });

  it("rejects unsupported Git repository transports", () => {
    expect(createResourceSchema.safeParse({ key: "http", repository: "http://github.com/example/repo.git", mountPath: "repo" }).success).toBe(false);
    expect(createResourceSchema.safeParse({ key: "ext", repository: "ext::ssh host sh -c command", mountPath: "repo" }).success).toBe(false);
    expect(createResourceSchema.safeParse({ key: "git", repository: "git://internal.example/repo.git", mountPath: "repo" }).success).toBe(false);
    expect(createResourceSchema.safeParse({ key: "embedded", repository: "https://user:secret@github.com/example/repo.git", mountPath: "repo" }).success).toBe(false);
    expect(createResourceSchema.safeParse({ key: "ssh", repository: "git@github.com:example/repo.git", mountPath: "repo" }).success).toBe(true);
    expect(createResourceSchema.safeParse({ key: "local", repository: "/tmp/repo", mountPath: "repo" }).success).toBe(true);
    expect(createResourceSchema.safeParse({ key: "empty-source", repository: "/tmp/repo", sourcePath: "", mountPath: "repo" }).success).toBe(false);
  });

  it("rejects duplicate manifest attachments", () => {
    const resourceId = "00000000-0000-4000-8000-000000000001";
    expect(workflowResourceManifestSchema.safeParse({
      version: 1,
      resources: [
        { resourceId, mode: "input" },
        { resourceId, mode: "output" },
      ],
    }).success).toBe(false);
  });
});
