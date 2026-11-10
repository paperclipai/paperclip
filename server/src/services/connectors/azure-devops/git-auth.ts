import { forbidden } from "../../../errors.js";
import type { GitAuthInvocation } from "../../git-credentials.js";

const AZURE_GIT_HELPER = `!f() { proto=; host=; path=; while IFS= read -r l && [ -n "$l" ]; do case "$l" in protocol=*) proto=\${l#protocol=};; host=*) host=\${l#host=};; path=*) path=\${l#path=};; esac; done; if [ "$1" = get ] && [ "$proto" = https ] && [ "$host" = dev.azure.com ] && [ "$path" = "$PAPERCLIP_AZURE_GIT_PATH" ]; then printf 'username=paperclip\\npassword=%s\\n' "$PAPERCLIP_AZURE_GIT_TOKEN"; fi; }; f`;

/** Prepare ephemeral credentials for a single Azure DevOps Services Git remote. */
export function azureDevOpsGitInvocation(remote: string, credential: { kind: "pat" | "entra"; token: string }): GitAuthInvocation {
  let url: URL;
  try { url = new URL(remote); } catch { throw forbidden("Azure DevOps repository URL is invalid"); }
  if (url.protocol !== "https:" || url.hostname !== "dev.azure.com" || url.port || url.username || url.password || url.search || url.hash ||
      !/^\/[A-Za-z0-9][A-Za-z0-9-]{0,49}\/[^/]+\/_git\/[^/]+\/?$/.test(url.pathname) ||
      !credential.token || credential.token.length > 4096 || /[\0\r\n]/.test(credential.token) || credential.token.startsWith("secret://"))
    throw forbidden("Azure DevOps Git authorization is unavailable");
  const repositoryPath = url.pathname.replace(/^\//, "").replace(/\/$/, "");
  let credentialPath: string;
  try {
    const segments = repositoryPath.split("/").map(decodeURIComponent);
    if (segments.some((part) => !part || part === "." || part === ".." || /[\\/\u0000-\u001f\u007f]/.test(part))) throw new Error("invalid path");
    credentialPath = segments.join("/");
  } catch { throw forbidden("Azure DevOps repository URL is invalid"); }
  const configEntries: Array<[string, string]> = [
    ["credential.helper", ""],
    ["credential.useHttpPath", "true"],
    ["credential.interactive", "false"],
    ["core.askPass", ""],
    ["http.followRedirects", "false"],
    ...(credential.kind === "pat"
      ? [["credential.https://dev.azure.com.helper", AZURE_GIT_HELPER] as [string, string]]
      : [[`http.https://dev.azure.com/${repositoryPath}.extraheader`, `AUTHORIZATION: bearer ${credential.token}`] as [string, string]]),
  ];
  return {
    configArgs: [], source: "managed_connection", secretName: null,
    repositoryAuthority: { provider: "azure-devops", url: url.href.replace(/\/$/, "") },
    env: {
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "",
      GIT_CONFIG_COUNT: String(configEntries.length),
      ...Object.fromEntries(configEntries.flatMap(([key, value], index) => [[`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value]])),
      ...(credential.kind === "pat" ? { PAPERCLIP_AZURE_GIT_PATH: credentialPath, PAPERCLIP_AZURE_GIT_TOKEN: credential.token } : {}),
    },
  };
}
