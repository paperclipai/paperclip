declare module "embedded-postgres" {
  export class Postgres {
    constructor(options?: {
      databaseDir?: string;
      user?: string;
      password?: string;
      port?: number;
      init?: boolean;
    });
    
    start(): Promise<void>;
    stop(): Promise<void>;
    get port(): number;
  }
}
