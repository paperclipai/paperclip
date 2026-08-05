import { serve } from '@hono/node-server';
import { createApp } from './server.js';

const port = Number(process.env.PORT ?? 8090);
const app = createApp();

serve({ fetch: app.fetch, port }, () => {
  console.log(`Review UI listening on :${port}`);
});
