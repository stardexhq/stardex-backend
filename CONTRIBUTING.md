# Contributing to stardex-backend

The general rules for all Stardex repos (claiming issues, PR size, commit style) are in the [org contributing guide](https://github.com/stardexhq/.github/blob/main/CONTRIBUTING.md). This file only covers what is specific to this repo.

## Setup

```bash
cp .env.example .env
pnpm install
pnpm typecheck
pnpm dev
```

You need a local Postgres with the migrations from the [stardex](https://github.com/stardexhq/stardex) repo applied, in order.

## Guidelines

- Request and response shapes come from `@stardex/sdk`. If an endpoint changes shape, update the type in [stardex-sdk](https://github.com/stardexhq/stardex-sdk) first and link that PR.
- The database schema is owned by the `stardex` repo. Never create or alter tables here; open a migration PR there instead.
- Always use parameterized queries (`$1`, `$2`), never string concatenation.
- The server uses plain `node:http` with no framework. Keep it that way unless an issue says otherwise.
