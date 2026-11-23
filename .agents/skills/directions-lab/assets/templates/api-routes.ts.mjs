export default () => `import { registerApiRoute } from "./api-stub";
import { registry } from "./registry";

let flags: Record<string, boolean> = { ...registry.today.flags };

export const currentFlags = (): Record<string, boolean> => flags;

export function setLabFlags(next: Record<string, boolean>): void {
  flags = { ...next };
}

export function registerFeatureRoutes(): void {}

registerApiRoute((pathname) => (pathname.endsWith("/instance/settings/experimental") ? currentFlags() : undefined));
registerFeatureRoutes();
`;
