export const launchNames = (ctx) => [`${ctx.slug}-directions-dev`, `${ctx.slug}-directions`];

export default (ctx) => [
  {
    name: `${ctx.slug}-directions-dev`,
    runtimeExecutable: "/bin/sh",
    runtimeArgs: ["-c", `cd ui && npx vite --config ${ctx.configFile} --port ${ctx.ports.dev} --strictPort`],
    port: ctx.ports.dev,
  },
  {
    name: `${ctx.slug}-directions`,
    runtimeExecutable: "/bin/sh",
    runtimeArgs: [
      "-c",
      `cd ui && export ${ctx.envOutDir}=${ctx.staticDir} && npx vite build --config ${ctx.configFile} && npx vite preview --config ${ctx.configFile} --port ${ctx.ports.preview} --strictPort`,
    ],
    port: ctx.ports.preview,
  },
];
