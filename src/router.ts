import type { IncomingMessage, ServerResponse } from "node:http";

export interface Context {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** Values captured from `:name` segments in the route path. */
  params: Record<string, string>;
}

export interface Route {
  method: "GET" | "POST";
  /** e.g. "/invoices/:id/cancel" */
  path: string;
  /** Needs the admin key. */
  admin: boolean;
  handler: (ctx: Context) => Promise<void>;
}

export type Match =
  | { kind: "found"; route: Route; params: Record<string, string> }
  | { kind: "method-not-allowed" }
  | { kind: "not-found" };

/** Find the route for `method` and `pathname`. */
export function matchRoute(routes: Route[], method: string, pathname: string): Match {
  let pathMatched = false;
  for (const route of routes) {
    const params = matchPath(route.path, pathname);
    if (!params) continue;
    pathMatched = true;
    if (route.method === method) return { kind: "found", route, params };
  }
  return pathMatched ? { kind: "method-not-allowed" } : { kind: "not-found" };
}

function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const want = pattern.split("/").filter(Boolean);
  const got = pathname.split("/").filter(Boolean);
  if (want.length !== got.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(":")) {
      params[want[i].slice(1)] = decodeURIComponent(got[i]);
    } else if (want[i] !== got[i]) {
      return null;
    }
  }
  return params;
}
