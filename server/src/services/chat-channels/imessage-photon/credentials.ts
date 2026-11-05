import { PhotonCloudClient, PhotonError, photonSharedIdentity } from "../../photon/cloud.js";

import {
  HttpError,
  unprocessable,
} from "../../../errors.js";

import type { VerifiedProviderIdentity } from "../runtime-types.js";

export function createPhotonCredentialChecks(fetchImpl: typeof fetch) {


  async function inspectPhotonCredentials(projectId: string, projectSecret: string) {
    try {
      return await new PhotonCloudClient(fetchImpl).inspect(projectId, projectSecret);
    } catch (error) {
      if (!(error instanceof PhotonError)) throw error;
      // Only credentials/allocation failures mean the setup input needs repair.
      // Preserve safe provider messages while distinguishing outages and bad
      // upstream responses from validation errors. Never return response bodies.
      const status = error.code === "credentials" || error.code === "line_unavailable"
        ? 422
        : error.code === "quota"
          ? 429
          : error.code === "network"
            ? 503
            : 502;
      throw new HttpError(status, error.message, {
        code: `photon_${error.code}`,
      });
    }
  }
  async function verifyPhotonCredentials(credentials: Record<string, string>): Promise<VerifiedProviderIdentity> {
    const inspection = await inspectPhotonCredentials(credentials.projectId, credentials.projectSecret);
    if (inspection.allocation !== (credentials.allocation ?? "dedicated")) throw unprocessable("Photon allocation changed; inspect the project again");
    if (inspection.allocation === "shared") {
      if (!inspection.eligible) throw unprocessable("Photon shared project is unavailable");
      return { providerAccountId: inspection.projectId, providerAccountLabel: inspection.projectName, botExternalId: photonSharedIdentity(inspection.projectId), botUsername: null, botLabel: `${inspection.projectName} (DM only)` };
    }
    const line = inspection.lines.find((candidate) => candidate.lineId === credentials.lineId && candidate.eligible);
    if (!line || !inspection.eligible) throw unprocessable("Select an eligible dedicated Photon line");
    return { providerAccountId: inspection.projectId, providerAccountLabel: inspection.projectName, botExternalId: line.phoneNumber, botUsername: line.phoneNumber, botLabel: line.phoneNumber };
  }
  return { inspectPhotonCredentials, verifyPhotonCredentials };
}
