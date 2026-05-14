// Named-only re-exports per fork plan; upstream re-exported worker.ts as the
// module's default. The host loader resolves `paperclipPlugin.{manifest,worker}`
// directly via package.json and bypasses this barrel, so the divergence only
// affects third-party consumers that `import slackPlugin from
// "paperclip-plugin-slack"`.
export { default as manifest } from "./manifest.js";
export { default as plugin } from "./worker.js";
