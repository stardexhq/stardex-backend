/**
 * Reads decoded events from Postgres for the `/events` endpoint.
 * Newest-first, with optional filters and opaque cursor pagination.
 */
import type { EventQuery, Page, StardexEvent } from "@stardex/sdk";
import { pool } from "./db.ts";
import { decodeCursor, encodeCursor, sendJson } from "./http.ts";
import type { Context } from "./router.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function queryEvents(q: EventQuery): Promise<Page<StardexEvent>> {
  const where: string[] = [];
  const params: unknown[] = [];

  // Append a filter, substituting the next positional placeholder ($1, $2, …).
  const filter = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace("?", `$${params.length}`));
  };

  if (q.contractId) filter("contract_id = ?", q.contractId);
  if (q.kind) filter("kind = ?", q.kind);
  if (q.fromLedger !== undefined) filter("ledger >= ?", q.fromLedger);
  if (q.toLedger !== undefined) filter("ledger <= ?", q.toLedger);

  // Pagination walks backwards through ids; the cursor is the last id returned.
  const cursorId = decodeCursor(q.cursor);
  if (cursorId !== null) filter("id < ?::bigint", cursorId);

  const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  params.push(limit);

  const sql = `
    select id, contract_id, ledger, kind, fields, closed_at
    from events
    ${where.length ? `where ${where.join(" and ")}` : ""}
    order by id desc
    limit $${params.length}
  `;

  const { rows } = await pool.query(sql, params);
  const items = rows.map(toEvent);
  const nextCursor =
    items.length === limit ? encodeCursor(items[items.length - 1].id) : null;
  return { items, nextCursor };
}

interface EventRow {
  id: string;
  contract_id: string;
  ledger: number;
  kind: string;
  fields: Record<string, string>;
  closed_at: Date;
}

function toEvent(row: EventRow): StardexEvent {
  return {
    id: String(row.id),
    contractId: row.contract_id,
    ledger: row.ledger,
    kind: row.kind,
    fields: row.fields,
    closedAt: row.closed_at.toISOString(),
  };
}

/** GET /events — public. */
export async function listEvents({ res, url }: Context): Promise<void> {
  const params = url.searchParams;
  const num = (v: string | null) => (v === null ? undefined : Number(v));
  const page = await queryEvents({
    contractId: params.get("contractId") ?? undefined,
    kind: params.get("kind") ?? undefined,
    fromLedger: num(params.get("fromLedger")),
    toLedger: num(params.get("toLedger")),
    limit: num(params.get("limit")),
    cursor: params.get("cursor") ?? undefined,
  });
  sendJson(res, 200, page);
}
