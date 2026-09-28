import { loadConnectorConfig, ConnectorConfigError } from "./config.js";
import { CONNECTOR_VERSION, ConnectorFatalError, McpConnectorClient, defaultLogger } from "./connector.js";

const USAGE = `paperclip-mcp-connector ${CONNECTOR_VERSION}

Usage:
  paperclip-mcp-connector [run] [--config <file>]   Enroll if needed, then relay MCP traffic
  paperclip-mcp-connector enroll [--config <file>]  Exchange the enrollment token and exit
  paperclip-mcp-connector rotate [--config <file>]  Rotate the stored credential and exit

Environment:
  PAPERCLIP_URL                                Paperclip public URL (required)
  PAPERCLIP_MCP_CONNECTOR_CONFIG               JSON config file (optional)
  PAPERCLIP_MCP_CONNECTOR_ENROLLMENT_TOKEN     One-time token from Tools & Access
  PAPERCLIP_MCP_CONNECTOR_CREDENTIALS_FILE     Where the credential is stored (mode 0600)
  PAPERCLIP_MCP_CONNECTOR_UPSTREAMS            name=url,name=url or a JSON object
`;

async function main(argv: string[]): Promise<number> {
  let command = "run";
  let configPath: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--config") configPath = argv[++i] ?? null;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(USAGE);
      return 0;
    } else if (arg === "--version") {
      process.stdout.write(`${CONNECTOR_VERSION}\n`);
      return 0;
    } else if (["run", "enroll", "rotate"].includes(arg)) command = arg;
    else {
      process.stderr.write(`Unknown argument: ${arg}\n\n${USAGE}`);
      return 2;
    }
  }
  const config = loadConnectorConfig({ configPath });
  const client = new McpConnectorClient({ config });
  if (command === "enroll") {
    await client.ensureCredentials();
    return 0;
  }
  if (command === "rotate") {
    await client.rotateCredential();
    return 0;
  }
  const stop = () => client.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await client.run();
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof ConnectorConfigError || error instanceof ConnectorFatalError) {
      defaultLogger("error", error.message);
      process.exit(error instanceof ConnectorConfigError ? 2 : 3);
    }
    defaultLogger("error", "connector crashed", { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  },
);
