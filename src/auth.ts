import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { HttpError } from "./http.ts";

/**
 * Business data routes need `Authorization: Bearer <STARDEX_ADMIN_KEY>`. With
 * no key configured those routes are closed rather than open, so a deploy that
 * forgets the variable does not expose invoices and payments.
 */
export function requireAdmin(req: IncomingMessage, adminKey = process.env.STARDEX_ADMIN_KEY): void {
  if (!adminKey) {
    throw new HttpError(503, "business data is disabled: STARDEX_ADMIN_KEY is not set");
  }
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!token || !sameSecret(token, adminKey)) {
    throw new HttpError(401, "missing or invalid api key");
  }
}

/** Constant time comparison. Hashing first makes both inputs the same length. */
function sameSecret(a: string, b: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}
