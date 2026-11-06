import type { Db } from "@paperclipai/db";
import type { ToolGatewayService } from "./tool-gateway.js";

const gateways = new WeakMap<Db, ToolGatewayService>();

export function registerToolGateway(db: Db, gateway: ToolGatewayService): void {
  gateways.set(db, gateway);
}

export function getRegisteredToolGateway(db: Db): ToolGatewayService | undefined {
  return gateways.get(db);
}
