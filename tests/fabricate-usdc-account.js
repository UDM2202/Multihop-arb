// Generates a genesis account-snapshot JSON for a fabricated USDC token
// account, to be loaded into solana-test-validator via `--account <PUBKEY>
// <FILE>` at startup. This is necessary because the real USDC mint's
// mint-authority is Circle-controlled — we can't call MintTo against a
// cloned mainnet-fork mint — so instead we fabricate the token account's
// raw bytes directly (owner + amount), which is fine on a disconnected
// local fork.
const { PublicKey, Keypair } = require("@solana/web3.js");
const { AccountLayout, AccountState } = require("@solana/spl-token");
const fs = require("fs");
const os = require("os");

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USER_BORROW_ACCOUNT = new PublicKey("AX8ob5dAtLNFn7tUQhDzhbBru9wqrSWVFYPCNKApCV8a");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const RENT_EXEMPT_LAMPORTS = 2_039_280;

function main() {
  const secret = JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf-8"));
  const owner = Keypair.fromSecretKey(Uint8Array.from(secret)).publicKey;

  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint: USDC_MINT,
      owner,
      amount: BigInt(1_000_000), // 1 USDC (6 decimals)
      delegateOption: 0,
      delegate: PublicKey.default,
      state: AccountState.Initialized,
      isNativeOption: 0,
      isNative: BigInt(0),
      delegatedAmount: BigInt(0),
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data
  );

  const out = {
    pubkey: USER_BORROW_ACCOUNT.toBase58(),
    account: {
      lamports: RENT_EXEMPT_LAMPORTS,
      data: [data.toString("base64"), "base64"],
      owner: TOKEN_PROGRAM_ID.toBase58(),
      executable: false,
      rentEpoch: 0,
      space: AccountLayout.span,
    },
  };

  const outPath = "tests/fabricated-usdc-account.json";
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log("Wrote", outPath, "for owner", owner.toBase58());
}

main();
