export const KIMI_RUNTIME_VERSION = "2.3.3" as const;
export const KIMI_NODE_VERSION = "24.21.0" as const;
export const KIMI_DISTRIBUTION_LOCK_SHA256 = "87f854ddd7f92254ccd8596b85962684ec176f92e93863771843bf416825f16b";
export const KIMI_NODE_DISTRIBUTIONS = Object.freeze({
  "darwin-arm64": Object.freeze({ archiveSha256: "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057", executableSha256: "e4b5a3af0e05c75de2eae013904145f40fe7fc2a6e6f17510128bf45cca4e79b", executableSize: 122129232 }),
  "linux-x64": Object.freeze({ archiveSha256: "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff", executableSha256: "7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c", executableSize: 126595440 }),
});

export const KIMI_DISTRIBUTION_CLOSURE_SHA256 = Object.freeze({
  "darwin-arm64": "6038325abd0431c30097ff1f572a9b29816e1b4da372d8cb86b2ca5d18ea34e7",
  "linux-x64": "105d8394adbbc76a953a12cc51b5288eb940ad693291e584f6cdc6407213164d",
});
