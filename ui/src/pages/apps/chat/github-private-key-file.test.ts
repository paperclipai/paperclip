import { describe, expect, it } from "vitest";
import {
  createGitHubPrivateKeyReadGuard,
  GITHUB_PRIVATE_KEY_FILE_MAX_BYTES,
  readGitHubPrivateKeyFile,
} from "./github-private-key-file";

describe("readGitHubPrivateKeyFile", () => {
  it("preserves the downloaded PEM line breaks exactly", async () => {
    const value =
      "-----BEGIN PRIVATE KEY-----\r\nlocal-test-key\r\n-----END PRIVATE KEY-----\r\n";

    await expect(
      readGitHubPrivateKeyFile({
        size: value.length,
        text: async () => value,
      }),
    ).resolves.toBe(value);
  });

  it("rejects empty and oversized files without including file metadata", async () => {
    await expect(
      readGitHubPrivateKeyFile({ size: 0, text: async () => "" }),
    ).rejects.toThrow(
      "That file is empty. Choose the private key downloaded from your GitHub App.",
    );
    await expect(
      readGitHubPrivateKeyFile({
        size: GITHUB_PRIVATE_KEY_FILE_MAX_BYTES + 1,
        text: async () => "not-read",
      }),
    ).rejects.toThrow(
      "That file is too large. Choose a GitHub App private key smaller than 64 KB.",
    );
  });

  it("turns a local read failure into generic actionable copy", async () => {
    await expect(
      readGitHubPrivateKeyFile({
        size: 1,
        text: async () => {
          throw new Error("/Users/example/Downloads/sensitive-name.pem");
        },
      }),
    ).rejects.toThrow(
      "Paperclip couldn't read that file. Choose the .pem file again or paste the private key.",
    );
  });

  it("lets only the latest file read settle and lets paste invalidate it", () => {
    const guard = createGitHubPrivateKeyReadGuard();
    const firstFile = guard.start();
    const secondFile = guard.start();

    expect(guard.isCurrent(firstFile)).toBe(false);
    expect(guard.isCurrent(secondFile)).toBe(true);

    guard.invalidate();
    expect(guard.isCurrent(secondFile)).toBe(false);
  });
});
