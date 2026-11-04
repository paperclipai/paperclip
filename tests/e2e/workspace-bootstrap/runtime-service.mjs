import { createServer } from "node:http";

createServer((_request, response) => {
  response.end("workspace runtime service ready");
}).listen(Number(process.env.PORT), "127.0.0.1");
