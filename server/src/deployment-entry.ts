import { loadDeploymentDescriptor, deploymentEnvironment, UnqualifiedRemoteExecutionError } from "./deployment/runtime.js";

try {
  const [file, command = "serve", ...extra] = process.argv.slice(2);
  if (!file || extra.length || !["serve", "plan", "apply", "check"].includes(command)) {
    throw new Error("Usage: paperclip-deployment <descriptor.json> [serve|plan|apply|check]");
  }
  process.umask(0o077);
  const descriptor = loadDeploymentDescriptor(file);
  const env = deploymentEnvironment(descriptor, process.env);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env, { PAPERCLIP_DEPLOYMENT_FILE: file });
  if (command === "serve") {
    const { startServer } = await import("./index.js");
    await startServer();
  }
  else {
    const { deploymentCommand } = await import("./deployment/command.js");
    const { result, exitCode } = await deploymentCommand(command as "plan" | "apply" | "check", descriptor);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = exitCode;
  }
} catch (error) {
  console.error(error instanceof UnqualifiedRemoteExecutionError ? error.message
    : "Paperclip declarative startup failed; check configuration and runtime credential availability.");
  process.exitCode = 1;
}
