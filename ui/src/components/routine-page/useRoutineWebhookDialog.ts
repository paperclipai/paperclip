import { useCallback, useRef, useState } from "react";
import type { RoutineTrigger } from "@paperclipai/shared";
import { describeError } from "@/api/errors";
import { routinesApi } from "@/api/routines";
import type { RoutineWebhookDialogProps, WebhookSender } from "./RoutineWebhookDialog";

/** A webhook key to show once, e.g. after a version restore recreated the webhook. */
export type PendingWebhookKey = {
  triggerId: string;
  webhookUrl: string;
  webhookSecret: string;
  /** From the restored revision; null when unknown, and then no signing instructions are shown until the routine refresh lists the webhook. */
  signingMode?: string | null;
};

/** Enough of a restored webhook to show its URL and new key before the routine refresh lists it. */
function restoredPlaceholder(key: PendingWebhookKey): RoutineTrigger {
  const now = new Date();
  return {
    id: key.triggerId,
    companyId: "",
    routineId: "",
    kind: "webhook",
    label: null,
    enabled: true,
    cronExpression: null,
    timezone: null,
    nextRunAt: null,
    lastFiredAt: null,
    publicId: null,
    webhookUrl: key.webhookUrl,
    setupPending: false,
    lastWebhookDelivery: null,
    secretId: null,
    signingMode: key.signingMode ?? null,
    replayWindowSec: null,
    lastRotatedAt: null,
    lastResult: null,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Wires the webhook dialog to the trigger API: create (setup mode), replace
 * key, pause/resume, remove, and test mode. Every change is saved right away;
 * `onChanged` refreshes the routine. Closing the dialog while a webhook is in
 * setup or test mode ends it, so nothing is left silently ignoring events.
 */
export function useRoutineWebhookDialog({
  routineId,
  triggers,
  onChanged,
  onRemoved,
}: {
  routineId: string;
  triggers: readonly RoutineTrigger[];
  onChanged: () => Promise<unknown> | void;
  onRemoved?: (trigger: RoutineTrigger) => void;
}) {
  const [open, setOpen] = useState(false);
  const [triggerId, setTriggerId] = useState<string | null>(null);
  const [created, setCreated] = useState<RoutineTrigger | null>(null);
  /** A restored webhook's URL, shown with its new key until the refreshed routine lists it. */
  const [restored, setRestored] = useState<PendingWebhookKey | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queue = useRef<PendingWebhookKey[]>([]);
  /** A change is being saved; closing waits for it so a half-started test is never left behind. */
  const busyRef = useRef(false);

  const saved = triggerId ? triggers.find((trigger) => trigger.id === triggerId) ?? null : null;
  const trigger = saved
    ?? (created && created.id === triggerId ? created : null)
    ?? (restored && restored.triggerId === triggerId ? restoredPlaceholder(restored) : null);
  // A webhook created in this dialog is in first setup; any other webhook in
  // setup mode was put back into test mode (or left mid-setup) and offers Finish testing.
  const testing = Boolean(trigger?.setupPending) && created?.id !== trigger?.id;

  const run = useCallback(
    async (action: () => Promise<void>, failure: string) => {
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        await action();
        await onChanged();
        return true;
      } catch (cause) {
        setError(describeError(cause, { action: failure }).body);
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [onChanged],
  );

  const show = useCallback((next: RoutineTrigger | null, key: string | null = null) => {
    setTriggerId(next?.id ?? null);
    setCreated(null);
    setRestored(null);
    setSecret(key);
    setError(null);
    setOpen(true);
  }, []);

  const showNextPendingKey = useCallback(() => {
    const next = queue.current.shift();
    if (!next) return false;
    setTriggerId(next.triggerId);
    setCreated(null);
    setRestored(next);
    setSecret(next.webhookSecret);
    setError(null);
    setOpen(true);
    return true;
  }, []);

  /** Shows each restored webhook's new key once, one after another. */
  const showKeys = useCallback(
    (keys: PendingWebhookKey[]) => {
      queue.current = [...keys];
      showNextPendingKey();
    },
    [showNextPendingKey],
  );

  /** Closes the dialog, ending setup or test mode first. Ignored while a change is saving. */
  const close = useCallback(async () => {
    if (busyRef.current) return;
    const current = trigger;
    if (current?.setupPending) {
      // Stay open if this fails, so the error is seen and the webhook is not left in test mode unnoticed.
      const finished = await run(
        () => routinesApi.updateTrigger(current.id, { setupPending: false }).then(() => undefined),
        current.id === created?.id ? "finish setting up the webhook" : "finish testing the webhook",
      );
      if (!finished) return;
    }
    setOpen(false);
    setSecret(null);
    showNextPendingKey();
  }, [created?.id, run, showNextPendingKey, trigger]);

  const dialogProps: Omit<RoutineWebhookDialogProps, "routineTitle" | "routineActive"> = {
    open,
    onOpenChange: (next) => {
      if (next) setOpen(true);
      else void close();
    },
    trigger,
    secret,
    busy,
    error,
    testing,
    onCreate: (sender: WebhookSender) => {
      void run(async () => {
        const response = await routinesApi.createTrigger(routineId, {
          kind: "webhook",
          signingMode: sender === "github" ? "github_hmac" : "app_webhook",
          setupPending: true,
        });
        setCreated({ ...response.trigger, webhookUrl: response.secretMaterial?.webhookUrl ?? response.trigger.webhookUrl });
        setTriggerId(response.trigger.id);
        setSecret(response.secretMaterial?.webhookSecret ?? null);
      }, "create the webhook");
    },
    onReplaceKey: () => {
      if (!trigger) return;
      void run(async () => {
        const response = await routinesApi.rotateTriggerSecret(trigger.id);
        setSecret(response.secretMaterial.webhookSecret);
      }, "replace the key");
    },
    onSetPaused: (paused) => {
      if (!trigger) return;
      void run(() => routinesApi.updateTrigger(trigger.id, { enabled: !paused }).then(() => undefined), paused ? "pause the webhook" : "resume the webhook");
    },
    onRemove: () => {
      if (!trigger) return;
      const removed = trigger;
      void run(async () => {
        await routinesApi.updateTrigger(removed.id, { archived: true });
        setOpen(false);
        setSecret(null);
        onRemoved?.(removed);
      }, "remove the webhook");
    },
    onStartTest: () => {
      if (!trigger) return;
      void run(() => routinesApi.updateTrigger(trigger.id, { setupPending: true }).then(() => undefined), "start testing the webhook");
    },
    onFinishTest: () => {
      if (!trigger) return;
      void run(() => routinesApi.updateTrigger(trigger.id, { setupPending: false }).then(() => undefined), "finish testing the webhook");
    },
  };

  return { open, show, showKeys, close, dialogProps };
}
