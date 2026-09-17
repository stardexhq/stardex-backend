import type { IncomingMessage, ServerResponse } from "node:http";
import { listAccounts } from "./accounts.ts";
import { requireAdmin } from "./auth.ts";
import { pingDb } from "./db.ts";
import { listEvents } from "./events.ts";
import { exportInvoices, exportPayments } from "./exports.ts";
import { HttpError, sendJson } from "./http.ts";
import { cancelInvoice, createInvoice, getInvoice, listInvoices } from "./invoices.ts";
import { ignorePayment, listPayments, matchPayment } from "./payments.ts";
import { matchRoute, type Context, type Route } from "./router.ts";

async function health({ res }: Context): Promise<void> {
  const dbOk = await pingDb();
  sendJson(res, dbOk ? 200 : 503, { status: dbOk ? "ok" : "degraded", db: dbOk });
}

export const routes: Route[] = [
  { method: "GET", path: "/health", admin: false, handler: health },
  { method: "GET", path: "/events", admin: false, handler: listEvents },
  { method: "GET", path: "/accounts", admin: true, handler: listAccounts },
  { method: "GET", path: "/invoices", admin: true, handler: listInvoices },
  { method: "POST", path: "/invoices", admin: true, handler: createInvoice },
  { method: "GET", path: "/invoices/:id", admin: true, handler: getInvoice },
  { method: "POST", path: "/invoices/:id/cancel", admin: true, handler: cancelInvoice },
  { method: "GET", path: "/payments", admin: true, handler: listPayments },
  { method: "POST", path: "/payments/:id/match", admin: true, handler: matchPayment },
  { method: "POST", path: "/payments/:id/ignore", admin: true, handler: ignorePayment },
  { method: "GET", path: "/exports/payments.csv", admin: true, handler: exportPayments },
  { method: "GET", path: "/exports/invoices.csv", admin: true, handler: exportInvoices },
];

/** Handle one HTTP request: CORS, routing, auth and error responses. */
export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  // Browser apps on any origin may call the API; business routes still need the key.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, content-type");
  res.setHeader("access-control-expose-headers", "content-disposition");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const match = matchRoute(routes, req.method ?? "GET", url.pathname);
    if (match.kind === "not-found") throw new HttpError(404, "not found");
    if (match.kind === "method-not-allowed") throw new HttpError(405, "method not allowed");

    if (match.route.admin) requireAdmin(req);
    await match.route.handler({ req, res, url, params: match.params });
  } catch (err) {
    if (res.headersSent) {
      // A streamed response (CSV) failed part way; all we can do is cut it off.
      console.error(err);
      res.destroy();
      return;
    }
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: err.message });
      return;
    }
    console.error(err);
    sendJson(res, 500, { error: "internal error" });
  }
}
