import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface MCPServerConfig {
  namespace: string;
  entryPoint: string;
  healthPort?: number;
  tools?: string[];
  metadata?: Record<string, string>;
}

export interface MCPServerRegistration extends MCPServerConfig {
  registeredAt: number;
  lastHealthCheck?: number;
  healthy: boolean;
}

export interface MCPToolCallResult {
  content: Array<{ type: string; text?: string; data?: unknown }>;
  isError?: boolean;
}

export interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class PolyticianMCPClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private buffer = '';
  private connected = false;

  constructor(private config: MCPServerConfig) {
    super();
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    return new Promise((resolve, reject) => {
      const parts = this.config.entryPoint.split(' ');
      const command = parts[0];
      const args = parts.slice(1);

      if (!command) {
        reject(new Error('Invalid entry point: empty command'));
        return;
      }

      this.process = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          MCP_MODE: 'stdio',
        },
      });

      const stdout = this.process.stdout;
      const stderr = this.process.stderr;

      if (!stdout || !stderr) {
        reject(new Error('Failed to create stdio streams'));
        this.process.kill();
        return;
      }

      stdout.on('data', (data: Buffer) => {
        this.handleData(data.toString());
      });

      stderr.on('data', (data: Buffer) => {
        this.emit('stderr', data.toString());
      });

      this.process.on('error', (error: Error) => {
        this.emit('error', error);
        reject(error);
      });

      this.process.on('close', (code: number) => {
        this.connected = false;
        this.emit('close', code);
      });

      setTimeout(async () => {
        try {
          await this.sendRequest('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: {
              name: 'agentvault',
              version: '1.0.0',
            },
          });
          this.connected = true;
          resolve();
        } catch (error) {
          reject(error);
        }
      }, 100);
    });
  }

  private handleData(data: string): void {
    this.buffer += data;

    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const response = JSON.parse(line);
          this.handleResponse(response);
        } catch {
          // Ignore parse errors for incomplete lines
        }
      }
    }
  }

  private handleResponse(response: { id?: number; result?: unknown; error?: { message: string } }): void {
    if (response.id !== undefined) {
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        this.pendingRequests.delete(response.id);
        if (response.error) {
          pending.reject(new Error(response.error.message));
        } else {
          pending.resolve(response.result);
        }
      }
    }
  }

  private async sendRequest(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new Error('MCP client not connected'));
        return;
      }

      const id = ++this.requestId;
      const request = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      }) + '\n';

      this.pendingRequests.set(id, { resolve, reject });

      this.process.stdin.write(request);

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${id} timed out`));
        }
      }, 30000);
    });
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    const result = await this.sendRequest('tools/list') as { tools: MCPToolDefinition[] };
    return result.tools || [];
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<MCPToolCallResult> {
    const result = await this.sendRequest('tools/call', {
      name,
      arguments: args,
    }) as MCPToolCallResult;
    return result;
  }

  async disconnect(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getConfig(): MCPServerConfig {
    return this.config;
  }
}

export async function probeMCPServerHealth(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${port}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function discoverMCPTools(entryPoint: string): Promise<string[]> {
  const client = new PolyticianMCPClient({
    namespace: '_discovery',
    entryPoint,
  });

  try {
    await client.connect();
    const tools = await client.listTools();
    await client.disconnect();
    return tools.map(t => t.name);
  } catch (error) {
    await client.disconnect();
    throw error;
  }
}
