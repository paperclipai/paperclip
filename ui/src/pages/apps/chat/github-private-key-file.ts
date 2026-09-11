export const GITHUB_PRIVATE_KEY_FILE_MAX_BYTES = 64 * 1024;

export class GitHubPrivateKeyFileError extends Error {
  constructor(message: string, readonly messageKey: string) {
    super(message);
  }
}

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
    throw new GitHubPrivateKeyFileError(
      "That file is empty. Choose the private key downloaded from your GitHub App.",
      "chatUi.privateKeyEmpty",
    );
  }
  if (file.size > GITHUB_PRIVATE_KEY_FILE_MAX_BYTES) {
    throw new GitHubPrivateKeyFileError(
      "That file is too large. Choose a GitHub App private key smaller than 64 KB.",
      "chatUi.privateKeyTooLarge",
    );
  }

  let value: string;
  try {
    value = await file.text();
  } catch {
    throw new GitHubPrivateKeyFileError(
      "Paperclip couldn't read that file. Choose the .pem file again or paste the private key.",
      "chatUi.chatEndpointSetup.paperclipCouldnTReadThatFileChooseThePemFile",
    );
  }
  if (!value.trim()) {
    throw new GitHubPrivateKeyFileError(
      "That file is empty. Choose the private key downloaded from your GitHub App.",
      "chatUi.privateKeyEmpty",
    );
  }
  return value;
}
