import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";
import { requireAdmin } from "../src/auth.ts";
import { csvField, csvRow } from "../src/csv.ts";
import { decodeCursor, encodeCursor, HttpError, pageLimit } from "../src/http.ts";
import { formatAmount, fromUnits, toUnits } from "../src/money.ts";
import { matchRoute, type Route } from "../src/router.ts";
import { isAccountAddress, isValidAsset, muxedAddress, sep7PayUri } from "../src/stellar.ts";

const ACCOUNT = "GBTF2Z62VJD4B54NGIS6JTGNPVH2O5HQNQF4S75NHVZIBP4JONQMRP7K";
const USDC = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

test("toUnits parses decimals exactly and rejects bad input", () => {
  assert.equal(toUnits("5"), 50_000_000n);
  assert.equal(toUnits("2.5"), 25_000_000n);
  assert.equal(toUnits("0.0000001"), 1n);
  assert.equal(toUnits("123456789012345678.1234567"), 1234567890123456781234567n);
  for (const bad of ["", "0", "0.0", "-1", "1.", ".5", "1e3", "1.23456789", "abc", "1,5"]) {
    assert.equal(toUnits(bad), null, `${JSON.stringify(bad)} should be rejected`);
  }
});

test("fromUnits and formatAmount", () => {
  assert.equal(fromUnits(50_000_000n), "5.0000000");
  assert.equal(fromUnits("1"), "0.0000001");
  assert.equal(fromUnits("-25000000"), "-2.5000000");
  assert.equal(formatAmount("50000000", "native"), "5.0000000");
  assert.equal(formatAmount("50000000", USDC), "5.0000000");
  assert.equal(formatAmount("1000", "CTOKEN"), "1000");
});

test("stellar helpers", () => {
  assert.equal(isAccountAddress(ACCOUNT), true);
  assert.equal(isAccountAddress("CABC"), false);
  assert.equal(isValidAsset("native"), true);
  assert.equal(isValidAsset(USDC), true);
  for (const bad of ["XLM", "USDC", "USDC:GBAD", `${USDC}:extra`, "TOOLONGCODE123:" + ACCOUNT]) {
    assert.equal(isValidAsset(bad), false, bad);
  }
  // Same address the Rust engine produces for this account and id.
  assert.equal(
    muxedAddress(ACCOUNT, "100043"),
    "MBTF2Z62VJD4B54NGIS6JTGNPVH2O5HQNQF4S75NHVZIBP4JONQMQAAAAAAAAAMGZM3LK",
  );
});

test("sep7PayUri builds a memo id payment request", () => {
  assert.equal(
    sep7PayUri(ACCOUNT, "native", "5.0000000", "100001"),
    `web+stellar:pay?destination=${ACCOUNT}&amount=5&memo=100001&memo_type=MEMO_ID`,
  );
  const usdc = new URL(sep7PayUri(ACCOUNT, USDC, "12.5000000", "100002"));
  assert.equal(usdc.searchParams.get("amount"), "12.5");
  assert.equal(usdc.searchParams.get("asset_code"), "USDC");
  assert.equal(usdc.searchParams.get("asset_issuer"), USDC.split(":")[1]);
});

test("csv quotes fields and neutralises formulas", () => {
  assert.equal(csvField(null), "");
  assert.equal(csvField("plain"), "plain");
  assert.equal(csvField('Acme, "Ltd"'), '"Acme, ""Ltd"""');
  assert.equal(csvField("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvField("-2.5000000"), "-2.5000000");
  assert.equal(csvRow(["a", 1, null]), "a,1,\r\n");
});

test("router matches paths, params and methods", () => {
  const handler = async () => {};
  const routes: Route[] = [
    { method: "GET", path: "/invoices", admin: true, handler },
    { method: "GET", path: "/invoices/:id", admin: true, handler },
    { method: "POST", path: "/invoices/:id/cancel", admin: true, handler },
  ];
  const found = matchRoute(routes, "POST", "/invoices/42/cancel");
  assert.equal(found.kind, "found");
  assert.deepEqual(found.kind === "found" && found.params, { id: "42" });
  assert.equal(matchRoute(routes, "DELETE", "/invoices").kind, "method-not-allowed");
  assert.equal(matchRoute(routes, "GET", "/nope").kind, "not-found");
});

test("requireAdmin checks the bearer token", () => {
  const req = (authorization?: string) => ({ headers: { authorization } }) as IncomingMessage;
  const status = (fn: () => void) => {
    try {
      fn();
      return 200;
    } catch (err) {
      return (err as HttpError).status;
    }
  };
  assert.equal(status(() => requireAdmin(req("Bearer secret"), "secret")), 200);
  assert.equal(status(() => requireAdmin(req("Bearer wrong"), "secret")), 401);
  assert.equal(status(() => requireAdmin(req(), "secret")), 401);
  assert.equal(status(() => requireAdmin(req("Bearer secret"), "")), 503);
});

test("cursor and limit helpers", () => {
  assert.equal(decodeCursor(encodeCursor("123")), "123");
  assert.equal(decodeCursor("not-a-cursor"), null);
  assert.equal(pageLimit(new URLSearchParams("limit=500")), 200);
  assert.equal(pageLimit(new URLSearchParams("limit=0")), 1);
  assert.equal(pageLimit(new URLSearchParams("")), 50);
  assert.throws(() => pageLimit(new URLSearchParams("limit=abc")), HttpError);
});
