import { createRequire } from "node:module";
import { createHash } from "node:crypto";

/** Build-only: reuse the API worker and finite preset contract, never a browser renderer. */
export function storybookAgentAvatarAssets() {
  return {
    name: "storybook-agent-avatar-assets",
    apply: "build",
    async generateBundle() {
      const serverRequire = createRequire(new URL("../server/package.json", import.meta.url));
      const { tsImport } = await import(serverRequire.resolve("tsx/esm/api"));
      const { createAgentAvatarPool } = await tsImport("../server/src/services/agent-avatar-pool.ts", import.meta.url);
      const { AGENT_PALETTE_IDS, AGENT_AVATAR_SIZES, CHARACTER_STATES, appearanceForPalette } =
        await tsImport("../packages/shared/src/agent-appearance.ts", import.meta.url);
      const { agentAvatarUrl } = await tsImport("../ui/storybook/fixtures/agent-avatar-url.ts", import.meta.url);
      const requests = [false, true].flatMap(muted =>
        (muted ? [AGENT_PALETTE_IDS[0]] : AGENT_PALETTE_IDS).flatMap(palette =>
          CHARACTER_STATES.flatMap(pose => AGENT_AVATAR_SIZES.flatMap(size =>
            [1, 2].map(scale => ({ appearance: appearanceForPalette(palette), size, scale, pose, muted }))))));
      const pool = createAgentAvatarPool(2);
      const images = [];
      let next = 0;
      try {
        await Promise.all(Array.from({ length: 2 }, async () => {
          while (next < requests.length) {
            const request = requests[next++];
            const source = await pool.render(request);
            const { appearance, size, scale, pose, muted } = request;
            const fileName = agentAvatarUrl(appearance, size, scale, pose, muted).slice(2);
            this.emitFile({ type: "asset", fileName, source });
            images.push({ path: fileName, sha256: createHash("sha256").update(source).digest("hex"), pixels: size * scale });
          }
        }));
      } finally {
        await pool.close();
      }
      images.sort((a, b) => a.path.localeCompare(b.path));
      this.emitFile({ type: "asset", fileName: "agent-avatar-images/manifest.json",
        source: JSON.stringify({ schemaVersion: 1, images }) });
      console.log(`Packaged ${images.length} agent avatar PNGs using the API renderer.`);
    },
  };
}
