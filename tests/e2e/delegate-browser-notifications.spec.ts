import { expect, test, type Page } from "@playwright/test";

declare global {
  interface Window {
    __paperclipNotifications: Array<{
      body: string;
      click: () => void;
      closed: boolean;
      dataHref: string;
      renotify: boolean;
      tag: string;
      title: string;
    }>;
  }
}

async function installNotificationHarness(page: Page) {
  await page.addInitScript(() => {
    const permissionStorageKey = "paperclip:e2e-notification-permission";
    let permission: NotificationPermission = (() => {
      try {
        return localStorage.getItem(permissionStorageKey) === "granted" ? "granted" : "default";
      } catch {
        return "default";
      }
    })();
    window.__paperclipNotifications = [];

    const recordNotification = (
      title: string,
      options: NotificationOptions,
      click: () => void,
    ) => {
      const extendedOptions = options as NotificationOptions & {
        data?: { href?: string };
        renotify?: boolean;
      };
      const record = {
        title,
        body: options.body ?? "",
        tag: options.tag ?? "",
        closed: false,
        dataHref: extendedOptions.data?.href ?? "",
        renotify: extendedOptions.renotify === true,
        click,
      };
      window.__paperclipNotifications.push(record);
      return record;
    };

    class FakeNotification {
      static get permission() {
        return permission;
      }

      static async requestPermission() {
        permission = "granted";
        localStorage.setItem(permissionStorageKey, permission);
        return permission;
      }

      onclick: ((event: Event) => void) | null = null;
      private record: Window["__paperclipNotifications"][number];

      constructor(title: string, options: NotificationOptions = {}) {
        this.record = recordNotification(title, options, () => this.onclick?.(new Event("click")));
      }

      close() {
        this.record.closed = true;
      }
    }

    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: FakeNotification,
    });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    if ("ServiceWorkerRegistration" in window) {
      Object.defineProperty(ServiceWorkerRegistration.prototype, "showNotification", {
        configurable: true,
        value: async (title: string, options: NotificationOptions = {}) => {
          const dataHref = (options as NotificationOptions & { data?: { href?: string } }).data?.href;
          recordNotification(title, options, () => {
            if (dataHref) window.location.assign(dataHref);
          });
        },
      });
      Object.defineProperty(ServiceWorkerRegistration.prototype, "getNotifications", {
        configurable: true,
        value: async (options: { tag?: string } = {}) => window.__paperclipNotifications
          .filter((notification) => !options.tag || notification.tag === options.tag)
          .map((notification) => ({ tag: notification.tag })),
      });
    }
  });
}

async function notificationTitles(page: Page) {
  return page.evaluate(() => window.__paperclipNotifications.map((notification) => notification.title));
}

test.use({ video: "on" });

test("browser notifications follow delegate review and blocker state", async ({ page }, testInfo) => {
  await installNotificationHarness(page);

  const companyResponse = await page.request.post("/api/companies", {
    data: { name: `Delegate notifications ${Date.now()}` },
  });
  expect(companyResponse.ok(), await companyResponse.text()).toBe(true);
  const company = await companyResponse.json() as { id: string; issuePrefix: string };

  try {
    const issueResponse = await page.request.post(`/api/companies/${company.id}/issues`, {
      data: {
        title: "Launch risk brief",
        status: "todo",
        estimatedReviewMinutes: 10,
      },
    });
    expect(issueResponse.ok(), await issueResponse.text()).toBe(true);
    const issue = await issueResponse.json() as { id: string; identifier: string };

    await page.goto(`/${company.issuePrefix}/today`);
    await expect(page.getByRole("heading", { name: "Browser notifications" })).toBeVisible();
    await page.getByRole("button", { name: "Enable notifications" }).click();
    await expect(page.getByRole("button", { name: "Send test" })).toBeVisible();
    await testInfo.attach("today-browser-notifications-enabled", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });

    await page.getByRole("button", { name: "Send test" }).click();
    await expect.poll(() => notificationTitles(page)).toContain("Paperclip notifications are on");
    await expect(page.getByRole("status")).toHaveText(/Chrome stored the test notification/);
    const firstTestTag = await page.evaluate(() => window.__paperclipNotifications.at(-1)?.tag);
    await page.getByRole("button", { name: "Send again" }).click();
    await expect.poll(() => page.evaluate(() => window.__paperclipNotifications.length)).toBe(2);
    const secondTestNotification = await page.evaluate(() => window.__paperclipNotifications.at(-1));
    expect(secondTestNotification).toMatchObject({
      dataHref: `/${company.issuePrefix}/today`,
      renotify: true,
    });
    expect(secondTestNotification?.tag).not.toBe(firstTestTag);

    await page.evaluate(() => {
      window.__paperclipNotifications = [];
    });
    const reviewResponse = await page.request.patch(`/api/issues/${issue.id}`, {
      data: {
        status: "in_review",
        reviewBy: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    expect(reviewResponse.ok(), await reviewResponse.text()).toBe(true);

    await page.reload();
    await expect.poll(() => notificationTitles(page)).toEqual(["Ready to review"]);
    const readyNotification = await page.evaluate(() => window.__paperclipNotifications[0]);
    expect(readyNotification.body).toBe("Launch risk brief · 10 min review");

    await page.evaluate(() => window.__paperclipNotifications[0].click());
    await page.waitForURL(new RegExp(`/${company.issuePrefix}/issues/${issue.identifier}$`));

    await page.reload();
    await expect.poll(() => notificationTitles(page)).toEqual([]);

    const blockedResponse = await page.request.patch(`/api/issues/${issue.id}`, {
      data: {
        status: "blocked",
        unblockDescriptor: { owner: "board", action: "Review the launch blocker" },
      },
    });
    expect(blockedResponse.ok(), await blockedResponse.text()).toBe(true);

    await page.reload();
    await expect.poll(() => notificationTitles(page)).toEqual(["Needs you"]);
  } finally {
    const deleteResponse = await page.request.delete(`/api/companies/${company.id}`);
    expect(deleteResponse.ok(), await deleteResponse.text()).toBe(true);
  }
});
