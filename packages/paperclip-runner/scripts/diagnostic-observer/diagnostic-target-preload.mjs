import { installTargetObserver } from './diagnostic-target-observer.ts';
const config = process.env.PAPERCLIP_E2E_DIAGNOSTIC_OBSERVER;
const close = config ? await installTargetObserver(config).catch(() => async () => {}) : async () => {};
process.once('beforeExit', () => { void close(); });
