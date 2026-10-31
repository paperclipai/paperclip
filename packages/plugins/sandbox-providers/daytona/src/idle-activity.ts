import type { PluginDefinition } from "@paperclipai/plugin-sdk";
import { AsyncLocalStorage } from "node:async_hooks";

type Scope = { resources: Set<string>; active: number };
type Request = { parent?: Request; scope: Scope };

type Resource = {
  keys: Set<string>;
  absenceProofKeys: Set<string>;
  confirmed: boolean;
  revision: number;
  scopeRevisions: Map<Scope, number>;
};

export type DaytonaIdleProof = { key: string; scope?: Scope; revisions: Map<Resource, number> };

/** Worker-local evidence complements the host's durable lease and task gates. */
export class DaytonaIdleActivity {
  private readonly requests = new Set<Request>();
  private readonly current = new AsyncLocalStorage<Request>();
  private readonly resources = new Map<string, Set<Resource>>();

  track<T>(run: () => Promise<T>): Promise<T> {
    const parent = this.current.getStore();
    const scope = parent?.scope ?? { resources: new Set<string>(), active: 0 };
    const request: Request = { parent, scope };
    scope.active++;
    this.requests.add(request);
    this.bumpScope(scope);
    const settled = () => {
      this.bumpScope(scope);
      this.requests.delete(request);
      if (--scope.active === 0) {
        for (const key of scope.resources) {
          for (const resource of this.resources.get(key) ?? []) resource.scopeRevisions.delete(scope);
        }
      }
    };
    let pending: Promise<T>;
    try {
      pending = this.current.run(request, run);
    } catch (error) {
      settled();
      throw error;
    }
    return Promise.resolve(pending).then(
      (value) => { settled(); return value; },
      (error: unknown) => { settled(); throw error; },
    );
  }

  resource(key: string, provisional = false): Resource {
    const existing = this.resources.get(key)?.values().next().value;
    if (existing) { this.bindKey(key); return existing; }
    const resource: Resource = {
      keys: new Set([key]),
      absenceProofKeys: new Set(provisional ? [] : [key]),
      confirmed: false,
      revision: 0,
      scopeRevisions: new Map(),
    };
    this.resources.set(key, new Set([resource]));
    this.bindKey(key);
    return resource;
  }

  /** Attach an observed immutable ID without reviving a confirmed allocation. */
  observe(resource: Resource, key: string): void {
    if (resource.confirmed) return;
    resource.keys.add(key);
    resource.absenceProofKeys.add(key);
    const linked = this.resources.get(key) ?? new Set<Resource>();
    linked.add(resource);
    this.resources.set(key, linked);
    this.bindKey(key);
  }

  private bump(resource: Resource, scope: Scope): void {
    resource.revision++;
    resource.scopeRevisions.set(scope, (resource.scopeRevisions.get(scope) ?? 0) + 1);
  }

  private bumpScope(scope: Scope): void {
    const touched = new Set<Resource>();
    for (const key of scope.resources) for (const resource of this.resources.get(key) ?? []) touched.add(resource);
    for (const resource of touched) this.bump(resource, scope);
  }

  private bindKey(key: string): void {
    const scope = this.current.getStore()?.scope;
    if (!scope || scope.resources.has(key)) return;
    scope.resources.add(key);
    for (const resource of this.resources.get(key) ?? []) this.bump(resource, scope);
  }

  private foreignRevision(resource: Resource, scope?: Scope): number {
    return resource.revision - (scope ? resource.scopeRevisions.get(scope) ?? 0 : 0);
  }

  /** Capture before the provider read/stop/delete, never after its reply. */
  proof(key: string): DaytonaIdleProof {
    this.bindKey(key);
    const scope = this.current.getStore()?.scope;
    return { key, scope, revisions: new Map([...(this.resources.get(key) ?? [])]
      .map(resource => [resource, this.foreignRevision(resource, scope)])) };
  }

  confirm(proof: DaytonaIdleProof, absenceOnly = false): void {
    const { key, scope } = proof;
    const ownChain = new Set<Request>();
    for (let request = this.current.getStore(); request; request = request.parent) ownChain.add(request);
    for (const resource of [...(this.resources.get(key) ?? [])]) {
      // Work that began or finished during the provider observation makes that
      // observation stale even when every overlapping request has now settled.
      if (!proof.revisions.has(resource) || proof.revisions.get(resource) !== this.foreignRevision(resource, scope)) continue;
      // Ignore the receipt's own call chain, but never a child request that
      // outlived its deadline or another operation on the same allocation.
      // Unrelated sandbox cleanup must not leave a permanent blocker.
      if ([...this.requests].some(request => !ownChain.has(request) &&
        [...resource.keys].some(alias => request.scope.resources.has(alias)))) continue;
      // An unobserved create name can materialize after a not-found response.
      if (absenceOnly && !resource.absenceProofKeys.has(key)) continue;
      resource.confirmed = true;
      for (const alias of resource.keys) {
        const linked = this.resources.get(alias);
        linked?.delete(resource);
        if (linked?.size === 0) this.resources.delete(alias);
      }
    }
  }

  present(): boolean {
    return this.requests.size > 0 || this.resources.size > 0;
  }

  resetForTest(): void {
    for (const allocations of this.resources.values()) {
      for (const allocation of allocations) allocation.confirmed = true;
    }
    this.requests.clear();
    this.resources.clear();
  }
}

/** Count hooks before they start, including terminal/PTY setup before registration. */
export function trackDaytonaHooks(definition: PluginDefinition, activity: DaytonaIdleActivity): PluginDefinition {
  const tracked = { ...definition };
  for (const [name, hook] of Object.entries(definition)) {
    if (!name.startsWith("on") || name === "onIdleDrain" || name === "onHealth" || typeof hook !== "function") continue;
    Object.defineProperty(tracked, name, {
      enumerable: true,
      value: (...args: unknown[]) => activity.track(async () => Reflect.apply(hook, definition, args)),
    });
  }
  return tracked;
}
