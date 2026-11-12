/**
 * The canonical check code the Claude Test engine emits when a sandbox target has
 * no ready authentication. This module re-exports the one shared constant, so
 * the adapters and the user interface gate login from the same code. See the
 * source in the shared package for the full contract.
 */
export { ADAPTER_AUTH_MISSING_CHECK_CODE } from "@paperclipai/shared";
