export function shouldLoadWorkingDirectoryEnv(input: {
  cwdEnvExists: boolean;
  isPaperclipEnvFile: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const env = input.env ?? process.env;
  return env.PAPERCLIP_DISABLE_CWD_ENV_FILE !== "true"
    && input.cwdEnvExists
    && !input.isPaperclipEnvFile;
}
