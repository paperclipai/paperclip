export interface PushSendResult {
  statusCode: number;
}

export interface PushTransport {
  send(
    subscription: { endpoint: string; p256dh: string; auth: string },
    payload: unknown,
  ): Promise<PushSendResult>;
}

interface WebPushModule {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
  ): Promise<PushSendResult>;
}

export interface WebPushTransportConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/**
 * The `web-push` package is not yet an installed dependency — SAG-7600 defers
 * install to CTO board approval. This dynamic import resolves it at runtime
 * once the package lands; until then, `send()` throws and callers (push-fanout)
 * record the failure rather than crashing the caller.
 */
export function createWebPushTransport(config: WebPushTransportConfig): PushTransport {
  let modulePromise: Promise<WebPushModule> | null = null;

  async function loadWebPush(): Promise<WebPushModule> {
    if (!modulePromise) {
      modulePromise = (async () => {
        // @ts-expect-error web-push is not yet installed (blocked on board approval, see SAG-7600)
        const imported = await import("web-push");
        const webPush = (imported.default ?? imported) as WebPushModule;
        webPush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
        return webPush;
      })();
    }
    return modulePromise;
  }

  return {
    async send(subscription, payload) {
      const webPush = await loadWebPush();
      return webPush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        JSON.stringify(payload),
      );
    },
  };
}
