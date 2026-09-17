# stardex-backend

The HTTP API for [Stardex](https://github.com/stardexhq/stardex), open source payment reconciliation for businesses paid on Stellar.

The Rust engine in the `stardex` repo reads the Stellar network and writes to Postgres. This backend serves that data over HTTP to the [frontend](https://github.com/stardexhq/stardex-frontend) and to any app using [@stardex/sdk](https://github.com/stardexhq/stardex-sdk). It holds the database connection, so it always runs server side.

## Endpoints

Request and response types are in [`@stardex/sdk`](https://github.com/stardexhq/stardex-sdk). Amounts are decimal strings (`"5.0000000"`), never JSON numbers. Errors are `{ "error": "message" }` with a matching status code.

**Public**

| Method | Path | What it does |
|---|---|---|
| GET | `/health` | `{ status, db }`, with a database check |
| GET | `/events` | Indexed events, newest first. Filters: `contractId`, `kind`, `fromLedger`, `toLedger`, `limit` (max 200), `cursor` |

**Business data** (needs `Authorization: Bearer <STARDEX_ADMIN_KEY>`)

| Method | Path | What it does |
|---|---|---|
| GET | `/accounts` | Watched accounts (added with `stardex accounts add`) |
| GET | `/invoices` | Invoices, newest first. Filters: `account`, `status`, `limit`, `cursor` |
| POST | `/invoices` | Create an invoice: `{ account, amount, asset?, number?, customerName?, customerEmail?, description?, dueDate? }`. Returns it with payment instructions |
| GET | `/invoices/:id` | One invoice with payment instructions (muxed address, memo ID, SEP-7 link, and the amount still owed) and allocations |
| POST | `/invoices/:id/cancel` | Cancel an invoice that is not fully paid |
| GET | `/payments` | Incoming payments, newest first. Filters: `account`, `status` (`unmatched`, `matched`, `ignored`), `limit`, `cursor` |
| POST | `/payments/:id/match` | Match an unmatched payment to an invoice by hand: `{ invoiceId }` |
| POST | `/payments/:id/ignore` | Mark an unmatched payment as not for any invoice |
| GET | `/exports/payments.csv` | Payments as CSV. Filters: `account`, `from`, `to` |
| GET | `/exports/invoices.csv` | Invoices as CSV. Filters: `account`, `from`, `to` |

Automatic matching is done by `stardex reconcile` in the engine repo. Manual matching here applies the same checks (same account, same asset, invoice not cancelled) and updates invoice status through the same `recalc_invoice()` database function.

## Run it locally

You need Node 25 (see `.node-version`, Node runs the TypeScript directly) and a Postgres database with the schema from [`stardex/db/migrations`](https://github.com/stardexhq/stardex/tree/main/db/migrations) applied. This version needs schema **v0.2.0** (migrations 0001 to 0006).

```bash
cp .env.example .env    # set STARDEX_ADMIN_KEY, and DATABASE_URL if needed
pnpm install
pnpm dev                # http://localhost:8080
```

Try it:

```bash
curl localhost:8080/health
curl "localhost:8080/events?limit=5"
curl -H "Authorization: Bearer $STARDEX_ADMIN_KEY" localhost:8080/invoices
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://stardex:stardex@localhost:5432/stardex` | Postgres connection string |
| `PORT` | `8080` | Port to listen on |
| `STARDEX_ADMIN_KEY` | none | Bearer key for business data routes. If unset, those routes return 503 |

## Tests

```bash
pnpm test                                   # unit tests
DATABASE_URL=postgres://... pnpm test       # plus the API tests, against a database with the schema applied
```

The API tests start the real server and write rows tagged with the test process id. Use a scratch database. CI runs them against a fresh Postgres with the pinned schema.

## Deploy

Any Node 25 host works. On Render: a Web Service from this repo, build command `pnpm install`, start command `pnpm start`, with `DATABASE_URL` and `STARDEX_ADMIN_KEY` set.

## Related repos

| Repo | What it is |
|---|---|
| [stardex](https://github.com/stardexhq/stardex) | Rust engine and database schema |
| [stardex-sdk](https://github.com/stardexhq/stardex-sdk) | TypeScript client and the shared types this API returns |
| [stardex-frontend](https://github.com/stardexhq/stardex-frontend) | Web app |

## License

Apache-2.0
