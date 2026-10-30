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
    "agentProfileVersion": 15,
    "agentServerPackage": "builtin:grok-acp",
    "agentServerVersion": "1",
    "agentRuntimePackage": "native:grok",
    "agentRuntimeVersion": "1.0.13",
    "commandDigest": "sha256:658e6d41ce6fc7080aa6655d7a97121b3cae6214f2d4c074284d958b95bbe769",
    "permissionPolicy": "interactive"
  },
  "pi": {
    "driverKind": "acpx_runtime",
    "protocolVersion": 1,
    "acpxVersion": "0.13.1",
    "agent": "pi",
    "agentProfileVersion": 35,
    "agentServerPackage": "pi-acp",
    "agentServerVersion": "0.0.33",
    "agentRuntimePackage": "@earendil-works/pi-coding-agent",
    "agentRuntimeVersion": "1.0.0",
    "commandDigest": "sha256:9473de6ef4baf2bd82fe8b6757239bdc160960b0a78ae6f47fa9e0996544226c",
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
    "agentProfileVersion": 88,
    "agentServerPackage": "@github/copilot",
    "agentServerVersion": "1.0.88",
    "agentRuntimePackage": null,
    "agentRuntimeVersion": null,
    "commandDigest": "sha256:b9c13b83628be07086a88394ae671997291b77bbdbf45b0bd1c4e91b7121bc9d",
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
