import type { Page, Payment, PaymentMatchStatus, UnmatchedReason } from "@stardex/sdk";
import type pg from "pg";
import { pool, withTransaction } from "./db.ts";
import {
  decodeCursor,
  encodeCursor,
  HttpError,
  pageLimit,
  parseId,
  readJson,
  requiredString,
  sendJson,
} from "./http.ts";
import { formatAmount } from "./money.ts";
import type { Context } from "./router.ts";

const STATUSES: PaymentMatchStatus[] = ["unmatched", "matched", "ignored"];

interface PaymentRow {
  id: string;
  event_id: string;
  tx_hash: string;
  ledger: number;
  closed_at: Date;
  account: string;
  from_address: string;
  asset: string;
  amount: string;
  reference_type: "id" | "text" | "hash" | null;
  reference: string | null;
  match_status: PaymentMatchStatus;
  unmatched_reason: UnmatchedReason | null;
  invoice_id: string | null;
}

const PAYMENT_COLUMNS = `p.id, p.event_id, p.tx_hash, p.ledger, p.closed_at, p.account,
  p.from_address, p.asset, p.amount::text as amount, p.reference_type, p.reference,
  p.match_status, p.unmatched_reason, a.invoice_id`;

const FROM_PAYMENTS = `from payments p left join payment_allocations a on a.payment_id = p.id`;

function toPayment(row: PaymentRow): Payment {
  return {
    id: String(row.id),
    eventId: row.event_id,
    txHash: row.tx_hash,
    ledger: row.ledger,
    closedAt: row.closed_at.toISOString(),
    account: row.account,
    fromAddress: row.from_address,
    asset: row.asset,
    amount: formatAmount(row.amount, row.asset),
    referenceType: row.reference_type,
    reference: row.reference,
    matchStatus: row.match_status,
    unmatchedReason: row.unmatched_reason,
    invoiceId: row.invoice_id === null ? null : String(row.invoice_id),
  };
}

/** GET /payments?account&status&limit&cursor — newest first. */
export async function listPayments({ res, url }: Context): Promise<void> {
  const params = url.searchParams;
  const where: string[] = [];
  const values: unknown[] = [];
  const filter = (clause: string, value: unknown) => {
    values.push(value);
    where.push(clause.replace("?", `$${values.length}`));
  };

  const account = params.get("account");
  if (account) filter("p.account = ?", account);

  const status = params.get("status");
  if (status) {
    if (!STATUSES.includes(status as PaymentMatchStatus)) {
      throw new HttpError(400, `status must be one of ${STATUSES.join(", ")}`);
    }
    filter("p.match_status = ?", status);
  }

  const cursor = decodeCursor(params.get("cursor"));
  if (cursor !== null) filter("p.id < ?::bigint", cursor);

  const limit = pageLimit(params);
  values.push(limit);

  const { rows } = await pool.query<PaymentRow>(
    `select ${PAYMENT_COLUMNS} ${FROM_PAYMENTS}
     ${where.length ? `where ${where.join(" and ")}` : ""}
     order by p.id desc
     limit $${values.length}`,
    values,
  );
  const items = rows.map(toPayment);
  const page: Page<Payment> = {
    items,
    nextCursor: items.length === limit ? encodeCursor(items[items.length - 1].id) : null,
  };
  sendJson(res, 200, page);
}

/**
 * POST /payments/:id/match { invoiceId } — match an unmatched payment by hand.
 * Applies the same checks as the reconcile engine (account, asset, cancelled).
 */
export async function matchPayment({ req, res, params }: Context): Promise<void> {
  const paymentId = parseId(params.id);
  const body = await readJson(req);
  const invoiceId = requiredString(body, "invoiceId");
  if (!/^\d{1,18}$/.test(invoiceId)) throw new HttpError(400, "invoiceId must be an id");

  const payment = await withTransaction(async (client) => {
    const current = await lockPayment(client, paymentId);
    if (current.match_status !== "unmatched") {
      throw new HttpError(409, `payment is already ${current.match_status}`);
    }

    const { rows } = await client.query<{ account: string; asset: string; status: string }>(
      "select account, asset, status from invoices where id = $1",
      [invoiceId],
    );
    const invoice = rows[0];
    if (!invoice) throw new HttpError(404, "invoice not found");
    if (invoice.account !== current.account) {
      throw new HttpError(409, "invoice belongs to a different account than the payment");
    }
    if (invoice.asset !== current.asset) {
      throw new HttpError(409, "invoice asks for a different asset than the payment");
    }
    if (invoice.status === "cancelled") {
      throw new HttpError(409, "invoice is cancelled");
    }

    await client.query(
      `insert into payment_allocations (payment_id, invoice_id, amount, matched_by)
       select id, $2, amount, 'manual' from payments where id = $1`,
      [paymentId, invoiceId],
    );
    await client.query(
      "update payments set match_status = 'matched', unmatched_reason = null where id = $1",
      [paymentId],
    );
    await client.query("select recalc_invoice($1)", [invoiceId]);
    return readPayment(client, paymentId);
  });
  sendJson(res, 200, payment);
}

/** POST /payments/:id/ignore — mark an unmatched payment as not for any invoice. */
export async function ignorePayment({ res, params }: Context): Promise<void> {
  const paymentId = parseId(params.id);
  const payment = await withTransaction(async (client) => {
    const current = await lockPayment(client, paymentId);
    if (current.match_status !== "unmatched") {
      throw new HttpError(409, `payment is already ${current.match_status}`);
    }
    await client.query("update payments set match_status = 'ignored' where id = $1", [paymentId]);
    return readPayment(client, paymentId);
  });
  sendJson(res, 200, payment);
}

async function lockPayment(
  client: pg.PoolClient,
  id: string,
): Promise<{ account: string; asset: string; match_status: PaymentMatchStatus }> {
  const { rows } = await client.query<{
    account: string;
    asset: string;
    match_status: PaymentMatchStatus;
  }>("select account, asset, match_status from payments where id = $1 for update", [id]);
  if (!rows[0]) throw new HttpError(404, "payment not found");
  return rows[0];
}

async function readPayment(client: pg.PoolClient, id: string): Promise<Payment> {
  const { rows } = await client.query<PaymentRow>(
    `select ${PAYMENT_COLUMNS} ${FROM_PAYMENTS} where p.id = $1`,
    [id],
  );
  return toPayment(rows[0]);
}
