import type { ToastInput } from "../context/ToastContext";

/**
 * Opt in only at known first-party notification factories. Their getters encode
 * explicit copy/data provenance; arbitrary string/getter inputs are never tagged.
 * Keep the string API (and push-time dedupe snapshots) intact while carrying the
 * same factory's presentation through ToastProvider to the mounted viewport.
 */
export function withLiveToastPresentation(input: ToastInput): ToastInput {
  input.presentation = {
    ...input.presentation,
    render: () => ({ title: input.title, body: input.body, action: input.action?.label }),
  };
  return input;
}
