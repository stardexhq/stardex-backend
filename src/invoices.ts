import type {
  Allocation,
  Invoice,
  InvoiceDetail,
  InvoiceStatus,
  Page,
} from "@stardex/sdk";
import type pg from "pg";
import { pool, withTransaction } from "./db.ts";
import {
  decodeCursor,
  encodeCursor,
  HttpError,
  optionalString,
  pageLimit,
  parseId,
  readJson,
  requiredString,
  sendJson,
} from "./http.ts";
import { fromUnits, toUnits } from "./money.ts";
import type { Context } from "./router.ts";
import { isValidAsset, paymentInstructions } from "./stellar.ts";

const STATUSES: InvoiceStatus[] = ["open", "partial", "paid", "overpaid", "cancelled"];

export interface InvoiceRow {
  id: string;
  number: string;
  account: string;
  customer_name: string | null;
  customer_email: string | null;
  description: string | null;
  asset: string;
  amount: string;
  amount_received: string;
  reference: string;
  status: InvoiceStatus;
  due_date: string | null;
  issued_at: Date;
  paid_at: Date | null;
  cancelled_at: Date | null;
}

export const INVOICE_COLUMNS = `id, number, account, customer_name, customer_email, description,
  asset, amount::text as amount, amount_received::text as amount_received, reference, status,
  to_char(due_date, 'YYYY-MM-DD') as due_date, issued_at, paid_at, cancelled_at`;

export function toInvoice(row: InvoiceRow): Invoice {
  return {
    id: String(row.id),
    number: row.number,
    account: row.account,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    description: row.description,
    asset: row.asset,
    amount: fromUnits(row.amount),
    amountReceived: fromUnits(row.amount_received),
    reference: String(row.reference),
    status: row.status,
    dueDate: row.due_date,
    issuedAt: row.issued_at.toISOString(),
    paidAt: row.paid_at?.toISOString() ?? null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
  };
}

/** GET /invoices?account&status&limit&cursor — newest first. */
export async function listInvoices({ res, url }: Context): Promise<void> {
  const params = url.searchParams;
  const where: string[] = [];
  const values: unknown[] = [];
  const filter = (clause: string, value: unknown) => {
    values.push(value);
    where.push(clause.replace("?", `$${values.length}`));
  };

  const account = params.get("account");
  if (account) filter("account = ?", account);

  const status = params.get("status");
  if (status) {
    if (!STATUSES.includes(status as InvoiceStatus)) {
      throw new HttpError(400, `status must be one of ${STATUSES.join(", ")}`);
    }
    filter("status = ?", status);
  }

  const cursor = decodeCursor(params.get("cursor"));
  if (cursor !== null) filter("id < ?::bigint", cursor);

  const limit = pageLimit(params);
  values.push(limit);

  const { rows } = await pool.query<InvoiceRow>(
    `select ${INVOICE_COLUMNS} from invoices
     ${where.length ? `where ${where.join(" and ")}` : ""}
     order by id desc
     limit $${values.length}`,
    values,
  );
  const items = rows.map(toInvoice);
  const page: Page<Invoice> = {
    items,
    nextCursor: items.length === limit ? encodeCursor(items[items.length - 1].id) : null,
  };
  sendJson(res, 200, page);
}

/** GET /invoices/:id — with payment instructions and allocations. */
export async function getInvoice({ res, params }: Context): Promise<void> {
  const detail = await invoiceDetail(pool, parseId(params.id));
  if (!detail) throw new HttpError(404, "invoice not found");
  sendJson(res, 200, detail);
}

