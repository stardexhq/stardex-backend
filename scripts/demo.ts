/**
 * Testnet demo: creates three invoices through the API and pays them in three
 * different ways, so the whole flow can be seen end to end.
 *
 *   STARDEX_ADMIN_KEY=... pnpm demo [--account G...] [--wait 20]
 *
 * Needs a running backend and an account already watched by the engine
 * (`stardex accounts add`). Payments are made from a fresh friendbot-funded
 * testnet account. Uses test XLM only; it refuses to run against mainnet.
 */
import { StardexApiError, StardexClient, type InvoiceDetail } from "@stardex/sdk";
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const apiUrl = process.env.STARDEX_API ?? "http://localhost:8080";
const apiKey = process.env.STARDEX_ADMIN_KEY;
const waitMinutes = Number(flag("--wait") ?? 0);

if (!apiKey) fail("set STARDEX_ADMIN_KEY to the backend's admin key");
if (!Number.isFinite(waitMinutes) || waitMinutes < 0) fail("--wait takes a number of minutes");

const stardex = new StardexClient({ baseUrl: apiUrl, apiKey });
const horizon = new Horizon.Server(HORIZON_URL);

await main().catch((err: unknown) => {
  if (err instanceof StardexApiError) fail(`backend said ${err.status}: ${err.message}`);
  fail(err instanceof Error ? err.message : String(err));
});

async function main() {
  const account = await pickAccount();
  await ensureFunded(account);
  console.log(`Business account: ${account}`);

  const payer = Keypair.random();
  await friendbot(payer.publicKey());
  console.log(`Customer account: ${payer.publicKey()} (funded by friendbot)\n`);

  const full = await createInvoice(account, "25", "Demo: paid in full, to the muxed address");
  const partial = await createInvoice(account, "40", "Demo: paid in part, with a memo ID");
  const noMemo = await createInvoice(account, "15", "Demo: paid without a memo");

  console.log("\nPaying:");
  const tx1 = await pay(payer, full.paymentInstructions.muxedAddress, full.paymentInstructions.amount);
  console.log(`  ${full.number}: 25 XLM to ${short(full.paymentInstructions.muxedAddress)}  tx ${tx1.slice(0, 12)}`);
  const tx2 = await pay(payer, account, "20", Memo.id(partial.reference));
  console.log(`  ${partial.number}: 20 of 40 XLM with memo ID ${partial.reference}  tx ${tx2.slice(0, 12)}`);
  const tx3 = await pay(payer, account, "15");
  console.log(`  ${noMemo.number}: 15 XLM with no memo  tx ${tx3.slice(0, 12)}`);

  console.log(`
What should happen once the engine picks these up:
  ${full.number}  paid
  ${partial.number}  partly paid, 20 of 40 XLM
  ${noMemo.number}  still open; its 15 XLM payment waits in the Payments review list
                (reason: no reference) for you to match by hand

The engine needs \`stardex run\` and \`stardex reconcile\` running, or the
scheduled job (every 15 minutes on the hosted demo).`);

  if (waitMinutes > 0) await waitForMatching(account, full, partial, tx3, waitMinutes);
}

async function pickAccount(): Promise<string> {
  const requested = flag("--account");
  const watched = (await stardex.accounts()).filter((a) => a.active);
  if (requested) {
    if (!watched.some((a) => a.address === requested)) {
      fail(`${requested} is not watched. Run: stardex accounts add ${requested}`);
    }
    return requested;
  }
  if (watched.length === 0) {
    fail("no account is watched yet. Run `stardex accounts add <G address>` on the engine first");
  }
  return watched[0].address;
}

async function ensureFunded(account: string) {
  const details = await fetch(`${HORIZON_URL}/`).then((r) => r.json());
  if (details.network_passphrase !== Networks.TESTNET) fail("Horizon is not testnet; refusing to run");
  try {
    await horizon.loadAccount(account);
  } catch {
    console.log(`${account} does not exist on testnet yet; funding it with friendbot`);
    await friendbot(account);
  }
}

async function friendbot(address: string) {
  const res = await fetch(`${FRIENDBOT_URL}/?addr=${address}`);
  if (!res.ok) fail(`friendbot could not fund ${address} (${res.status})`);
}

async function createInvoice(account: string, amount: string, description: string) {
  const invoice = await stardex.createInvoice({
    account,
    amount,
    description,
    customerName: "Demo customer",
  });
  console.log(`Created ${invoice.number} for ${amount} XLM (reference ${invoice.reference})`);
  return invoice;
}

async function pay(from: Keypair, destination: string, amount: string, memo?: Memo): Promise<string> {
  const source = await horizon.loadAccount(from.publicKey());
  let builder = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination, asset: Asset.native(), amount }))
    .setTimeout(60);
  if (memo) builder = builder.addMemo(memo);
  const tx = builder.build();
  tx.sign(from);
  const result = await horizon.submitTransaction(tx);
  return result.hash;
}

async function waitForMatching(
  account: string,
  full: InvoiceDetail,
  partial: InvoiceDetail,
  noMemoTx: string,
  minutes: number,
) {
  const deadline = Date.now() + minutes * 60_000;
  console.log(`\nWaiting up to ${minutes} minute(s) for the engine to match the payments...`);

  while (Date.now() < deadline) {
    const [a, b, unmatched] = await Promise.all([
      stardex.invoice(full.id),
      stardex.invoice(partial.id),
      stardex.payments({ account, status: "unmatched", limit: 50 }),
    ]);
    const waiting = unmatched.items.find((p) => p.txHash === noMemoTx && p.unmatchedReason);
    if (a.status === "paid" && b.status === "partial" && waiting) {
      console.log(`  ${a.number}: ${a.status}, ${a.amountReceived} XLM received`);
      console.log(`  ${b.number}: ${b.status}, ${b.amountReceived} of ${b.amount} XLM received`);
      console.log(`  15 XLM with no memo: waiting for review (${waiting.unmatchedReason})`);
      console.log("Done. Open the Payments page to match the no-memo payment by hand.");
      return;
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  console.log("Not matched yet. Check that `stardex run` and `stardex reconcile` are running.");
  process.exitCode = 1;
}

function short(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

function fail(message: string): never {
  console.error(`demo: ${message}`);
  process.exit(1);
}
