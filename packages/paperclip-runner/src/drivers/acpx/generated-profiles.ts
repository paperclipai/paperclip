// Generated from acpx-profiles.json and cursor-distributions.json. Do not edit.
export const QUALIFIED_ACPX_VERSION = "0.22.0" as const;
export const ACPX_DRIVER_KIND = "acpx_runtime" as const;
export const ACPX_DRIVER_PROTOCOL_VERSION = 1 as const;

export const ACPX_RELEASE_PROFILE_DIGESTS = {
  "antigravity": "sha256:0a6ed8999c183b2412f4f4172dfc7be672be257e8cf31cc252c62bd37c9a2f18",
  "grok": "sha256:b0e507ac768a44472e9d70439f02ccf13828bfa06045330e0b0861834327d18e",
  "pi": "sha256:c3e08f17e436672da69276b664564633040257a722d51117f47d3b3d2be65666",
  "cursor": "sha256:d4fff78f5948f257addc7888d45f2b1cd7efa171991ec79705956789cbe7a3b9",
  "copilot": "sha256:13b2b09d4d6ab5e78d1f6b5bddf131f783a6e0fb0bb550b85f7eab59951d9ceb",
  "claude": "sha256:46efbe51efcfff53262af90ff4143b7a6dbffa3600e94d221d3af8cc5b5f418c",
  "codex": "sha256:12554690ef84cc99d690616dcac19f2bdd80c3046959a74e8555f9d3bac793e9",
  "kimi": "sha256:278896da3ae5ed4827607a3e28bff41e83d0225928eec2a78c59758b8d1ee365"
} as const;

export const QUALIFIED_ACPX_PROFILE_DATA = {
  "antigravity": {
    "driverKind": "acpx_runtime",
    "protocolVersion": 1,
    "acpxVersion": "0.22.0",
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
    "acpxVersion": "0.22.0",
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
    "acpxVersion": "0.22.0",
    "agent": "pi",
    "agentProfileVersion": 37,
    "agentServerPackage": "pi-acp",
    "agentServerVersion": "0.0.33",
    "agentRuntimePackage": "@earendil-works/pi-coding-agent",
    "agentRuntimeVersion": "1.0.0",
    "commandDigest": "sha256:42e186b921f36accf3087cf64986a88346dcdb0bdf78c2ef44a2c4f8abd3453a",
    "permissionPolicy": "interactive"
  },
  "cursor": {
    "driverKind": "acpx_runtime",
    "protocolVersion": 1,
    "acpxVersion": "0.22.0",
    "agent": "cursor",
    "agentProfileVersion": 17,
    "agentServerPackage": "cursor-agent",
    "agentServerVersion": "2026.09.26-dd393fe",
    "agentRuntimePackage": null,
    "agentRuntimeVersion": null,
    "commandDigest": "sha256:c2e39f931fdb89eb226ddee17bdcd16ad14c80fe4d311a41df89f2947d72103d",
    "permissionPolicy": "interactive"
  },
  "copilot": {
    "driverKind": "acpx_runtime",
    "protocolVersion": 1,
    "acpxVersion": "0.22.0",
    "agent": "copilot",
    "agentProfileVersion": 92,
    "agentServerPackage": "@github/copilot",
    "agentServerVersion": "1.0.88",
    "agentRuntimePackage": null,
    "agentRuntimeVersion": null,
    "commandDigest": "sha256:4ec9c9d399e0f97d3addd9ac3333a69588a8103d5e534e206c02604432d89f9b",
    "permissionPolicy": "interactive"
  },
  "claude": {
    "driverKind": "acpx_runtime",
    "protocolVersion": 1,
    "acpxVersion": "0.22.0",
    "agent": "claude",
    "agentProfileVersion": 1,
    "agentServerPackage": "@agentclientprotocol/claude-agent-acp",
    "agentServerVersion": "0.73.0",
    "agentRuntimePackage": "@anthropic-ai/claude-agent-sdk",
    "agentRuntimeVersion": "0.3.328",
    "commandDigest": "sha256:9d73d1f0f121fb96cc8badb28c22d5bff02d8582eb2e40360a81c189e1b9422a",
    "permissionPolicy": "interactive"
  },
  "codex": {
    "driverKind": "acpx_runtime",
    "protocolVersion": 1,
    "acpxVersion": "0.22.0",
    "agent": "codex",
    "agentProfileVersion": 1,
    "agentServerPackage": "@agentclientprotocol/codex-acp",
    "agentServerVersion": "1.6.2",
    "agentRuntimePackage": "@openai/codex",
    "agentRuntimeVersion": "0.170.0",
    "commandDigest": "sha256:443491f4e814501a5dc47347e4510e84faeec9c9382e2d4e53bfe69386d5aabc",
    "permissionPolicy": "interactive"
  },
  "kimi": {
    "driverKind": "acpx_runtime",
    "protocolVersion": 1,
    "acpxVersion": "0.22.0",
    "agent": "kimi",
    "agentProfileVersion": 17,
    "agentServerPackage": "@moonshot-ai/kimi-code",
    "agentServerVersion": "2.3.3",
    "agentRuntimePackage": null,
    "agentRuntimeVersion": null,
    "commandDigest": "sha256:6ee5fb7ac18c1361ac63effe9117d08ed129add8349756a140e73e0c86ba5da7",
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
