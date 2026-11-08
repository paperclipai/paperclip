import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import { dropChatSendAcknowledgement } from "./lost-send.js";

test("drops the browser response only after the real server committed its comment", async ({ page }) => {
  const requests: unknown[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "saved-comment" }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<button onclick="send()">Send</button><output></output><script>
      async function send() {
        try {
          await fetch('/api/issues/chat/comments', { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({body:'Create PLAN123',clientRequestId:'original-key'}) });
          document.querySelector('output').textContent = 'acknowledged';
        } catch { document.querySelector('output').textContent = 'response lost'; }
      }
    </script>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture listener");
  const interception = await dropChatSendAcknowledgement(page, "PLAN123");
  try {
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole("button", { name: "Send" }).click();
    expect(await interception.committed).toEqual({
      path: "/api/issues/chat/comments",
      data: { body: "Create PLAN123", clientRequestId: "original-key" },
      commentId: "saved-comment",
    });
    expect(requests).toEqual([{ body: "Create PLAN123", clientRequestId: "original-key" }]);
    await expect(page.locator("output")).toHaveText("response lost");
    await interception.dispose();
    await page.reload();
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator("output")).toHaveText("acknowledged");
    expect(requests).toHaveLength(2);
  } finally {
    await interception.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
