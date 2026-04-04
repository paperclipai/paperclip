declare module "@paperclipai/server" {
  import type { Server } from "node:http";

  export interface StartedServer {
    server: Server;
    host: string;
    listenPort: number;
    apiUrl: string;
    databaseUrl: string;
    shutdown: () => Promise<void>;
  }

  export function startServer(): Promise<StartedServer>;
}
