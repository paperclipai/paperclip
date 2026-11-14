type Method = (this: unknown, ...args: unknown[]) => unknown;

export function installPreparedQueries(client: unknown): void {
  const visited = new WeakSet<object>();

  function visit(value: unknown): void {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") return;
    if (visited.has(value)) return;
    visited.add(value);
    const target = value as Record<string, unknown>;
    const unsafe = target.unsafe;
    if (typeof unsafe === "function") {
      target.unsafe = function (this: unknown, ...args: unknown[]) {
        const index = args.length === 2 && !Array.isArray(args[1]) ? 1 : 2;
        const options = args[index];
        if (options !== undefined && (options === null || typeof options !== "object")) {
          return Reflect.apply(unsafe, this, args);
        }
        if (index === 2 && args.length < 2) args[1] = [];
        args[index] = { prepare: true, ...options };
        return Reflect.apply(unsafe, this, args);
      };
    }
    for (const method of ["begin", "savepoint"]) {
      const original = target[method];
      if (typeof original !== "function") continue;
      target[method] = function (this: unknown, ...args: unknown[]) {
        const wrapped = args.map(arg => typeof arg !== "function" ? arg : function (this: unknown, ...inner: unknown[]) {
          visit(inner[0]);
          return Reflect.apply(arg, this, inner);
        });
        return Reflect.apply(original, this, wrapped);
      } satisfies Method;
    }
    const reserve = target.reserve;
    if (typeof reserve === "function") {
      target.reserve = function (this: unknown, ...args: unknown[]) {
        return Promise.resolve(Reflect.apply(reserve, this, args)).then(reserved => {
          visit(reserved);
          return reserved;
        });
      } satisfies Method;
    }
  }

  visit(client);
}
