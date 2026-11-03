// Configure the disposable instance through the same onboarding boundary used
// by `run`, without onboarding's --yes foreground auto-start. The next command
// starts server/dist/index.js explicitly so measured hot paths stay compiled.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.env.NODE_ENV !== 'test') throw new Error('Ingestion bootstrap is only for an isolated test instance');
if (!process.env.PAPERCLIP_HOME || !process.env.PAPERCLIP_CONFIG) throw new Error('Missing isolated instance paths');
const { onboard } = await import(pathToFileURL(path.resolve('cli/src/commands/onboard.ts')).href);
await onboard({ yes: true, bind: 'loopback', installService: false, invokedByRun: true });
