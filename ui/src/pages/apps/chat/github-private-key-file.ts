import { t as translate } from "@/i18n";
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
      translate("connections:that_file_is_empty_choose_the_private_ae4c7a1"),
    );
  }
  if (file.size > GITHUB_PRIVATE_KEY_FILE_MAX_BYTES) {
    throw new Error(
      translate("connections:that_file_is_too_large_choose_a_3a16e5c"),
    );
  }

  let value: string;
  try {
    value = await file.text();
  } catch {
    throw new Error(
      translate("connections:paperclip_couldn_t_read_that_file_choose_4787014"),
    );
  }
  if (!value.trim()) {
    throw new Error(
      translate("connections:that_file_is_empty_choose_the_private_ae4c7a1"),
    );
  }
  return value;
}
