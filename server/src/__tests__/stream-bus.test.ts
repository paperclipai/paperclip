import { describe, expect, it, vi } from "vitest";
import { createStreamBus, type StreamBusListener } from "../services/stream-bus.js";

describe("StreamBus primitive", () => {
  describe("subscribe / publish basics", () => {
    it("delivers published events to the matching (topic, key) subscriber", () => {
      const bus = createStreamBus();
      const received: Array<{ event: unknown; type: string }> = [];

      bus.subscribe("plugin", "a:b:c", (event, meta) => {
        received.push({ event, type: meta.type });
      });

      bus.publish("plugin", "a:b:c", { hello: "world" });
      expect(received).toEqual([{ event: { hello: "world" }, type: "message" }]);
    });

    it("passes through the event type", () => {
      const bus = createStreamBus();
      const received: string[] = [];

      bus.subscribe("plugin", "k", (_event, meta) => received.push(meta.type));
      bus.publish("plugin", "k", {}, "open");
      bus.publish("plugin", "k", {}, "close");
      bus.publish("plugin", "k", {}, "error");
      bus.publish("plugin", "k", {}); // default "message"

      expect(received).toEqual(["open", "close", "error", "message"]);
    });

    it("does not deliver to subscribers of a different key", () => {
      const bus = createStreamBus();
      const listenerA = vi.fn();
      const listenerB = vi.fn();

      bus.subscribe("plugin", "keyA", listenerA);
      bus.subscribe("plugin", "keyB", listenerB);

      bus.publish("plugin", "keyA", "payload-for-A");

      expect(listenerA).toHaveBeenCalledTimes(1);
      expect(listenerB).not.toHaveBeenCalled();
    });

    it("does not deliver to subscribers of a different topic with the same key", () => {
      const bus = createStreamBus();
      const pluginListener = vi.fn();
      const roomListener = vi.fn();

      bus.subscribe("plugin", "same-key", pluginListener);
      bus.subscribe("room", "same-key", roomListener);

      bus.publish("plugin", "same-key", "plugin-event");

      expect(pluginListener).toHaveBeenCalledWith("plugin-event", { type: "message" });
      expect(roomListener).not.toHaveBeenCalled();
    });

    it("fans out to multiple subscribers on the same (topic, key)", () => {
      const bus = createStreamBus();
      const a = vi.fn();
      const b = vi.fn();
      const c = vi.fn();

      bus.subscribe("room", "room-1", a);
      bus.subscribe("room", "room-1", b);
      bus.subscribe("room", "room-1", c);

      bus.publish("room", "room-1", { msg: 1 });

      expect(a).toHaveBeenCalledOnce();
      expect(b).toHaveBeenCalledOnce();
      expect(c).toHaveBeenCalledOnce();
    });

    it("is a no-op for publish without subscribers", () => {
      const bus = createStreamBus();
      // Should not throw
      expect(() => bus.publish("plugin", "none", "hi")).not.toThrow();
    });
  });

  describe("unsubscribe", () => {
    it("stops delivering after unsubscribe", () => {
      const bus = createStreamBus();
      const listener = vi.fn();
      const unsub = bus.subscribe("plugin", "k", listener);

      bus.publish("plugin", "k", 1);
      unsub();
      bus.publish("plugin", "k", 2);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(1, { type: "message" });
    });

    it("removes the Map entry when the last subscriber leaves", () => {
      const bus = createStreamBus();
      const unsub = bus.subscribe("plugin", "k", () => {});

      expect(bus.stats()).toEqual([{ topic: "plugin", key: "k", count: 1 }]);

      unsub();

      expect(bus.stats()).toEqual([]);
    });

    it("is safe to call unsubscribe twice", () => {
      const bus = createStreamBus();
      const listener = vi.fn();
      const unsub = bus.subscribe("plugin", "k", listener);

      unsub();
      unsub(); // should not throw

      bus.publish("plugin", "k", "x");
      expect(listener).not.toHaveBeenCalled();
    });

    it("safe to unsubscribe during publish iteration", () => {
      const bus = createStreamBus();
      const order: string[] = [];

      let unsubB: (() => void) | null = null;

      const a: StreamBusListener = () => order.push("a");
      const b: StreamBusListener = () => {
        order.push("b");
        unsubB?.();
      };
      const c: StreamBusListener = () => order.push("c");

      bus.subscribe("plugin", "k", a);
      unsubB = bus.subscribe("plugin", "k", b);
      bus.subscribe("plugin", "k", c);

      bus.publish("plugin", "k", 1);

      // All three receive the first event
      expect(order).toEqual(["a", "b", "c"]);

      // Second publish: b is gone
      bus.publish("plugin", "k", 2);
      expect(order).toEqual(["a", "b", "c", "a", "c"]);
    });
  });

  describe("error isolation", () => {
    it("throwing listener does not affect other subscribers", () => {
      const bus = createStreamBus();
      const good1 = vi.fn();
      const bad = vi.fn(() => {
        throw new Error("boom");
      });
      const good2 = vi.fn();

      bus.subscribe("plugin", "k", good1);
      bus.subscribe("plugin", "k", bad);
      bus.subscribe("plugin", "k", good2);

      expect(() => bus.publish("plugin", "k", "payload")).not.toThrow();

      expect(good1).toHaveBeenCalledOnce();
      expect(bad).toHaveBeenCalledOnce();
      expect(good2).toHaveBeenCalledOnce();
    });
  });

  describe("stats + clear", () => {
    it("reports per-(topic, key) subscriber counts", () => {
      const bus = createStreamBus();
      bus.subscribe("plugin", "k1", () => {});
      bus.subscribe("plugin", "k1", () => {});
      bus.subscribe("room", "r1", () => {});

      const stats = bus.stats().sort((a, b) => a.topic.localeCompare(b.topic) || a.key.localeCompare(b.key));
      expect(stats).toEqual([
        { topic: "plugin", key: "k1", count: 2 },
        { topic: "room", key: "r1", count: 1 },
      ]);
    });

    it("clear() drops all subscribers", () => {
      const bus = createStreamBus();
      const listener = vi.fn();
      bus.subscribe("plugin", "k", listener);
      bus.subscribe("room", "r", listener);

      bus.clear();

      bus.publish("plugin", "k", "x");
      bus.publish("room", "r", "y");
      expect(listener).not.toHaveBeenCalled();
      expect(bus.stats()).toEqual([]);
    });
  });

  describe("topic / key isolation with NUL-byte composite", () => {
    it("prevents topic/key collision even with unusual characters", () => {
      const bus = createStreamBus();
      const a = vi.fn();
      const b = vi.fn();

      // Artificial: topic "foo", key ":bar" vs topic "foo:", key "bar"
      // With naive string concat ("foo:bar" vs "foo::bar") both would be
      // distinct but a simpler join could collide. The NUL byte separator
      // guarantees isolation regardless.
      bus.subscribe("foo", ":bar", a);
      bus.subscribe("foo:", "bar", b);

      bus.publish("foo", ":bar", 1);
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).not.toHaveBeenCalled();

      bus.publish("foo:", "bar", 2);
      expect(b).toHaveBeenCalledTimes(1);
    });
  });
});
