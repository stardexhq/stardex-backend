/**
 * End to end tests against a real Postgres with the stardex migrations applied.
 * Skipped unless DATABASE_URL is set:
 *   DATABASE_URL=postgres://... pnpm test
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

const DATABASE_URL = process.env.DATABASE_URL;
const KEY = "test-admin-key";
const ACCOUNT = "GBTF2Z62VJD4B54NGIS6JTGNPVH2O5HQNQF4S75NHVZIBP4JONQMRP7K";

describe("backend API", { skip: !DATABASE_URL && "DATABASE_URL is not set" }, () => {
  let server: Server;
  let base: string;
  let pool: import("pg").Pool;
  const tag = `t${process.pid}`;

  const call = async (method: string, path: string, body?: unknown, key: string | null = KEY) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text;
    return { status: res.status, body: json };
  };

  const insertPayment = async (suffix: string, amount: string, reference: string | null) => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into payments (event_id, tx_hash, ledger, closed_at, account, from_address,
         asset, asset_contract, amount, reference_type, reference)
       values ($1, 'tx', 1, now(), $2, 'GPAYER', 'native', 'CXLM', $3::numeric, $4, $5)
       returning id`,
      [`${tag}-${suffix}`, ACCOUNT, amount, reference === null ? null : "id", reference],
    );
    return String(rows[0].id);
  };

  before(async () => {
    process.env.STARDEX_ADMIN_KEY = KEY;
    const { handle } = await import("../src/app.ts");
    ({ pool } = await import("../src/db.ts"));
    await pool.query("insert into accounts (address) values ($1) on conflict do nothing", [ACCOUNT]);
    server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  test("health and events are public, business routes need the key", async () => {
    assert.equal((await call("GET", "/health", undefined, null)).status, 200);
    assert.equal((await call("GET", "/events?limit=1", undefined, null)).status, 200);
    assert.equal((await call("GET", "/invoices", undefined, null)).status, 401);
    assert.equal((await call("GET", "/invoices", undefined, "wrong")).status, 401);
    assert.equal((await call("GET", "/nope")).status, 404);
    assert.equal((await call("POST", "/health")).status, 405);
  });

  test("accounts are listed", async () => {
    const { status, body } = await call("GET", "/accounts");
    assert.equal(status, 200);
    assert.ok(body.some((a: { address: string }) => a.address === ACCOUNT));
  });

  test("creating an invoice validates input and returns payment instructions", async () => {
    const bad = [
      [{ account: ACCOUNT }, 400],
      [{ account: ACCOUNT, amount: "1.23456789" }, 400],
      [{ account: ACCOUNT, amount: "5", asset: "XLM" }, 400],
      [{ account: ACCOUNT, amount: "5", dueDate: "2026-02-30" }, 400],
      [{ account: "GNOTWATCHED", amount: "5" }, 400],
    ] as const;
    for (const [input, want] of bad) {
      assert.equal((await call("POST", "/invoices", input)).status, want, JSON.stringify(input));
    }

    const { status, body } = await call("POST", "/invoices", {
      account: ACCOUNT,
      amount: "5",
      number: `${tag}-A`,
      customerName: "Acme Ltd",
      dueDate: "2026-10-01",
    });
    assert.equal(status, 201);
    assert.equal(body.amount, "5.0000000");
    assert.equal(body.status, "open");
    assert.equal(body.dueDate, "2026-10-01");
    assert.equal(body.paymentInstructions.memo, body.reference);
    assert.match(body.paymentInstructions.muxedAddress, /^M/);
    assert.match(body.paymentInstructions.sep7Uri, /^web\+stellar:pay\?destination=G/);
    assert.deepEqual(body.allocations, []);

    const dup = await call("POST", "/invoices", { account: ACCOUNT, amount: "1", number: `${tag}-A` });
    assert.equal(dup.status, 409);
  });

  test("payment instructions ask for the outstanding balance", async () => {
    const created = await call("POST", "/invoices", { account: ACCOUNT, amount: "5", number: `${tag}-P` });
    assert.equal(created.body.paymentInstructions.amount, "5.0000000");
    const paymentId = await insertPayment("p", "30000000", null);
    await call("POST", `/payments/${paymentId}/match`, { invoiceId: created.body.id });

    const partial = await call("GET", `/invoices/${created.body.id}`);
    assert.equal(partial.body.status, "partial");
    assert.equal(partial.body.paymentInstructions.amount, "2.0000000");
    assert.match(partial.body.paymentInstructions.sep7Uri, /amount=2&/);
  });

  test("manual matching pays an invoice and cannot be repeated", async () => {
    const created = await call("POST", "/invoices", { account: ACCOUNT, amount: "5", number: `${tag}-M` });
    const invoiceId = created.body.id;
    const paymentId = await insertPayment("m", "50000000", null);

    const matched = await call("POST", `/payments/${paymentId}/match`, { invoiceId });
    assert.equal(matched.status, 200);
    assert.equal(matched.body.matchStatus, "matched");
    assert.equal(matched.body.invoiceId, invoiceId);
    assert.equal(matched.body.amount, "5.0000000");

    const invoice = await call("GET", `/invoices/${invoiceId}`);
    assert.equal(invoice.body.status, "paid");
    assert.equal(invoice.body.amountReceived, "5.0000000");
    assert.equal(invoice.body.allocations[0].matchedBy, "manual");

    assert.equal((await call("POST", `/payments/${paymentId}/match`, { invoiceId })).status, 409);
    assert.equal((await call("POST", `/invoices/${invoiceId}/cancel`)).status, 409);
    assert.equal((await call("POST", "/payments/999999999/match", { invoiceId })).status, 404);
  });

  test("ignoring a payment and cancelling an open invoice", async () => {
    const paymentId = await insertPayment("i", "10000000", null);
    const ignored = await call("POST", `/payments/${paymentId}/ignore`);
    assert.equal(ignored.status, 200);
    assert.equal(ignored.body.matchStatus, "ignored");
    assert.equal((await call("POST", `/payments/${paymentId}/ignore`)).status, 409);

    const created = await call("POST", "/invoices", { account: ACCOUNT, amount: "3", number: `${tag}-C` });
    const cancelled = await call("POST", `/invoices/${created.body.id}/cancel`);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, "cancelled");
    assert.ok(cancelled.body.cancelledAt);

    const other = await insertPayment("c", "30000000", created.body.reference);
    const rejected = await call("POST", `/payments/${other}/match`, { invoiceId: created.body.id });
    assert.equal(rejected.status, 409);
  });

  test("lists filter and paginate", async () => {
    const page1 = await call("GET", `/invoices?account=${ACCOUNT}&limit=1`);
    assert.equal(page1.status, 200);
    assert.equal(page1.body.items.length, 1);
    assert.ok(page1.body.nextCursor);
    const page2 = await call("GET", `/invoices?account=${ACCOUNT}&limit=1&cursor=${page1.body.nextCursor}`);
    assert.notEqual(page2.body.items[0].id, page1.body.items[0].id);

    const cancelled = await call("GET", "/invoices?status=cancelled");
    assert.ok(cancelled.body.items.every((i: { status: string }) => i.status === "cancelled"));
    assert.equal((await call("GET", "/invoices?status=nope")).status, 400);

    const ignored = await call("GET", "/payments?status=ignored");
    assert.ok(ignored.body.items.length >= 1);
  });

  test("exports return CSV with a header row", async () => {
    const payments = await call("GET", `/exports/payments.csv?account=${ACCOUNT}`);
    assert.equal(payments.status, 200);
    const lines = (payments.body as string).trim().split("\r\n");
    assert.match(lines[0], /^payment_id,closed_at,account/);
    assert.ok(lines.some((l) => l.includes(`${tag}-M`)), "matched payment lists its invoice number");

    const invoices = await call("GET", "/exports/invoices.csv?from=2000-01-01");
    assert.equal(invoices.status, 200);
    assert.match(invoices.body as string, /^invoice_id,number,issued_at/);
    assert.equal((await call("GET", "/exports/invoices.csv?from=yesterday")).status, 400);
  });
});
