/** Stardex backend HTTP server. Routes live in `app.ts`. */
import { createServer } from "node:http";
import { handle } from "./app.ts";

const PORT = Number(process.env.PORT ?? 8080);

if (!process.env.STARDEX_ADMIN_KEY) {
  console.warn(
    "STARDEX_ADMIN_KEY is not set: /health and /events work, but invoice, payment and export routes return 503",
  );
}

createServer((req, res) => {
  void handle(req, res);
}).listen(PORT, () => {
  console.log(`Stardex backend listening on http://localhost:${PORT}`);
});
