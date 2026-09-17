import { Account, MuxedAccount, StrKey } from "@stellar/stellar-sdk/base";
import type { PaymentInstructions } from "@stardex/sdk";

export function isAccountAddress(address: string): boolean {
  return StrKey.isValidEd25519PublicKey(address);
}

/** `native`, or SEP-11 `CODE:ISSUER` with a 1 to 12 character alphanumeric code. */
export function isValidAsset(asset: string): boolean {
  if (asset === "native") return true;
  const [code, issuer, extra] = asset.split(":");
  return (
    extra === undefined &&
    /^[A-Za-z0-9]{1,12}$/.test(code ?? "") &&
    isAccountAddress(issuer ?? "")
  );
}

/** The muxed M... address that pays `account` with `id` attached. */
export function muxedAddress(account: string, id: string): string {
  return new MuxedAccount(new Account(account, "0"), id).accountId();
}

/**
 * A SEP-7 `pay` URI for the plain account with the reference as a MEMO_ID.
 * Memo IDs are more widely supported by wallets than muxed destinations.
 */
export function sep7PayUri(account: string, asset: string, amount: string, memo: string): string {
  const params = new URLSearchParams({ destination: account, amount: trimZeros(amount) });
  if (asset !== "native") {
    const [code, issuer] = asset.split(":");
    params.set("asset_code", code);
    params.set("asset_issuer", issuer);
  }
  params.set("memo", memo);
  params.set("memo_type", "MEMO_ID");
  return `web+stellar:pay?${params}`;
}

export function paymentInstructions(
  account: string,
  asset: string,
  amount: string,
  reference: string,
): PaymentInstructions {
  return {
    muxedAddress: muxedAddress(account, reference),
    account,
    memoType: "id",
    memo: reference,
    asset,
    amount,
    sep7Uri: sep7PayUri(account, asset, amount, reference),
  };
}

function trimZeros(amount: string): string {
  return amount.includes(".") ? amount.replace(/\.?0+$/, "") : amount;
}
