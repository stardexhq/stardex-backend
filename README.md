# stardex-backend

The HTTP API for [Stardex](https://github.com/stardexhq/stardex), open source payment reconciliation for businesses paid on Stellar.

The Rust engine in the `stardex` repo reads the Stellar network and writes to Postgres. This backend serves that data over HTTP to the [frontend](https://github.com/stardexhq/stardex-frontend) and to any app using [@stardex/sdk](https://github.com/stardexhq/stardex-sdk). It holds the database connection, so it always runs server side.

## Endpoints

| Method | Path | What it returns |
|---|---|---|
| GET | `/health` | `{ status, db }`, with a database check |
| GET | `/events` | Indexed events, newest first. Filters: `contractId`, `kind`, `fromLedger`, `toLedger`, `limit` (max 200), `cursor` |

Invoice, payment and export endpoints are coming next as part of the reconciliation work.

## Run it locally

You need Node 25 (see `.node-version`, Node runs the TypeScript directly) and a Postgres database with the schema from [`stardex/db/migrations`](https://github.com/stardexhq/stardex/tree/main/db/migrations) applied.

```bash
cp .env.example .env    # then edit DATABASE_URL if needed
pnpm install
pnpm dev                # http://localhost:8080
```

Try it:

```bash
curl localhost:8080/health
curl "localhost:8080/events?limit=5"
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://stardex:stardex@localhost:5432/stardex` | Postgres connection string |
| `PORT` | `8080` | Port to listen on |

## Deploy

Any Node 25 host works. On Render: a Web Service from this repo, build command `pnpm install`, start command `pnpm start`, with `DATABASE_URL` set.

## Related repos

| Repo | What it is |
|---|---|
| [stardex](https://github.com/stardexhq/stardex) | Rust engine and database schema |
| [stardex-sdk](https://github.com/stardexhq/stardex-sdk) | TypeScript client and the shared types this API returns |
| [stardex-frontend](https://github.com/stardexhq/stardex-frontend) | Web app |

## License

Apache-2.0