/** POST /invoices — create an invoice for a watched account. */
export async function createInvoice({ req, res }: Context): Promise<void> {
  const body = await readJson(req);

  const account = requiredString(body, "account");
  const asset = optionalString(body, "asset") ?? "native";
  if (!isValidAsset(asset)) {
    throw new HttpError(400, 'asset must be "native" or CODE:ISSUER');
  }
  const amountText = requiredString(body, "amount");
  const amount = toUnits(amountText);
  if (amount === null) {
    throw new HttpError(400, "amount must be a positive number with at most 7 decimal places");
  }
  const dueDate = optionalString(body, "dueDate");
  if (dueDate !== undefined && !isIsoDate(dueDate)) {
    throw new HttpError(400, "dueDate must be a date like 2026-10-01");
  }
  const number = optionalString(body, "number");
  if (number !== undefined && number.length > 64) {
    throw new HttpError(400, "number must be at most 64 characters");
  }

  const watched = await pool.query<{ active: boolean }>(
    "select active from accounts where address = $1",
    [account],
  );
  if (!watched.rows[0]?.active) {
    throw new HttpError(400, `${account} is not a watched account`);
  }

  let id: string;
  try {
    const { rows } = await pool.query<{ id: string }>(
      `with r as (select nextval('invoice_reference_seq') as reference)
       insert into invoices (reference, number, account, customer_name, customer_email,
                             description, asset, amount, due_date)
       select r.reference, coalesce($1, 'INV-' || r.reference), $2, $3, $4, $5, $6,
              $7::numeric, $8::date
       from r
       returning id`,
      [
        number ?? null,
        account,
        optionalString(body, "customerName") ?? null,
        optionalString(body, "customerEmail") ?? null,
        optionalString(body, "description") ?? null,
        asset,
        amount.toString(),
        dueDate ?? null,
      ],
    );
    id = rows[0].id;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new HttpError(409, `invoice number ${number} is already used`);
    }
    throw err;
  }

  sendJson(res, 201, await invoiceDetail(pool, id));
}

/** POST /invoices/:id/cancel — only invoices that have not been fully paid. */
export async function cancelInvoice({ res, params }: Context): Promise<void> {
  const id = parseId(params.id);
  const detail = await withTransaction(async (client) => {
    const { rows } = await client.query<{ status: InvoiceStatus }>(
      "select status from invoices where id = $1 for update",
      [id],
    );
    const status = rows[0]?.status;
    if (!status) throw new HttpError(404, "invoice not found");
    if (status === "paid" || status === "overpaid") {
      throw new HttpError(409, `a ${status} invoice cannot be cancelled`);
    }
    if (status !== "cancelled") {
      await client.query(
        "update invoices set status = 'cancelled', cancelled_at = now() where id = $1",
        [id],
      );
      await client.query("select recalc_invoice($1)", [id]);
    }
    return invoiceDetail(client, id);
  });
  sendJson(res, 200, detail);
}

export async function invoiceDetail(
  db: pg.Pool | pg.PoolClient,
  id: string,
): Promise<InvoiceDetail | null> {
  const { rows } = await db.query<InvoiceRow>(
    `select ${INVOICE_COLUMNS} from invoices where id = $1`,
    [id],
  );
  if (!rows[0]) return null;
  const invoice = toInvoice(rows[0]);

  const allocations = await db.query<{
    id: string;
    payment_id: string;
    invoice_id: string;
    amount: string;
    matched_by: "reference" | "manual";
    created_at: Date;
  }>(
    `select id, payment_id, invoice_id, amount::text as amount, matched_by, created_at
     from payment_allocations where invoice_id = $1 order by id`,
    [id],
  );

  return {
    ...invoice,
    paymentInstructions: paymentInstructions(
      invoice.account,
      invoice.asset,
      invoice.amount,
      invoice.reference,
    ),
    allocations: allocations.rows.map(
      (a): Allocation => ({
        id: String(a.id),
        paymentId: String(a.payment_id),
        invoiceId: String(a.invoice_id),
        amount: fromUnits(a.amount),
        matchedBy: a.matched_by,
        createdAt: a.created_at.toISOString(),
      }),
    ),
  };
}

function isIsoDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}
