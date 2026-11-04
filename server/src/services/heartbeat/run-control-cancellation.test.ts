import { describe, expect, it } from "vitest";
import { localRunCancelIsSelfAcknowledging } from "./run-control.js";

/**
 * Un issue queda envenenado cuando su ultimo run se cancela sin proceso vivo:
 * `executionCancellation` queda en `requested` para siempre y la cola difiere
 * todos los mensajes futuros con `process_identity_missing`. El issue deja de
 * poder tomar ningun asiento.
 */
describe("cancelacion de un run local sin proceso vivo", () => {
  it("reconoce la cancelacion cuando no hay proceso en este host", () => {
    expect(localRunCancelIsSelfAcknowledging({ adapterType: "opencode_local", hasLiveProcess: false })).toBe(true);
    expect(localRunCancelIsSelfAcknowledging({ adapterType: "claude_local", hasLiveProcess: false })).toBe(true);
    expect(localRunCancelIsSelfAcknowledging({ adapterType: "codex_local", hasLiveProcess: false })).toBe(true);
  });

  it("no reconoce la cancelacion con un proceso vivo (falta su prueba de parada)", () => {
    expect(localRunCancelIsSelfAcknowledging({ adapterType: "opencode_local", hasLiveProcess: true })).toBe(false);
  });

  it("no reconoce la cancelacion de un proveedor remoto (puede seguir trabajando)", () => {
    expect(localRunCancelIsSelfAcknowledging({ adapterType: "cursor_cloud", hasLiveProcess: false })).toBe(false);
    expect(localRunCancelIsSelfAcknowledging({ adapterType: "hermes_gateway", hasLiveProcess: false })).toBe(false);
    expect(localRunCancelIsSelfAcknowledging({ adapterType: "hermes_local", hasLiveProcess: false })).toBe(true);
  });

  it("no reconoce la cancelacion sin adaptador conocido", () => {
    expect(localRunCancelIsSelfAcknowledging({ adapterType: undefined, hasLiveProcess: false })).toBe(false);
    expect(localRunCancelIsSelfAcknowledging({ adapterType: null, hasLiveProcess: false })).toBe(false);
    expect(localRunCancelIsSelfAcknowledging({ adapterType: "", hasLiveProcess: false })).toBe(false);
  });
});
