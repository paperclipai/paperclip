// Compiled-in copy of antigravity-cli-distributions.json; antigravity-cli-pins.test.ts
// keeps the two equal. A file read at launch never establishes trust.
export const ANTIGRAVITY_CLI_DISTRIBUTION = {
  version: "1.5.15",
  build: "1.5.15-5514532022517760",
  args: [
    "acp"
  ],
  environment: {
    AGY_CLI_DISABLE_AUTO_UPDATE: "1"
  },
  platforms: {
    "darwin-arm64": {
      executable: "agy",
      closureSha256: "d61f8aed4c0fffe5db28ab2174f0543ed1fc09e03f4c3f491f9cbee5db157c63",
      entries: [
        {
          path: "agy",
          sha256: "8097b24de18aba93324ee24d0d3f060906c58ba58562f4f1bd66f380906056a2",
          size: 229617904,
          executable: true
        }
      ]
    },
    "linux-x64": {
      executable: "agy",
      closureSha256: "ffec3d7fcc882a243f7bfda808b601bb593c2a54514d492d719f7e546dd9990d",
      entries: [
        {
          path: "agy",
          sha256: "7b004d26c3fdea25a7c9d456de4bfaccef4be1e4cc7fd6db628859c5c941fa2d",
          size: 273879752,
          executable: true
        }
      ]
    },
    "linux-arm64": {
      executable: "agy",
      closureSha256: "e564936c56b8e7158b517428d4c23261f420fe84d4d2e8f1dd71e650bb8e9fac",
      entries: [
        {
          path: "agy",
          sha256: "497580a779b155268c4aa8f491b75e3b0034d4d0ba05c762582e7d97222396b0",
          size: 256660144,
          executable: true
        }
      ]
    }
  }
} as const;

export type AntigravityCliTarget = keyof typeof ANTIGRAVITY_CLI_DISTRIBUTION.platforms;
