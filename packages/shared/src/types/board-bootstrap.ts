import type { Company } from "./company.js";
import type { AuthSession } from "../validators/access.js";

/** Navigation reads taken for the same authenticated principal as the session. */
export interface BoardBootstrap {
  userId: string;
  companies: Company[];
  boardAccess: {
    userId: string;
    isInstanceAdmin: boolean;
    companyIds: string[];
  };
}

/** Older servers and partial bootstrap failures retain the ordinary session. */
export type BoardBootstrapSession = AuthSession & { boardBootstrap?: BoardBootstrap };
