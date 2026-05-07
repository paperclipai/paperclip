import type { ToscaCredentials } from "./types.js";
import { HttpClient } from "./http.js";
import { AgentsResource } from "./resources/agents.js";
import { ExecutionsResource } from "./resources/executions.js";
import { ProjectsResource } from "./resources/projects.js";
import { TestCasesResource } from "./resources/test-cases.js";
import { WorkspacesResource } from "./resources/workspaces.js";

export interface ToscaCloudClientOptions {
  /** Base URL of the Tosca Cloud tenant, e.g. https://myorg.tricentis.com */
  baseUrl: string;
  credentials: ToscaCredentials;
  /** Override fetch implementation for testing */
  fetchFn?: typeof globalThis.fetch;
}

export class ToscaCloudClient {
  readonly workspaces: WorkspacesResource;
  readonly projects: ProjectsResource;
  readonly testCases: TestCasesResource;
  readonly executions: ExecutionsResource;
  readonly agents: AgentsResource;

  constructor(options: ToscaCloudClientOptions) {
    const http = new HttpClient({
      baseUrl: options.baseUrl,
      credentials: options.credentials,
      fetchFn: options.fetchFn,
    });

    this.workspaces = new WorkspacesResource(http);
    this.projects = new ProjectsResource(http);
    this.testCases = new TestCasesResource(http);
    this.executions = new ExecutionsResource(http);
    this.agents = new AgentsResource(http);
  }
}
