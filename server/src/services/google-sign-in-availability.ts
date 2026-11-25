import { isCloudManagedInstance } from "./cloud-instance.js";

export function paperclipGoogleSignInAvailable(): boolean {
  return isCloudManagedInstance();
}
