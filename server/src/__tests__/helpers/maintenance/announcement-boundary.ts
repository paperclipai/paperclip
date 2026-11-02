import { mock } from 'node:test';
import { DEFAULT_ANNOUNCEMENT_FEED_URL, announcementManifestSchema } from '@paperclipai/shared';

/** Test-child transport seam: actual route/feed/cache, no DNS or HTTPS claim. */
export async function installMaintenanceAnnouncementBoundary() {
  const actual = await import('../../../app.js');
  const requests: string[] = [], unmatched: string[] = [];
  let intercepted = false;
  const manifest = announcementManifestSchema.parse({ schemaVersion: 1, announcement: {
    id: 'new-projects', eyebrow: 'New', title: 'Projects', description: 'Organize your work.',
    primaryAction: { kind: 'route', label: 'Open', path: '/projects' },
  } });
  const wrapped: typeof actual.createApp = (db, options) => {
    const announcements = options.announcements;
    if (!announcements?.enabled || announcements.feedUrl !== DEFAULT_ANNOUNCEMENT_FEED_URL) {
      throw new Error('Configured announcement boundary requires the exact enabled default feed');
    }
    intercepted = true;
    const fetch = async (url: URL, init: RequestInit) => {
      if (url.href !== DEFAULT_ANNOUNCEMENT_FEED_URL || init.method !== 'GET') {
        unmatched.push(url.href);
        throw new Error('Unmatched announcement transport is forbidden');
      }
      requests.push(url.href);
      return Response.json(manifest, { headers: { ETag: '"qualification-v1"' } });
    };
    const withTransport = { ...options, announcements: { ...announcements, fetch } };
    return actual.createApp(db, withTransport);
  };
  mock.module(new URL('../../../app.ts', import.meta.url).href, { namedExports: { ...actual, createApp: wrapped } });
  // Fail before server startup if the TS loader/module cache bypasses the mock.
  if ((await import('../../../app.js')).createApp !== wrapped) throw new Error('Announcement module boundary did not intercept the startup import');
  return { assertIntercepted() { if (!intercepted) throw new Error('Actual server bypassed the announcement boundary'); },
    snapshot: () => ({ intercepted, requests: [...requests], unmatched: [...unmatched],
      boundary: 'Feed transport injected through existing fetch seam; actual route/feed validation/cache/UI. DNS and HTTPS guard are not exercised in this combined case.' }) };
}
