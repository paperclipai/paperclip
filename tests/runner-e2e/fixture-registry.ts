export interface FixtureDefinition<T = unknown> {
  id: string;
  dependencies?: readonly string[];
  setup(resolved: ReadonlyMap<string, unknown>): Promise<T>;
  teardown?(value: T, resolved: ReadonlyMap<string, unknown>): Promise<void>;
}

export class FixtureRegistry {
  readonly #definitions = new Map<string, FixtureDefinition>();

  register<T>(definition: FixtureDefinition<T>) {
    if (this.#definitions.has(definition.id))
      throw new Error(`Duplicate fixture id: ${definition.id}`);
    this.#definitions.set(definition.id, definition as FixtureDefinition);
    return this;
  }

  async setupAll() {
    const resolved = new Map<string, unknown>();
    const completed: FixtureDefinition[] = [];
    const visiting = new Set<string>();

    const setup = async (id: string): Promise<void> => {
      if (resolved.has(id)) return;
      if (visiting.has(id))
        throw new Error(`Fixture dependency cycle at ${id}`);
      const definition = this.#definitions.get(id);
      if (!definition) throw new Error(`Unknown fixture dependency: ${id}`);
      visiting.add(id);
      for (const dependency of definition.dependencies ?? [])
        await setup(dependency);
      visiting.delete(id);
      const value = await definition.setup(resolved);
      resolved.set(id, value);
      completed.push(definition);
    };

    try {
      for (const id of this.#definitions.keys()) await setup(id);
    } catch (setupError) {
      try {
        await this.#teardown(completed, resolved);
      } catch (teardownError) {
        throw new AggregateError(
          [setupError, teardownError],
          `Fixture setup failed and cleanup failed: ${teardownError instanceof Error ? teardownError.message : String(teardownError)}`,
        );
      }
      throw setupError;
    }

    return {
      values: resolved,
      teardown: () => this.#teardown(completed, resolved),
    };
  }

  async #teardown(
    completed: FixtureDefinition[],
    resolved: Map<string, unknown>,
  ) {
    const errors: Error[] = [];
    for (const definition of [...completed].reverse()) {
      if (!definition.teardown) continue;
      try {
        await definition.teardown(resolved.get(definition.id), resolved);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (errors.length > 0)
      throw new AggregateError(errors, "Fixture teardown failed");
  }
}
