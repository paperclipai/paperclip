import net from "node:net";

export function checkPort(
  port: number,
  host: string = "127.0.0.1",
): Promise<{ available: boolean; error?: string }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve({ available: false, error: `Port ${port} is already in use` });
      } else {
        resolve({ available: false, error: err.message });
      }
    });
    server.once("listening", () => {
      server.close(() => resolve({ available: true }));
    });
    server.listen(port, host);
  });
}
