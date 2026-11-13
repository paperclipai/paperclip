export function storybookAgentAvatarAssets(): {
  name: string;
  apply: "build";
  generateBundle(this: { emitFile(asset: { type: "asset"; fileName: string; source: string | Uint8Array }): unknown }): Promise<void>;
};
