import { ConnectionSetupFlow } from "@/features/connections/ConnectionSetupFlow";
import type { ToolConnectionCredentialSource } from "@paperclipai/shared";

export {
  AccessStep,
  OAuthConnectStateScreen,
  type OAuthConnectPhase,
} from "@/features/connections/ConnectionSetupFlow";

/** Full-page host for the shared connection setup implementation. */
export function AppsConnect({
  byoOnly = false,
  credentialSource = "paperclip_vault",
}: {
  byoOnly?: boolean;
  credentialSource?: ToolConnectionCredentialSource;
} = {}) {
  return <ConnectionSetupFlow byoOnly={byoOnly} credentialSource={credentialSource} host="page" />;
}
