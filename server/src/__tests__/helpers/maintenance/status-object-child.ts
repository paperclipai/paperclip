import { installDefaultCadenceNetwork, defaultCadenceNetwork } from './default-cadence-network.js';
installDefaultCadenceNetwork();
const send = process.send;
if (send) process.send = function(message: unknown, ...args: unknown[]) {
  const value = message && typeof message === 'object' ? { ...message, defaultCadenceGuard: defaultCadenceNetwork() } : message;
  return Reflect.apply(send, process, [value, ...args]);
} as NonNullable<typeof process.send>;
await import('./server-child.js');
