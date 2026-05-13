import { describe, expect, it } from "vitest";
import { FastUploadInterceptor } from "../../src/upload-interceptor.js";

describe("FastUploadInterceptor", () => {
  it("collapses the adapter-utils chunked upload protocol into one flush", () => {
    const interceptor = new FastUploadInterceptor();
    const target = "/workspace/.paperclip-runtime/skills.tar";
    const chunkA = Buffer.from("hello ").toString("base64").slice(0, 4);
    const chunkB = Buffer.from("hello ").toString("base64").slice(4) + Buffer.from("world").toString("base64");

    expect(
      interceptor.decide(
        `mkdir -p '/workspace/.paperclip-runtime' && rm -f '${target}.paperclip-upload.b64' && : > '${target}.paperclip-upload.b64'`,
      ),
    ).toMatchObject({ action: "ack" });
    expect(interceptor.pendingCount).toBe(1);

    expect(
      interceptor.decide(`printf '%s' '${chunkA}' >> '${target}.paperclip-upload.b64'`),
    ).toMatchObject({ action: "ack" });
    expect(
      interceptor.decide(`printf '%s' '${chunkB}' >> '${target}.paperclip-upload.b64'`),
    ).toMatchObject({ action: "ack" });

    const decision = interceptor.decide(
      `base64 -d < '${target}.paperclip-upload.b64' > '${target}' && rm -f '${target}.paperclip-upload.b64'`,
    );
    expect(decision.action).toBe("flush");
    if (decision.action !== "flush") throw new Error("expected flush");
    expect(decision.flush.targetPath).toBe(target);
    expect(decision.flush.payload.toString("utf8")).toBe("hello world");
    expect(interceptor.pendingCount).toBe(0);
  });

  it("passes through chunks and finalizers without a matching init", () => {
    const interceptor = new FastUploadInterceptor();
    const target = "/workspace/file.bin";

    expect(
      interceptor.decide(`printf '%s' 'aGVsbG8=' >> '${target}.paperclip-upload.b64'`),
    ).toMatchObject({ action: "passthrough", reason: "chunk without prior init" });
    expect(
      interceptor.decide(
        `base64 -d < '${target}.paperclip-upload.b64' > '${target}' && rm -f '${target}.paperclip-upload.b64'`,
      ),
    ).toMatchObject({ action: "passthrough", reason: "finalize without buffered state" });
  });

  it("falls through when the init command does not match the target parent directory", () => {
    const interceptor = new FastUploadInterceptor();

    expect(
      interceptor.decide(
        "mkdir -p '/tmp' && rm -f '/workspace/file.bin.paperclip-upload.b64' && : > '/workspace/file.bin.paperclip-upload.b64'",
      ),
    ).toMatchObject({ action: "passthrough", reason: "init dir/target mismatch" });
    expect(interceptor.pendingCount).toBe(0);
  });

  it("fails fast instead of falling through after acknowledged chunks exceed the buffer cap", () => {
    const interceptor = new FastUploadInterceptor(1);
    const target = "/workspace/file.bin";

    expect(
      interceptor.decide(
        `mkdir -p '/workspace' && rm -f '${target}.paperclip-upload.b64' && : > '${target}.paperclip-upload.b64'`,
      ),
    ).toMatchObject({ action: "ack" });

    const decision = interceptor.decide(`printf '%s' 'AAAA' >> '${target}.paperclip-upload.b64'`);
    expect(decision).toMatchObject({
      action: "error",
      message: expect.stringContaining("Fast upload buffer cap exceeded"),
    });
    expect(interceptor.pendingCount).toBe(0);
  });

  it("clears buffered uploads on reset", () => {
    const interceptor = new FastUploadInterceptor();
    const target = "/workspace/file.bin";

    interceptor.decide(
      `mkdir -p '/workspace' && rm -f '${target}.paperclip-upload.b64' && : > '${target}.paperclip-upload.b64'`,
    );
    expect(interceptor.pendingCount).toBe(1);

    interceptor.reset();
    expect(interceptor.pendingCount).toBe(0);
  });
});
