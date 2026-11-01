import { z } from "zod";

const oauthCredentialsSchema = z.object({
  clientId: z.string().trim().min(1),
  clientSecret: z.string().trim().min(1),
  refreshToken: z.string().trim().min(1),
});

export type GmailOAuthCredentials = z.infer<typeof oauthCredentialsSchema>;

export interface GmailMcpConfig {
  credentials: GmailOAuthCredentials;
  secretRedactions: string[];
}

export interface GmailMcpConfigInput {
  clientId?: string | null;
  clientSecret?: string | null;
  refreshToken?: string | null;
}

function parseArgs(argv: string[]): GmailMcpConfigInput {
  const input: GmailMcpConfigInput = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return next;
    };
    if (arg === "--client-id") input.clientId = readValue();
    if (arg === "--client-secret") input.clientSecret = readValue();
    if (arg === "--refresh-token") input.refreshToken = readValue();
  }
  return input;
}

export function createGmailMcpConfig(input: GmailMcpConfigInput): GmailMcpConfig {
  const credentials = oauthCredentialsSchema.parse({
    clientId: input.clientId ?? "",
    clientSecret: input.clientSecret ?? "",
    refreshToken: input.refreshToken ?? "",
  });
  return {
    credentials,
    secretRedactions: [credentials.clientSecret, credentials.refreshToken].filter(
      (value) => value.length >= 8,
    ),
  };
}

export function readConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
): GmailMcpConfig {
  const args = parseArgs(argv);
  try {
    return createGmailMcpConfig({
      clientId: args.clientId ?? env.GMAIL_CLIENT_ID,
      clientSecret: args.clientSecret ?? env.GMAIL_CLIENT_SECRET,
      refreshToken: args.refreshToken ?? env.GMAIL_REFRESH_TOKEN,
    });
  } catch {
    throw new Error(
      "Gmail OAuth credentials are required. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN " +
        "(a user-consented OAuth refresh token for the GA Gmail API — this server never performs the consent flow itself).",
    );
  }
}
