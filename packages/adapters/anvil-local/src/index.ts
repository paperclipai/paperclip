import type { AdapterModel } from "@paperclipai/adapter-utils";

export const label = "Anvil (local)";

export const models: AdapterModel[] = [
  { id: "anvil", label: "Anvil (local)" }
];

export const agentConfigurationDoc = `
## Anvil (local) Configuration

Anvil is a local execution engine.

### Configuration Fields

* **cwd**: The working directory where the process should run.
* **env**: Environment variables to pass to the process.
* **promptTemplate**: Template for the prompt.
`;
