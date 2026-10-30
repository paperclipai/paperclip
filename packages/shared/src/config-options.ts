import {
  AUTH_BASE_URL_MODES,
  BIND_MODES,
  DEPLOYMENT_EXPOSURES,
  DEPLOYMENT_MODES,
  SECRET_PROVIDERS,
  STORAGE_PROVIDERS,
} from "./constants.js";

export type ConfigOptionDefinition = {
  key: string;
  type: string;
  validValues?: readonly string[];
  default?: string | number | boolean;
  description: string;
  optional?: boolean;
};

export type ConfigSectionDefinition = {
  section: string;
  label: string;
  description?: string;
  options: readonly ConfigOptionDefinition[];
};

export const DATABASE_OPTIONS: readonly ConfigOptionDefinition[] = [
  {
    key: "database.mode",
    type: "'embedded-postgres' | 'postgres'",
    validValues: ["embedded-postgres", "postgres"],
    default: "embedded-postgres",
    description: "Database mode: embedded PostgreSQL instance or external PostgreSQL",
  },
  {
    key: "database.connectionString",
    type: "string",
    optional: true,
    description: "PostgreSQL connection URL for external database (e.g. postgresql://user:pass@host:5432/dbname)",
  },
  {
    key: "database.embeddedPostgresDataDir",
    type: "string",
    default: "~/.paperclip/instances/default/db",
    description: "Data directory for embedded PostgreSQL",
  },
  {
    key: "database.embeddedPostgresPort",
    type: "number",
    default: 54329,
    description: "Port for embedded PostgreSQL server (1-65535)",
  },
  {
    key: "database.backup.enabled",
    type: "boolean",
    default: true,
    description: "Enable automated database backups",
  },
  {
    key: "database.backup.intervalMinutes",
    type: "number",
    default: 60,
    description: "Interval between backups in minutes (1-10080)",
  },
  {
    key: "database.backup.retentionDays",
    type: "number",
    default: 7,
    description: "Backup retention window in days (1-3650)",
  },
  {
    key: "database.backup.dir",
    type: "string",
    default: "~/.paperclip/instances/default/data/backups",
    description: "Directory where backups are stored",
  },
];

export const SERVER_OPTIONS: readonly ConfigOptionDefinition[] = [
  {
    key: "server.deploymentMode",
    type: "'local_trusted' | 'authenticated'",
    validValues: DEPLOYMENT_MODES,
    default: "local_trusted",
    description: "Deployment mode: local single-user or authenticated multi-user",
  },
  {
    key: "server.exposure",
    type: "'private' | 'public'",
    validValues: DEPLOYMENT_EXPOSURES,
    default: "private",
    description: "Network exposure level: private (local network/tailnet) or public (internet facing)",
  },
  {
    key: "server.bind",
    type: "'loopback' | 'lan' | 'tailnet' | 'custom'",
    validValues: BIND_MODES,
    optional: true,
    default: "loopback",
    description: "Network reachability preset: loopback (127.0.0.1), lan (0.0.0.0), tailnet (Tailscale IP), or custom",
  },
  {
    key: "server.customBindHost",
    type: "string",
    optional: true,
    description: "Custom host or IP to bind when server.bind is 'custom'",
  },
  {
    key: "server.host",
    type: "string",
    default: "127.0.0.1",
    description: "Resolved HTTP listening host address",
  },
  {
    key: "server.port",
    type: "number",
    default: 3100,
    description: "HTTP port for the Paperclip server (1-65535)",
  },
  {
    key: "server.allowedHostnames",
    type: "string[]",
    default: "[]",
    description: "Allowed Host header values for DNS rebinding protection",
  },
  {
    key: "server.serveUi",
    type: "boolean",
    default: true,
    description: "Serve the built-in web UI from the server",
  },
];

export const LOGGING_OPTIONS: readonly ConfigOptionDefinition[] = [
  {
    key: "logging.mode",
    type: "'file' | 'cloud'",
    validValues: ["file", "cloud"],
    default: "file",
    description: "Logging destination: file or cloud",
  },
  {
    key: "logging.logDir",
    type: "string",
    default: "~/.paperclip/instances/default/logs",
    description: "Directory where log files are stored when logging.mode is 'file'",
  },
];

export const LLM_OPTIONS: readonly ConfigOptionDefinition[] = [
  {
    key: "llm.provider",
    type: "'claude' | 'openai'",
    validValues: ["claude", "openai"],
    description: "Default LLM provider for agent orchestration",
  },
  {
    key: "llm.apiKey",
    type: "string",
    optional: true,
    description: "API key for the configured LLM provider",
  },
];

export const AUTH_OPTIONS: readonly ConfigOptionDefinition[] = [
  {
    key: "auth.baseUrlMode",
    type: "'auto' | 'explicit'",
    validValues: AUTH_BASE_URL_MODES,
    default: "auto",
    description: "How public auth URL is determined: auto (request headers) or explicit",
  },
  {
    key: "auth.publicBaseUrl",
    type: "string",
    optional: true,
    description: "Public base URL for auth redirects and invites (required when baseUrlMode is 'explicit')",
  },
  {
    key: "auth.disableSignUp",
    type: "boolean",
    default: false,
    description: "Disable public registration; new users require an invite",
  },
];

