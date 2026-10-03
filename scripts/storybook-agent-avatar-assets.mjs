import { createRequire } from "node:module";
import { createHash } from "node:crypto";

/** Render avatar presets with the API worker in dev and package them in builds. */
export function storybookAgentAvatarAssets() {
  return {
    name: "storybook-agent-avatar-assets",
    configureServer(server) {
      let rendererPromise;
      const images = new Map();
      const renderer = () => rendererPromise ??= (async () => {
        const serverRequire = createRequire(new URL("../server/package.json", import.meta.url));
        const { tsImport } = await import(serverRequire.resolve("tsx/esm/api"));
        const { createAgentAvatarPool } = await tsImport("../server/src/services/agent-avatar-pool.ts", import.meta.url);
        const { AGENT_PALETTE_IDS, AGENT_AVATAR_SIZES, CHARACTER_STATES, appearanceForPalette } =
          await tsImport("../packages/shared/src/agent-appearance.ts", import.meta.url);
        return { pool: createAgentAvatarPool(2), AGENT_PALETTE_IDS, AGENT_AVATAR_SIZES, CHARACTER_STATES, appearanceForPalette };
      })();
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url ?? "/", "http://storybook.local").pathname;
        const match = /^\/agent-avatar-images\/cap-v1\/([^/]+)\/([^/]+)-(\d+)-([12])\.png$/.exec(pathname);
        if (!match) return next();
        void (async () => {
          const [, palette, pose, sizeText, scaleText] = match;
          const { pool, AGENT_PALETTE_IDS, AGENT_AVATAR_SIZES, CHARACTER_STATES, appearanceForPalette } = await renderer();
          const size = Number(sizeText);
          const scale = Number(scaleText);
          const muted = palette === "muted-dream";
          if (!(muted || AGENT_PALETTE_IDS.includes(palette)) || !CHARACTER_STATES.includes(pose) || !AGENT_AVATAR_SIZES.includes(size)) {
            res.statusCode = 404;
            res.end();
            return;
          }
          if (!images.has(pathname)) {
            const appearance = appearanceForPalette(muted ? AGENT_PALETTE_IDS[0] : palette);
            images.set(pathname, pool.render({ appearance, size, scale, pose, muted }).catch((error) => {
              images.delete(pathname);
              throw error;
            }));
          }
          const png = await images.get(pathname);
          res.setHeader("Content-Type", "image/png");
          res.setHeader("Cache-Control", "public, max-age=3600");
          res.end(png);
        })().catch(() => {
          res.statusCode = 500;
          res.end("Avatar rendering failed");
        });
      });
      server.httpServer?.once("close", () => { void rendererPromise?.then(({ pool }) => pool.close()); });
    },
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
