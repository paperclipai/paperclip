import { describe, expect, it } from "vitest";
import { localRunCancelIsSelfAcknowledging } from "./run-control.js";

/**
 * Un issue queda envenenado cuando su ultimo run se cancela sin proceso vivo:
 * `executionCancellation` queda en `requested` para siempre y la cola difiere
 * todos los mensajes futuros de ese issue con `process_identity_missing`. El
 * issue deja de poder tomar ningun asiento.
 *
 * La prueba de parada tiene que salir de la identidad PERSISTIDA del run: un
 * hijo vivo sin entrada en el mapa en memoria (tras un reinicio del server)
 * sigue trabajando.
 */
const muerto = () => false;
const vivo = () => true;

describe("cancelacion de un run local sin proceso vivo", () => {
  it("acusa la cancelacion cuando no hay identidad de proceso persistida", () => {
    expect(localRunCancelIsSelfAcknowledging({ adapterType: "opencode_local", isProcessAlive: muerto })).toBe(true);
    expect(localRunCancelIsSelfAcknowledging({ adapterType: "claude_local", isProcessAlive: muerto })).toBe(true);
    expect(localRunCancelIsSelfAcknowledging({ adapterType: "codex_local", isProcessAlive: muerto })).toBe(true);
  });

  it("NO acusa si el proceso persistido sigue vivo (el hijo sigue trabajando)", () => {
    expect(
      localRunCancelIsSelfAcknowledging({ adapterType: "opencode_local", processPid: 4242, isProcessAlive: vivo }),
    ).toBe(false);
    expect(
      localRunCancelIsSelfAcknowledging({ adapterType: "opencode_local", processGroupId: -4243, isProcessAlive: vivo }),
    ).toBe(false);
  });

  it("acusa si el proceso persistido ya no existe", () => {
    expect(
      localRunCancelIsSelfAcknowledging({ adapterType: "opencode_local", processPid: 4242, isProcessAlive: muerto }),
    ).toBe(true);
    expect(
      localRunCancelIsSelfAcknowledging({ adapterType: "opencode_local", processGroupId: -4243, isProcessAlive: muerto }),
    ).toBe(true);
  });

  it("no toca un proveedor remoto (puede seguir trabajando sin proceso en este host)", () => {
    expect(localRunCancelIsSelfAcknowledging({ adapterType: "cursor_cloud", isProcessAlive: muerto })).toBe(false);
    expect(localRunCancelIsSelfAcknowledging({ adapterType: "hermes_gateway", isProcessAlive: muerto })).toBe(false);
  });

  it("no toca un run nativo (tiene su propio acuse)", () => {
    expect(
      localRunCancelIsSelfAcknowledging({ adapterType: "opencode_local", runtimeMode: "native", isProcessAlive: muerto }),
    ).toBe(false);
    expect(
      localRunCancelIsSelfAcknowledging({ adapterType: "opencode_local", runtimeMode: "legacy", isProcessAlive: muerto }),
    ).toBe(true);
  });

  it("no acusa sin adaptador conocido", () => {
    expect(localRunCancelIsSelfAcknowledging({ adapterType: undefined, isProcessAlive: muerto })).toBe(false);
    expect(localRunCancelIsSelfAcknowledging({ adapterType: null, isProcessAlive: muerto })).toBe(false);
    expect(localRunCancelIsSelfAcknowledging({ adapterType: "", isProcessAlive: muerto })).toBe(false);
  });
});
