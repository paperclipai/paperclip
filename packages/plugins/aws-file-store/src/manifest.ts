import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, PLUGIN_ID, PLUGIN_VERSION, TOOL_NAMES } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "AWS File Store",
  description:
    "S3-backed hierarchical file storage for agents and users, powered by the AWS SDK. " +
    "Each organization gets two root directories: knowledge-base (curated docs agents use) " +
    "and income (incoming files to triage and convert). " +
    "Supports AWS S3, MinIO, and any S3-compatible backend.",
  author: "Paperclip",
  categories: ["automation", "connector"],
  capabilities: [
    "companies.read",
    "projects.read",
    "issues.read",
    "agents.read",
    "activity.log.write",
    "metrics.write",
    "plugin.state.read",
    "plugin.state.write",
    "events.emit",
    "agent.tools.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      s3Bucket: {
        type: "string",
        title: "S3 Bucket",
        description: "S3 bucket name.",
        default: DEFAULT_CONFIG.s3Bucket,
      },
      s3Region: {
        type: "string",
        title: "S3 Region",
        description: "AWS region or MinIO region.",
        default: DEFAULT_CONFIG.s3Region,
      },
      s3Endpoint: {
        type: "string",
        title: "S3 Endpoint URL",
        description:
          "Custom endpoint for S3-compatible services (e.g. http://localhost:9000 for MinIO). " +
          "Leave empty for AWS S3.",
        default: DEFAULT_CONFIG.s3Endpoint,
      },
      s3Prefix: {
        type: "string",
        title: "S3 Key Prefix",
        description:
          "Prefix for all object keys in the bucket (e.g. 'file-store'). " +
          "Allows sharing a bucket with other services.",
        default: DEFAULT_CONFIG.s3Prefix,
      },
      s3ForcePathStyle: {
        type: "boolean",
        title: "S3 Force Path Style",
        description:
          "Use path-style URLs (required for MinIO). Set to false for AWS S3 virtual-hosted style.",
        default: DEFAULT_CONFIG.s3ForcePathStyle,
      },
      s3AccessKeyId: {
        type: "string",
        title: "S3 Access Key ID",
        description:
          "Access key for S3/MinIO. If empty, uses AWS default credential chain " +
          "(AWS_ACCESS_KEY_ID env var, IAM role, etc.).",
      },
      s3SecretAccessKey: {
        type: "string",
        title: "S3 Secret Access Key",
        description:
          "Secret key for S3/MinIO. If empty, uses AWS default credential chain.",
      },
      maxFileSizeMb: {
        type: "number",
        title: "Max File Size (MB)",
        description: "Maximum allowed file size in megabytes.",
        default: DEFAULT_CONFIG.maxFileSizeMb,
      },
      maxTreeDepth: {
        type: "number",
        title: "Max Tree Depth",
        description: "Maximum directory depth shown by the fs-tree tool.",
        default: DEFAULT_CONFIG.maxTreeDepth,
      },
    },
  },
  tools: [
    {
      name: TOOL_NAMES.writeFile,
      displayName: "Write File to Shared Store",
      description:
        "Writes content to a file in the shared S3 store. " +
        "Creates parent directories automatically. " +
        "Paths are scoped to the organization: '<org>/knowledge-base/...' or '<org>/income/...'. " +
        "Supports text content and base64-encoded binary.",
      parametersSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Destination path within the store (e.g. 'acme/knowledge-base/specs/auth.md'). " +
              "Forward slashes only. Parent directories are created automatically.",
          },
          content: {
            type: "string",
            description: "File content. Plain text for text files, base64 for binary.",
          },
          encoding: {
            type: "string",
            enum: ["utf-8", "base64"],
            description: "Content encoding. Defaults to 'utf-8'.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional tags for categorization (e.g. ['report', 'q1-2026', 'finance']).",
          },
          description: {
            type: "string",
            description: "Optional human-readable description of the file.",
          },
          overwrite: {
            type: "boolean",
            description: "If false, fails when file already exists. Defaults to true.",
          },
        },
        required: ["path", "content"],
      },
    },
    {
      name: TOOL_NAMES.readFile,
      displayName: "Read File from Shared Store",
      description:
        "Reads a file from the shared store. Returns text content for text files " +
        "or base64 for binary files.",
      parametersSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file within the store.",
          },
        },
        required: ["path"],
      },
    },
    {
      name: TOOL_NAMES.listDir,
      displayName: "List Directory Contents",
      description:
        "Lists files and subdirectories at a given path in the shared store. " +
        "Returns names, types, sizes, and metadata.",
      parametersSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path within the store. Use '/' or '' for root.",
          },
          recursive: {
            type: "boolean",
            description: "If true, lists all descendants recursively. Defaults to false.",
          },
        },
        required: ["path"],
      },
    },
    {
      name: TOOL_NAMES.treeDir,
      displayName: "Show Directory Tree",
      description:
        "Displays a visual tree of the shared store hierarchy. " +
        "Useful for understanding the current folder structure.",
      parametersSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Root path for the tree. Use '/' or '' for the entire store.",
          },
          maxDepth: {
            type: "number",
            description: "Maximum depth to display. Defaults to config value.",
          },
        },
      },
    },
    {
      name: TOOL_NAMES.mkdir,
      displayName: "Create Directory",
      description:
        "Creates a directory (and any missing parents) in the shared store. " +
        "Use to pre-create folder structures.",
      parametersSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path to create (e.g. 'acme/knowledge-base/specs').",
          },
        },
        required: ["path"],
      },
    },
    {
      name: TOOL_NAMES.move,
      displayName: "Move / Rename File or Directory",
      description: "Moves or renames a file or directory within the shared store.",
      parametersSchema: {
        type: "object",
        properties: {
          from: {
            type: "string",
            description: "Current path of the file or directory.",
          },
          to: {
            type: "string",
            description: "New path for the file or directory.",
          },
        },
        required: ["from", "to"],
      },
    },
    {
      name: TOOL_NAMES.remove,
      displayName: "Remove File or Directory",
      description:
        "Removes a file or empty directory from the shared store. " +
        "Use 'recursive: true' to remove non-empty directories.",
      parametersSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to remove.",
          },
          recursive: {
            type: "boolean",
            description: "If true, removes directories with contents. Defaults to false.",
          },
        },
        required: ["path"],
      },
    },
    {
      name: TOOL_NAMES.stat,
      displayName: "Get File / Directory Info",
      description:
        "Returns metadata about a file or directory: size, type, timestamps, tags, description.",
      parametersSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to inspect.",
          },
        },
        required: ["path"],
      },
    },
    {
      name: TOOL_NAMES.search,
      displayName: "Search Files in Store",
      description: "Searches for files by name pattern, tags, or content substring.",
      parametersSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query — matched against file names and descriptions.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Filter by tags (files must have ALL specified tags).",
          },
          path: {
            type: "string",
            description: "Limit search to this directory subtree.",
          },
          namePattern: {
            type: "string",
            description: "Glob pattern for file names (e.g. '*.md', 'report-*').",
          },
        },
      },
    },
  ],
};

export default manifest;
