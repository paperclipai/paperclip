import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register('echo', async params => params);
    ctx.data.register('host-response', async () => ctx.companies.get('company-1'));
    ctx.data.register('worker-response', async () => ({ text: '中文\u2028第一段\u2029第二段' }));
  },
});
export default plugin;
runWorker(plugin, import.meta.url);