export const STORAGE_OPTIONS: readonly ConfigOptionDefinition[] = [
  {
    key: "storage.provider",
    type: "'local_disk' | 's3'",
    validValues: STORAGE_PROVIDERS,
    default: "local_disk",
    description: "File storage provider: local disk or Amazon S3 / S3-compatible",
  },
  {
    key: "storage.localDisk.baseDir",
    type: "string",
    default: "~/.paperclip/instances/default/data/storage",
    description: "Base directory for local disk storage",
  },
  {
    key: "storage.s3.bucket",
    type: "string",
    default: "paperclip",
    description: "S3 bucket name",
  },
  {
    key: "storage.s3.region",
    type: "string",
    default: "us-east-1",
    description: "S3 AWS region",
  },
  {
    key: "storage.s3.endpoint",
    type: "string",
    optional: true,
    description: "Custom S3 endpoint URL (for MinIO, Cloudflare R2, etc.)",
  },
  {
    key: "storage.s3.prefix",
    type: "string",
    default: "",
    description: "Key prefix for objects in the S3 bucket",
  },
  {
    key: "storage.s3.forcePathStyle",
    type: "boolean",
    default: false,
    description: "Use path-style URLs instead of virtual-hosted bucket URLs",
  },
];

export const SECRETS_OPTIONS: readonly ConfigOptionDefinition[] = [
  {
    key: "secrets.provider",
    type: "'local_encrypted' | 'aws_secrets_manager' | 'gcp_secret_manager' | 'vault'",
    validValues: SECRET_PROVIDERS,
    default: "local_encrypted",
    description: "Secrets management provider",
  },
  {
    key: "secrets.strictMode",
    type: "boolean",
    default: false,
    description: "Enforce strict secret resolution (fails if master key is missing)",
  },
  {
    key: "secrets.localEncrypted.keyFilePath",
    type: "string",
    default: "~/.paperclip/instances/default/secrets/master.key",
    description: "File path storing AES encryption key for local_encrypted secrets",
  },
];

export const TELEMETRY_OPTIONS: readonly ConfigOptionDefinition[] = [
  {
    key: "telemetry.enabled",
    type: "boolean",
    default: true,
    description: "Send anonymous usage telemetry to help improve Paperclip",
  },
];

export const UPDATES_OPTIONS: readonly ConfigOptionDefinition[] = [
  {
    key: "updates.checkEnabled",
    type: "boolean",
    default: true,
    description: "Check for new Paperclip releases on startup",
  },
];

export const META_OPTIONS: readonly ConfigOptionDefinition[] = [
  {
    key: "$meta.version",
    type: "1",
    default: 1,
    description: "Configuration schema version",
  },
  {
    key: "$meta.updatedAt",
    type: "string",
    description: "ISO 8601 timestamp of last configuration update",
  },
  {
    key: "$meta.source",
    type: "'onboard' | 'configure' | 'doctor'",
    validValues: ["onboard", "configure", "doctor"],
    description: "Tool or command that created or updated the configuration",
  },
];

export const CONFIG_SECTIONS: readonly ConfigSectionDefinition[] = [
  {
    section: "database",
    label: "Database",
    description: "PostgreSQL database storage configuration",
    options: DATABASE_OPTIONS,
  },
  {
    section: "server",
    label: "Server",
    description: "Network binding, exposure, host, and port settings",
    options: SERVER_OPTIONS,
  },
  {
    section: "logging",
    label: "Logging",
    description: "Log destination and output directories",
    options: LOGGING_OPTIONS,
  },
  {
    section: "llm",
    label: "LLM Provider",
    description: "Default LLM provider and credentials",
    options: LLM_OPTIONS,
  },
  {
    section: "auth",
    label: "Authentication",
    description: "Public base URL and signup policy",
    options: AUTH_OPTIONS,
  },
  {
    section: "storage",
    label: "Storage",
    description: "Local disk or S3 file storage backend",
    options: STORAGE_OPTIONS,
  },
  {
    section: "secrets",
    label: "Secrets",
    description: "Encryption key and secret manager backend",
    options: SECRETS_OPTIONS,
  },
  {
    section: "telemetry",
    label: "Telemetry",
    description: "Anonymous usage statistics reporting",
    options: TELEMETRY_OPTIONS,
  },
  {
    section: "updates",
    label: "Updates",
    description: "Automatic update checking",
    options: UPDATES_OPTIONS,
  },
];

export const CONFIG_SECTION_NAMES: readonly string[] = CONFIG_SECTIONS.map((s) => s.section);

export function getConfigSection(name: string): ConfigSectionDefinition | undefined {
  const normalized = name.toLowerCase().trim();
  return CONFIG_SECTIONS.find((s) => s.section === normalized);
}

export function formatOptionLine(opt: ConfigOptionDefinition): string {
  const defaultPart = opt.default !== undefined ? ` (default: ${JSON.stringify(opt.default)})` : "";
  const optionalPart = opt.optional ? " (optional)" : "";
  return `${opt.key}: ${opt.type}${defaultPart}${optionalPart}\n  ${opt.description}`;
}

export function formatSectionOptions(section: ConfigSectionDefinition): string {
  const lines: string[] = [
    `Section: ${section.section} (${section.label})`,
    ...section.options.map((opt) => `  ${formatOptionLine(opt).replace(/\n/g, "\n  ")}`),
  ];
  return lines.join("\n");
}

export function formatAllConfigOptions(): string {
  return CONFIG_SECTIONS.map((section) => formatSectionOptions(section)).join("\n\n");
}
