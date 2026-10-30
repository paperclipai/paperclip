export const GITHUB_PRIVATE_KEY_FILE_MAX_BYTES = 64 * 1024;

export function createGitHubPrivateKeyReadGuard() {
  let revision = 0;
  return {
    start() {
      revision += 1;
      return revision;
    },
    invalidate() {
      revision += 1;
    },
    isCurrent(candidate: number) {
      return candidate === revision;
    },
  };
}

export async function readGitHubPrivateKeyFile(
  file: Pick<File, "size" | "text">,
): Promise<string> {
  if (file.size === 0) {
    throw new Error(
      "That file is empty. Choose the private key downloaded from your GitHub App.",
    );
  }
  if (file.size > GITHUB_PRIVATE_KEY_FILE_MAX_BYTES) {
    throw new Error(
      "That file is too large. Choose a GitHub App private key smaller than 64 KB.",
    );
  }

  let value: string;
  try {
    value = await file.text();
  } catch {
    throw new Error(
      "Paperclip couldn't read that file. Choose the .pem file again or paste the private key.",
    );
  }
  if (!value.trim()) {
    throw new Error(
      "That file is empty. Choose the private key downloaded from your GitHub App.",
    );
  }
  return value;
}
