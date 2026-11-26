import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import { restartChatServer } from "./chat-restart.js";

test("unloads the old browser client before server restart and opens the new document", async ({ page }) => {
  let generation = 1;
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<input data-testid="composer" value="server generation ${generation}"><script>setInterval(() => fetch('/probe').catch(() => {}), 50)</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    await page.goto(url);
    await expect(page.getByTestId("composer")).toHaveValue("server generation 1");
    await restartChatServer(page, async () => {
      expect(page.url(), "The old client must be gone before it can auto-reload").toBe("about:blank");
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      generation += 1;
      await new Promise<void>(resolve => server.listen(address.port, "127.0.0.1", resolve));
    });
    await page.goto(url, { waitUntil: "commit" });
    await expect(page.getByTestId("composer")).toHaveValue("server generation 2");
  } finally {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
});
