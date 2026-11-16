import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../../server/package.json', import.meta.url));
const { tsImport } = await import(require.resolve('tsx/esm/api'));
export const costRuntime = await tsImport('./shared-cost-runtime.ts', import.meta.url);
