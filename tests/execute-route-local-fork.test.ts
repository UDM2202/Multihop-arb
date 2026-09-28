import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as borsh from "borsh";
import * as fs from "fs";
import * as os from "os";
import { createHash } from "crypto";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";

const ARB_PROGRAM_ID = new PublicKey("DvhAbrZDNsveNYUHCvEEgESdssw8eNeJNZMPMXfAHAeN");
const KAMINO_PROGRAM_ID = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const RAYDIUM_PROGRAM_ID = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSVAR_INSTRUCTIONS = new PublicKey("Sysvar1nstructions1111111111111111111111111");

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USER_BORROW_ACCOUNT = new PublicKey("AX8ob5dAtLNFn7tUQhDzhbBru9wqrSWVFYPCNKApCV8a");
const PROFIT_DESTINATION = new PublicKey("DP9qgXear9d6XGHhGH1bSE1c2crXKMkvDhTzKw4d3iwq");

const KAMINO_LENDING_MARKET_AUTHORITY = new PublicKey("9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo");
const KAMINO_LENDING_MARKET = new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");
const KAMINO_RESERVE = new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59");
const KAMINO_RESERVE_LIQUIDITY_SUPPLY = new PublicKey("Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6");
const KAMINO_FEE_RECEIVER = new PublicKey("BbDUrk1bVtSixgQsPLBJFZEF7mwGstnD5joA1WzYvYFX");

const RAYDIUM_AMM_ID = new PublicKey("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2");
const RAYDIUM_AMM_AUTHORITY = new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1");
const RAYDIUM_POOL_COIN_VAULT = new PublicKey("DQyrAcCrDXQ7NeoqGgDCZwBvWDcYmFCjSb9JtteuvPpz"); // WSOL vault (mintA)
const RAYDIUM_POOL_PC_VAULT = new PublicKey("HLmqeL62xR1QoZ1HKKbXRrdN1p3phKpxRMb2VVopvBBz"); // USDC vault (mintB)

