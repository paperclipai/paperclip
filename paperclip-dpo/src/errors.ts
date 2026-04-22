export class MappingNotFoundError extends Error {
  readonly code = "mapping_not_found";
  constructor(mappingId: string) {
    super(`mapping not found: ${mappingId}`);
    this.name = "MappingNotFoundError";
  }
}
