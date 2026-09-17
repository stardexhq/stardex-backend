import { csvRow } from "./csv.ts";
import { pool } from "./db.ts";
import { HttpError } from "./http.ts";
import { formatAmount, fromUnits } from "./money.ts";
import type { Context } from "./router.ts";

/** Rows are streamed in pages so a large export never sits in memory at once. */
const PAGE = 1000;

interface Range {
  account: string | null;
  from: string | null;
  to: string | null;
}

/** GET /exports/payments.csv?account&from&to — by ledger close time, oldest first. */
export async function exportPayments(ctx: Context): Promise<void> {
  const range = parseRange(ctx.url.searchParams);
  startCsv(ctx, "payments", [
    "payment_id", "closed_at", "account", "from_address", "asset", "amount",
    "reference_type", "reference", "match_status", "unmatched_reason", "invoice_number",
    "tx_hash",
  ]);

  let after = "0";
  for (;;) {
    const { rows } = await pool.query<{
      id: string; closed_at: Date; account: string; from_address: string; asset: string;
      amount: string; reference_type: string | null; reference: string | null;
      match_status: string; unmatched_reason: string | null; number: string | null;
      tx_hash: string;
    }>(
      `select p.id, p.closed_at, p.account, p.from_address, p.asset, p.amount::text as amount,
              p.reference_type, p.reference, p.match_status, p.unmatched_reason, i.number,
              p.tx_hash
       from payments p
       left join payment_allocations a on a.payment_id = p.id
       left join invoices i on i.id = a.invoice_id
       where p.id > $1
         and ($2::text is null or p.account = $2)
         and ($3::timestamptz is null or p.closed_at >= $3)
         and ($4::timestamptz is null or p.closed_at < $4)
       order by p.id
       limit $5`,
      [after, range.account, range.from, range.to, PAGE],
    );
    for (const r of rows) {
      ctx.res.write(csvRow([
        r.id, r.closed_at.toISOString(), r.account, r.from_address, r.asset,
        formatAmount(r.amount, r.asset), r.reference_type, r.reference, r.match_status,
        r.unmatched_reason, r.number, r.tx_hash,
      ]));
    }
    if (rows.length < PAGE) break;
    after = rows[rows.length - 1].id;
  }
  ctx.res.end();
}

/** GET /exports/invoices.csv?account&from&to — by issue time, oldest first. */
export async function exportInvoices(ctx: Context): Promise<void> {
  const range = parseRange(ctx.url.searchParams);
  startCsv(ctx, "invoices", [
    "invoice_id", "number", "issued_at", "account", "customer_name", "customer_email",
    "description", "asset", "amount", "amount_received", "status", "reference", "due_date",
    "paid_at", "cancelled_at",
  ]);

  let after = "0";
  for (;;) {
    const { rows } = await pool.query<{
      id: string; number: string; issued_at: Date; account: string;
      customer_name: string | null; customer_email: string | null; description: string | null;
      asset: string; amount: string; amount_received: string; status: string;
      reference: string; due_date: string | null; paid_at: Date | null;
      cancelled_at: Date | null;
    }>(
      `select id, number, issued_at, account, customer_name, customer_email, description,
              asset, amount::text as amount, amount_received::text as amount_received, status,
              reference, to_char(due_date, 'YYYY-MM-DD') as due_date, paid_at, cancelled_at
       from invoices
       where id > $1
         and ($2::text is null or account = $2)
         and ($3::timestamptz is null or issued_at >= $3)
         and ($4::timestamptz is null or issued_at < $4)
       order by id
       limit $5`,
      [after, range.account, range.from, range.to, PAGE],
    );
    for (const r of rows) {
      ctx.res.write(csvRow([
        r.id, r.number, r.issued_at.toISOString(), r.account, r.customer_name,
        r.customer_email, r.description, r.asset, fromUnits(r.amount),
        fromUnits(r.amount_received), r.status, r.reference, r.due_date,
        r.paid_at?.toISOString(), r.cancelled_at?.toISOString(),
      ]));
    }
    if (rows.length < PAGE) break;
    after = rows[rows.length - 1].id;
  }
  ctx.res.end();
}

function parseRange(params: URLSearchParams): Range {
  const time = (key: string) => {
    const value = params.get(key);
    if (value === null || value === "") return null;
    if (Number.isNaN(Date.parse(value))) {
      throw new HttpError(400, `${key} must be an ISO date or timestamp`);
    }
    return value;
  };
  return { account: params.get("account") || null, from: time("from"), to: time("to") };
}

function startCsv({ res }: Context, name: string, header: string[]): void {
  const date = new Date().toISOString().slice(0, 10);
  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="stardex-${name}-${date}.csv"`,
  });
  res.write(csvRow(header));
}
