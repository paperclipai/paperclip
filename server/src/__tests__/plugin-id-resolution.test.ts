import { describe, it, expect, vi, beforeEach } from "vitest";

// UUID Regex from server/src/routes/plugins.ts (implied)
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function resolvePlugin(
  registry: any,
  pluginId: string,
) {
  const byIdFirst = UUID_REGEX.test(pluginId);
  let plugin = byIdFirst
    ? await registry.getById(pluginId)
    : await registry.getByKey(pluginId);
  if (!plugin) {
    plugin = byIdFirst
      ? await registry.getByKey(pluginId)
      : await registry.getById(pluginId);
  }
  return plugin;
}

describe("resolvePlugin (Server Unit)", () => {
  const mockRegistry = {
    getById: vi.fn(),
    getByKey: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const UUID = "550e8400-e29b-41d4-a716-446655440000";
  const KEY = "paperclip.test-plugin";

  it("prioritizes getById when pluginId is a UUID", async () => {
    mockRegistry.getById.mockResolvedValue({ id: UUID, key: KEY });
    
    const result = await resolvePlugin(mockRegistry, UUID);
    
    expect(mockRegistry.getById).toHaveBeenCalledWith(UUID);
    expect(mockRegistry.getByKey).not.toHaveBeenCalled();
    expect(result.id).toBe(UUID);
  });

  it("prioritizes getByKey when pluginId is NOT a UUID", async () => {
    mockRegistry.getByKey.mockResolvedValue({ id: UUID, key: KEY });
    
    const result = await resolvePlugin(mockRegistry, KEY);
    
    expect(mockRegistry.getByKey).toHaveBeenCalledWith(KEY);
    expect(mockRegistry.getById).not.toHaveBeenCalled();
    expect(result.key).toBe(KEY);
  });

  it("falls back to getByKey if UUID lookup fails (rare case)", async () => {
    mockRegistry.getById.mockResolvedValue(null);
    mockRegistry.getByKey.mockResolvedValue({ id: "other", key: UUID });
    
    const result = await resolvePlugin(mockRegistry, UUID);
    
    expect(mockRegistry.getById).toHaveBeenCalledWith(UUID);
    expect(mockRegistry.getByKey).toHaveBeenCalledWith(UUID);
    expect(result.id).toBe("other");
  });

  it("falls back to getById if KEY lookup fails (rare case)", async () => {
    mockRegistry.getByKey.mockResolvedValue(null);
    mockRegistry.getById.mockResolvedValue({ id: KEY, key: "other" });
    
    const result = await resolvePlugin(mockRegistry, KEY);
    
    expect(mockRegistry.getByKey).toHaveBeenCalledWith(KEY);
    expect(mockRegistry.getById).toHaveBeenCalledWith(KEY);
    expect(result.id).toBe(KEY);
  });

  it("returns null if both lookups fail", async () => {
    mockRegistry.getById.mockResolvedValue(null);
    mockRegistry.getByKey.mockResolvedValue(null);
    
    const result = await resolvePlugin(mockRegistry, "anything");
    expect(result).toBeNull();
  });
});
