// Generated from acpx-profiles.json and cursor-distributions.json. Do not edit.
export const QUALIFIED_ACPX_VERSION = "0.13.1" as const;
export const ACPX_DRIVER_KIND = "acpx_runtime" as const;
export const ACPX_DRIVER_PROTOCOL_VERSION = 1 as const;

export const QUALIFIED_ACPX_PROFILE_DATA = {
  "antigravity": {
    "driverKind": "acpx_runtime",
    "protocolVersion": 1,
    "acpxVersion": "0.13.1",
    "agent": "antigravity",
    "agentProfileVersion": 1,
    "agentServerPackage": "native:antigravity-acp",
    "agentServerVersion": "1.4.3",
    "agentRuntimePackage": "native:antigravity-localharness",
    "agentRuntimeVersion": "1.4.3",
    "commandDigest": "sha256:acf5f574b6b9ec4388ff9d081890caa330e66bf1ae3fe3b08e7f0fb0e851b9ce",
    "qualificationStatus": "pending",
    "permissionPolicy": "interactive"
  },
  "grok": {
    "driverKind": "acpx_runtime",
    "protocolVersion": 1,
    "acpxVersion": "0.13.1",
    "agent": "grok",
    "agentProfileVersion": 20,
    "agentServerPackage": "builtin:grok-acp",
    "agentServerVersion": "1",
    "agentRuntimePackage": "native:grok",
    "agentRuntimeVersion": "1.0.13",
    "commandDigest": "sha256:f0b698395a3704ed2ffaf84ea19bdb20c36c8a0a70b7c629c7b6ffe144e59e55",
    "permissionPolicy": "interactive"
  },
  "pi": {
    "driverKind": "acpx_runtime",
    "protocolVersion": 1,
    "acpxVersion": "0.13.1",
    "agent": "pi",
    "agentProfileVersion": 37,
    "agentServerPackage": "pi-acp",
    "agentServerVersion": "0.0.33",
    "agentRuntimePackage": "@earendil-works/pi-coding-agent",
    "agentRuntimeVersion": "1.0.0",
    "commandDigest": "sha256:4a555c1d8622addaeb1a02c1bddc5554ce81a316f98e7120029aad990e44d9dd",
    "permissionPolicy": "interactive"
  },
  "cursor": {
    "driverKind": "acpx_runtime",
    "protocolVersion": 1,
    "acpxVersion": "0.13.1",
    "agent": "cursor",
    "agentProfileVersion": 16,
    "agentServerPackage": "cursor-agent",
    "agentServerVersion": "2026.09.26-dd393fe",
    "agentRuntimePackage": null,
    "agentRuntimeVersion": null,
    "commandDigest": "sha256:759e7415fea8ed2b6b0e6f362b57652b8768835f9d1fdae4a94c1b5eb3669301",
    "permissionPolicy": "interactive"
  },
  "copilot": {
    "driverKind": "acpx_runtime",
    "protocolVersion": 1,
    "acpxVersion": "0.13.1",
    "agent": "copilot",
    "agentProfileVersion": 92,
    "agentServerPackage": "@github/copilot",
    "agentServerVersion": "1.0.88",
    "agentRuntimePackage": null,
    "agentRuntimeVersion": null,
    "commandDigest": "sha256:ef496fc5e7c56680c1c992bbbb266050fc8644611fad7de0a9745f2adea47afe",
    "permissionPolicy": "interactive"
  },
  "claude": {
    "driverKind": "acpx_runtime",
    "protocolVersion": 1,
    "acpxVersion": "0.13.1",
    "agent": "claude",
    "agentProfileVersion": 1,
    "agentServerPackage": "@agentclientprotocol/claude-agent-acp",
    "agentServerVersion": "0.73.0",
    "agentRuntimePackage": "@anthropic-ai/claude-agent-sdk",
    "agentRuntimeVersion": "0.3.286",
    "commandDigest": "sha256:9d73d1f0f121fb96cc8badb28c22d5bff02d8582eb2e40360a81c189e1b9422a",
    "permissionPolicy": "interactive"
  },
  "codex": {
    "driverKind": "acpx_runtime",
    "protocolVersion": 1,
    "acpxVersion": "0.13.1",
    "agent": "codex",
    "agentProfileVersion": 1,
    "agentServerPackage": "@agentclientprotocol/codex-acp",
    "agentServerVersion": "1.6.2",
    "agentRuntimePackage": "@openai/codex",
    "agentRuntimeVersion": "0.160.0",
    "commandDigest": "sha256:443491f4e814501a5dc47347e4510e84faeec9c9382e2d4e53bfe69386d5aabc",
    "permissionPolicy": "interactive"
  }
} as const;

export const CURSOR_DISTRIBUTION_PINS = {
  "darwin-arm64": {
    "closureSha256": "257424bd48e35412091c6adfc61e4648e836757ec1d240d890bba81a24918c30",
    "executable": "node",
    "entrypoint": "index.js"
  },
  "darwin-x64": {
    "closureSha256": "6f28c799c5afdc64fbdff8a2157f565f17ae7615efe014ac389d63bf70cf2be2",
    "executable": "node",
    "entrypoint": "index.js"
  },
  "linux-x64": {
    "closureSha256": "eadb8bb8ffb0450455b15b88c9b230307a9e149958a0c452d16dd157b4633d74",
    "executable": "node",
    "entrypoint": "index.js"
  }
} as const;

export const ANTIGRAVITY_DISTRIBUTION_PINS = {
  "darwin-arm64": {
    "closureSha256": "044792d793e203bc8b4524a418f1816c4d34db67bb41fa4bae5947a050c49b4a",
    "executable": "agy_acp_server.par",
    "args": []
  }
} as const;
