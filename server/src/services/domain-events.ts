import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { PluginEventType } from "@paperclipai/shared";
import type { PluginEvent } from "@paperclipai/plugin-sdk";

export interface DomainEvent<TPayload = any> {
  type: PluginEventType;
  companyId: string;
  payload: TPayload;
  actorType?: "user" | "agent" | "system" | "plugin";
  actorId?: string;
  entityType?: string;
  entityId?: string;
}

type DomainEventListener = (event: PluginEvent) => void;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export function emitDomainEvent(event: DomainEvent) {
  const pluginEvent: PluginEvent = {
    eventId: randomUUID(),
    eventType: event.type,
    companyId: event.companyId,
    occurredAt: new Date().toISOString(),
    actorType: event.actorType,
    actorId: event.actorId,
    entityType: event.entityType,
    entityId: event.entityId,
    payload: event.payload,
  };

  emitter.emit("event", pluginEvent);
  emitter.emit(`type:${event.type}`, pluginEvent);
  emitter.emit(`company:${event.companyId}`, pluginEvent);
}

export function subscribeDomainEvents(listener: DomainEventListener) {
  emitter.on("event", listener);
  return () => emitter.off("event", listener);
}
