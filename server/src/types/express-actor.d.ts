declare module "express-serve-static-core" {
  interface Request {
    actor: any;
  }
}

declare global {
  namespace Express {
    interface Request {
      actor: any;
    }
  }
}

export {};
