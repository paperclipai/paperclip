(async () => {
  const { runCli } = await import("./node_modules/@deepseek-ai/dsh/lib/bin.js");
  await runCli();
})().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
