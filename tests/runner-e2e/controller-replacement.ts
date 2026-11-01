import { validControllerOutageReceipt, type ControllerOutageReceipt } from "./controller-outage.js";
import { validControllerRollingDeploymentReceipt, type ControllerRollingDeploymentReceipt } from "./controller-rolling-deployment.js";

export type ControllerReplacementReceipt = ControllerOutageReceipt | ControllerRollingDeploymentReceipt;
export function validControllerReplacementReceipt(value: unknown): value is ControllerReplacementReceipt {
  return validControllerOutageReceipt(value) || validControllerRollingDeploymentReceipt(value);
}
