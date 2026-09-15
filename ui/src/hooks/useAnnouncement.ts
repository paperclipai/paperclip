import { useCallback, useEffect, useRef, useState } from "react";
import { announcementIdSchema, type Announcement } from "@paperclipai/shared";
import { announcementsApi } from "@/api/announcements";
import { announcementStoragePrefix, readAnnouncementDismissals, saveAnnouncementDismissal } from "@/lib/announcement-dismissals";

export const ANNOUNCEMENT_SETTLE_MS = 3000;
interface Options {
  userId: string | null;
  companyId: string | null;
  enabled: boolean;
  onSaveFailure: (savedLocally: boolean) => void;
}

export function useAnnouncement(options: Options) {
  const { userId, enabled } = options;
  const latest = useRef(options);
  latest.current = options;
  const [state, setState] = useState<{ userId: string; announcement: Announcement } | null>(null);
  const dismissRef = useRef<(id: string) => void>(() => {});

  useEffect(() => {
    setState(null);
    if (!userId || !enabled) return;
    let disposed = false;
    let generation = 0;
    let fetchController: AbortController | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const writes = new Map<string, AbortController>();
    const warned = new Set<string>();
    const prefix = announcementStoragePrefix(userId);
    let channel: BroadcastChannel | null = null;
    try { channel = new BroadcastChannel(prefix); } catch { /* storage events still synchronize tabs */ }
    const active = () => !disposed && latest.current.userId === userId && latest.current.enabled;

    async function sync(id: string, savedLocally = true) {
      if (!active() || writes.has(id) || !latest.current.companyId) return;
      const controller = new AbortController();
      writes.set(id, controller);
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        await announcementsApi.dismiss(id, latest.current.companyId, controller.signal);
        if (active()) saveAnnouncementDismissal(userId!, id, false);
      } catch {
        if (active() && !warned.has(id)) {
          warned.add(id);
          latest.current.onSaveFailure(savedLocally);
        }
      } finally {
        clearTimeout(timer);
        writes.delete(id);
      }
    }

    async function flush() {
      for (const [id, pending] of readAnnouncementDismissals(userId!)) {
        if (!active()) return;
        if (pending) await sync(id);
      }
    }

    function suspend() {
      generation++;
      clearTimeout(settleTimer);
      fetchController?.abort();
      fetchController = null;
      setState(null);
    }

    function resume() {
      if (!active() || document.visibilityState === "hidden") return;
      suspend();
      const currentGeneration = generation;
      const controller = new AbortController();
      fetchController = controller;
      const stillCurrent = () => active() && generation === currentGeneration && !controller.signal.aborted;
      let settled = false;
      let loaded = false;
      let candidate: Announcement | null = null;
      const show = () => {
        if (!stillCurrent() || !settled || !loaded) return;
        if (candidate && !readAnnouncementDismissals(userId!).has(candidate.id)
          && (!candidate.expiresAt || Date.parse(candidate.expiresAt) > Date.now())) {
          setState({ userId: userId!, announcement: candidate });
        }
      };
      settleTimer = setTimeout(() => { settled = true; show(); }, ANNOUNCEMENT_SETTLE_MS);
      void flush();
      void announcementsApi.current(controller.signal).then((value) => {
        candidate = value;
        loaded = true;
        show();
      }).catch(() => { /* Optional content stays absent when state is unknown. */ });
    }

    function receive() {
      const dismissed = readAnnouncementDismissals(userId!);
      setState((previous) => previous?.userId === userId && dismissed.has(previous.announcement.id) ? null : previous);
    }
    function onStorage(event: StorageEvent) { if (event.key?.startsWith(prefix)) receive(); }
    function onVisibility() { if (document.visibilityState === "hidden") suspend(); else resume(); }
    function onOnline() { void flush(); }
    if (channel) channel.onmessage = (event) => {
      const id = announcementIdSchema.safeParse(event.data);
      if (!id.success) return;
      // BroadcastChannel also works when persistent storage is unavailable.
      if (!readAnnouncementDismissals(userId!).has(id.data)) saveAnnouncementDismissal(userId!, id.data, true);
      receive();
    };
    dismissRef.current = (id) => {
      if (!active()) return;
      const savedLocally = saveAnnouncementDismissal(userId, id, true);
      setState(null);
      // Invalidate any response that started before this dismissal.
      generation++;
      fetchController?.abort();
      try { channel?.postMessage(id); } catch { /* Storage events are the fallback. */ }
      void sync(id, savedLocally);
    };
    // Window focus also changes for browser chrome and adjacent app panes.
    // Only leaving/returning to the tab should clear and revalidate its card.
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    window.addEventListener("storage", onStorage);
    resume();
    return () => {
      disposed = true;
      generation++;
      clearTimeout(settleTimer);
      fetchController?.abort();
      for (const controller of writes.values()) controller.abort();
      channel?.close();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("storage", onStorage);
      dismissRef.current = () => {};
    };
  }, [userId, enabled]);

  const announcement = enabled && state?.userId === userId ? state.announcement : null;
  useEffect(() => {
    if (!announcement?.expiresAt) return;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const remaining = Date.parse(announcement.expiresAt!) - Date.now();
      if (remaining <= 0) setState(null);
      else timer = setTimeout(check, Math.min(remaining, 2_147_483_647));
    };
    check();
    return () => clearTimeout(timer);
  }, [announcement]);
  return { announcement, dismiss: useCallback((id: string) => dismissRef.current(id), []) };
}
