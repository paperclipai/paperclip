import { forbidden } from "../errors.js";
import { isCloudManagedInstance } from "./cloud-instance.js";

export function assertExternalAdapterCodeAllowed(): void {
  if (isCloudManagedInstance()) {
    throw forbidden("Adapter installation is platform-managed on cloud-managed instances", {
      code: "adapter_install_platform_managed",
    });
  }
}
