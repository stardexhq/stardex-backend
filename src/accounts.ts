import type { Account } from "@stardex/sdk";
import { pool } from "./db.ts";
import type { Context } from "./router.ts";
import { sendJson } from "./http.ts";

/** GET /accounts — every watched account, active or not. Accounts are added with the CLI. */
export async function listAccounts({ res }: Context): Promise<void> {
  const { rows } = await pool.query<{
    address: string;
    label: string | null;
    active: boolean;
    added_at: Date;
  }>("select address, label, active, added_at from accounts order by added_at, address");

  const accounts: Account[] = rows.map((row) => ({
    address: row.address,
    label: row.label,
    active: row.active,
    addedAt: row.added_at.toISOString(),
  }));
  sendJson(res, 200, accounts);
}
