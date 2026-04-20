export const config = {
  apiKey: process.env.HUNTER_API_KEY ?? "",
  baseUrl: "https://api.hunter.io/v2",
};

if (!config.apiKey) {
  throw new Error("HUNTER_API_KEY environment variable is required");
}
