#!/usr/bin/env node
import { probeCopilotMetadata } from "../drivers/copilot-metadata-probe.js";
const result = await probeCopilotMetadata(process.env.COPILOT_GITHUB_TOKEN ?? "", process.env.PAPERCLIP_COPILOT_PROBE_MODEL);
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status === "failed") process.exitCode = 1;
