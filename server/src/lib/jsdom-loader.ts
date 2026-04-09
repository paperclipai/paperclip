export async function loadJsdom(): Promise<typeof import("jsdom")> {
  return import("jsdom");
}
