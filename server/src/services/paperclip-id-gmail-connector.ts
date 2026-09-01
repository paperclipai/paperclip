/**
 * @deprecated Paperclip ID is identity-only. Import the Paperclip Cloud
 * connector names from `paperclip-cloud-connector.ts` for new code.
 *
 * These aliases keep source compatibility while deployments and persisted app
 * definitions move from the former Paperclip ID broker prototype.
 */
export {
  GMAIL_CONNECTOR_SCOPES,
  GMAIL_MCP_URL,
  GOOGLE_WORKSPACE_CONNECTOR_PROFILES,
  PaperclipCloudConnectorError as PaperclipIdConnectorError,
  createPaperclipCloudConnector as createPaperclipIdGmailConnector,
  paperclipCloudConnectorCapabilitiesFromEnv as paperclipIdGoogleConnectorCapabilitiesFromEnv,
  paperclipCloudConnectorConfigFromEnv as paperclipIdGmailConnectorConfigFromEnv,
} from "./paperclip-cloud-connector.js";

export type {
  PaperclipCloudConnector as PaperclipIdGmailConnector,
  PaperclipCloudConnector as PaperclipIdGoogleWorkspaceConnector,
  PaperclipCloudConnectorConfig as PaperclipIdGmailConnectorConfig,
  PaperclipCloudConnectorEnvironment as PaperclipIdConnectorEnvironment,
  PaperclipCloudConnectorOperation as PaperclipIdConnectorOperation,
  SealedGmailCredentials,
  SealedGoogleWorkspaceCredentials,
} from "./paperclip-cloud-connector.js";