function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function buildFlashBorrowIx(amount: bigint): TransactionInstruction {
  const data = Buffer.concat([
    anchorDiscriminator("flash_borrow_reserve_liquidity"),
    (() => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(amount);
      return b;
    })(),
  ]);
  return new TransactionInstruction({
    programId: KAMINO_PROGRAM_ID,
    keys: [
      { pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: false }, // placeholder, replaced below
      { pubkey: KAMINO_LENDING_MARKET_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: KAMINO_LENDING_MARKET, isSigner: false, isWritable: false },
      { pubkey: KAMINO_RESERVE, isSigner: false, isWritable: true },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: KAMINO_RESERVE_LIQUIDITY_SUPPLY, isSigner: false, isWritable: true },
      { pubkey: USER_BORROW_ACCOUNT, isSigner: false, isWritable: true },
      { pubkey: KAMINO_FEE_RECEIVER, isSigner: false, isWritable: true },
      { pubkey: KAMINO_PROGRAM_ID, isSigner: false, isWritable: false }, // referrer_token_state (unused)
      { pubkey: KAMINO_PROGRAM_ID, isSigner: false, isWritable: false }, // referrer_account (unused)
      { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildFlashRepayIx(amount: bigint, borrowIndex: number): TransactionInstruction {
  const data = Buffer.concat([
    anchorDiscriminator("flash_repay_reserve_liquidity"),
    (() => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(amount);
      return b;
    })(),
    Buffer.from([borrowIndex]),
  ]);
  return new TransactionInstruction({
    programId: KAMINO_PROGRAM_ID,
    keys: [
      { pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: false }, // placeholder, replaced below
      { pubkey: KAMINO_LENDING_MARKET_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: KAMINO_LENDING_MARKET, isSigner: false, isWritable: false },
      { pubkey: KAMINO_RESERVE, isSigner: false, isWritable: true },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: KAMINO_RESERVE_LIQUIDITY_SUPPLY, isSigner: false, isWritable: true },
      { pubkey: USER_BORROW_ACCOUNT, isSigner: false, isWritable: true },
      { pubkey: KAMINO_FEE_RECEIVER, isSigner: false, isWritable: true },
      { pubkey: KAMINO_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: KAMINO_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

const pubkeySchema = { array: { type: "u8", len: 32 } };
const swapStepSchema = {
  struct: {
    amm: pubkeySchema,
    input_mint: pubkeySchema,
    output_mint: pubkeySchema,
    min_out: "u64",
  },
};
// Byte offset of Reserve.config.fees.flash_loan_fee_sf, derived from Kamino's
// on-chain IDL (8-byte discriminator included). The fee is a u64 scaled
// fraction with 60 fractional bits.
const RESERVE_FLASH_LOAN_FEE_SF_OFFSET = 4904;
const FRACTION_BITS = BigInt(60);

async function readFlashLoanFeeSf(connection: Connection): Promise<bigint> {
  const info = await connection.getAccountInfo(KAMINO_RESERVE);
  if (!info) throw new Error("Kamino reserve account not found");
  const sf = info.data.readBigUInt64LE(RESERVE_FLASH_LOAN_FEE_SF_OFFSET);
  if (sf === BigInt("18446744073709551615")) throw new Error("Flash loans disabled on this reserve");
  return sf;
}

// Kamino charges the fee on top of the repaid principal, rounded up.
function flashLoanFee(amount: bigint, feeSf: bigint): bigint {
  const one = BigInt(1) << FRACTION_BITS;
  return (amount * feeSf + one - BigInt(1)) >> FRACTION_BITS;
}

async function tokenBalance(connection: Connection, account: PublicKey): Promise<bigint> {
  return BigInt((await connection.getTokenAccountBalance(account)).value.amount);
}

const argsSchema = {
  struct: {
    route: { array: { type: swapStepSchema } },
    amount_in: "u64",
    min_profit_lamports: "u64",
    required_repay_amount: "u64",
  },
};

async function main() {
  const connection = new Connection("http://127.0.0.1:8899", "confirmed");
  const secret = JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf-8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));

  const borrowAmount = BigInt(1_000_000);
  // Kamino's repay instruction takes the principal only; the fee is pulled
  // separately from the same account, so our route must cover both.
  const repayAmount = borrowAmount;
  const feeSf = await readFlashLoanFeeSf(connection);
  const fee = flashLoanFee(borrowAmount, feeSf);

  // execute_swap_route swaps exactly amount_in (the principal) and checks the
  // route's own output against principal + fee, so any other balance in the
  // account is neither traded nor able to mask a loss.
  const preExistingBalance = await tokenBalance(connection, USER_BORROW_ACCOUNT);
  const requiredRepayAmount = borrowAmount + fee;
  console.log(
    `amount_in=${borrowAmount} fee=${fee} (fee_sf=${feeSf}) other balance=${preExistingBalance} required_repay_amount=${requiredRepayAmount}`
  );

  const borrowIx = buildFlashBorrowIx(borrowAmount);
  borrowIx.keys[0] = { pubkey: payer.publicKey, isSigner: true, isWritable: true };

  const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
  const wsolAta = getAssociatedTokenAddressSync(WSOL_MINT, payer.publicKey);
  const createWsolAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey,
    wsolAta,
    payer.publicKey,
    WSOL_MINT
  );

  // Two hops through the same pool so the loan is repaid in the same token
  // (USDC) it was borrowed in: USDC -> WSOL -> USDC.
  const route = [
    {
      amm: RAYDIUM_AMM_ID.toBytes(),
      input_mint: USDC_MINT.toBytes(),
      output_mint: WSOL_MINT.toBytes(),
      min_out: BigInt(0),
    },
    {
      amm: RAYDIUM_AMM_ID.toBytes(),
      input_mint: WSOL_MINT.toBytes(),
      output_mint: USDC_MINT.toBytes(),
      min_out: BigInt(0),
    },
  ];
  const args = { route, amount_in: borrowAmount, min_profit_lamports: BigInt(0), required_repay_amount: requiredRepayAmount };
  const encodedArgs = borsh.serialize(argsSchema, args);
  const swapData = Buffer.concat([anchorDiscriminator("execute_swap_route"), Buffer.from(encodedArgs)]);

  const remainingAccounts = [
    // Hop 0: USDC -> WSOL
    { pubkey: RAYDIUM_AMM_ID, isSigner: false, isWritable: true },
    { pubkey: RAYDIUM_AMM_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: RAYDIUM_POOL_COIN_VAULT, isSigner: false, isWritable: true },
    { pubkey: RAYDIUM_POOL_PC_VAULT, isSigner: false, isWritable: true },
    { pubkey: USER_BORROW_ACCOUNT, isSigner: false, isWritable: true },
    { pubkey: wsolAta, isSigner: false, isWritable: true },
    // Hop 1: WSOL -> USDC
    { pubkey: RAYDIUM_AMM_ID, isSigner: false, isWritable: true },
    { pubkey: RAYDIUM_AMM_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: RAYDIUM_POOL_COIN_VAULT, isSigner: false, isWritable: true },
    { pubkey: RAYDIUM_POOL_PC_VAULT, isSigner: false, isWritable: true },
    { pubkey: wsolAta, isSigner: false, isWritable: true },
    { pubkey: USER_BORROW_ACCOUNT, isSigner: false, isWritable: true },
  ];

  const swapIx = new TransactionInstruction({
    programId: ARB_PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: USER_BORROW_ACCOUNT, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: RAYDIUM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...remainingAccounts,
    ],
    data: swapData,
  });

  // Kamino's repay instruction references the borrow by its index within the
  // transaction. createWsolAtaIx is index 0, so borrow is index 1.
  const repayIx = buildFlashRepayIx(repayAmount, 1);
  repayIx.keys[0] = { pubkey: payer.publicKey, isSigner: true, isWritable: true };

  const tx = new Transaction().add(createWsolAtaIx, borrowIx, swapIx, repayIx);
  console.log("Sending 4-instruction flash-loan transaction (create WSOL ATA, borrow, 2-hop swap, repay) against local mainnet-fork...");
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
    console.log("Success! Signature:", sig);
    const after = await tokenBalance(connection, USER_BORROW_ACCOUNT);
    console.log(`Net result after repay (principal + fee): ${after - preExistingBalance} units`);
  } catch (err: any) {
    console.log("Transaction failed (may be expected — see script comment).");
    console.log(err.message ?? err);
    if (err.logs) {
      console.log("--- Program logs ---");
      err.logs.forEach((l: string) => console.log(l));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
