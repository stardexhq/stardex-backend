import type { IncomingMessage, ServerResponse } from "node:http";

/** An error that becomes a JSON `{ error }` response with this status. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const MAX_BODY_BYTES = 64 * 1024;

/** Read and parse a JSON object body. Rejects anything else with a 400. */
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body is too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "request body must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** An optional string field, trimmed, with empty strings treated as absent. */
export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${key} must be a string`);
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function requiredString(body: Record<string, unknown>, key: string): string {
  const value = optionalString(body, key);
  if (value === undefined) throw new HttpError(400, `${key} is required`);
  return value;
}

/** Page size from `?limit=`, clamped to 1..max. */
export function pageLimit(params: URLSearchParams, fallback = 50, max = 200): number {
  const raw = params.get("limit");
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new HttpError(400, "limit must be a whole number");
  return Math.min(Math.max(n, 1), max);
}

/** Cursors are the last row id returned, base64url encoded so clients treat them as opaque. */
export function encodeCursor(id: string): string {
  return Buffer.from(id).toString("base64url");
}

export function decodeCursor(cursor: string | null | undefined): string | null {
  if (!cursor) return null;
  const id = Buffer.from(cursor, "base64url").toString("utf8");
  return /^\d+$/.test(id) ? id : null;
}

/** Route ids are database ids; anything else is a 404, not a 500. */
export function parseId(raw: string): string {
  if (!/^\d{1,18}$/.test(raw)) throw new HttpError(404, "not found");
  return raw;
}
