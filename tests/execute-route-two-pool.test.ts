// Two-pool arbitrage against the local mainnet fork:
//   Kamino flash-borrow USDC -> buy WSOL on pool B -> sell WSOL on pool A -> repay principal + fee.
//
// Mainnet prices between the two Raydium SOL/USDC pools are already arbitraged
// to within the 0.5% round-trip fee, so this script first opens a real price
// dislocation on the fork: a separate "whale" wallet dumps SOL into the small
// pool B, making SOL cheap there. The whale uses its own token accounts so none
// of its funds can leak into the arb's profit accounting.
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
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
  createSyncNativeInstruction,
} from "@solana/spl-token";

const ARB_PROGRAM_ID = new PublicKey("DvhAbrZDNsveNYUHCvEEgESdssw8eNeJNZMPMXfAHAeN");
const KAMINO_PROGRAM_ID = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const RAYDIUM_PROGRAM_ID = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSVAR_INSTRUCTIONS = new PublicKey("Sysvar1nstructions1111111111111111111111111");

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USER_BORROW_ACCOUNT = new PublicKey("AX8ob5dAtLNFn7tUQhDzhbBru9wqrSWVFYPCNKApCV8a");

const KAMINO_LENDING_MARKET_AUTHORITY = new PublicKey("9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo");
const KAMINO_LENDING_MARKET = new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");
const KAMINO_RESERVE = new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59");
const KAMINO_RESERVE_LIQUIDITY_SUPPLY = new PublicKey("Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6");
const KAMINO_FEE_RECEIVER = new PublicKey("BbDUrk1bVtSixgQsPLBJFZEF7mwGstnD5joA1WzYvYFX");

const RAYDIUM_AMM_AUTHORITY = new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1");

interface Pool {
  name: string;
  amm: PublicKey;
  coinVault: PublicKey; // WSOL
  pcVault: PublicKey; // USDC
}

// Deep pool (~$36M TVL): the exit leg.
const POOL_A: Pool = {
  name: "A",
  amm: new PublicKey("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"),
  coinVault: new PublicKey("DQyrAcCrDXQ7NeoqGgDCZwBvWDcYmFCjSb9JtteuvPpz"),
  pcVault: new PublicKey("HLmqeL62xR1QoZ1HKKbXRrdN1p3phKpxRMb2VVopvBBz"),
};

// Shallow pool (~$3k TVL): the one we dislocate and buy from.
const POOL_B: Pool = {
  name: "B",
  amm: new PublicKey("5oAvct85WyF7Sj73VYHbyFJkdRJ28D8m4z4Sxjvzuc6n"),
  coinVault: new PublicKey("FzNRkDo1o1oeBud2J9Rz66FqQCyxjpmxcao4iFsewEGa"),
  pcVault: new PublicKey("tAoQ7jLRJdtrw1vhZzoCHxHfsWp3cdn9SqnPvP1LVMT"),
};

// SOL the whale dumps into pool B to open the dislocation.
const SKEW_SOL = 3;

// Raydium AMM v4 trade fee: 25 / 10000.
const RAYDIUM_FEE_NUM = BigInt(25);
const RAYDIUM_FEE_DEN = BigInt(10000);

// Byte offset of Reserve.config.fees.flash_loan_fee_sf, derived from Kamino's
// on-chain IDL (8-byte discriminator included). The fee is a u64 scaled
// fraction with 60 fractional bits.
const RESERVE_FLASH_LOAN_FEE_SF_OFFSET = 4904;
const FRACTION_BITS = BigInt(60);

function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function u64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

function kaminoFlashKeys(payer: PublicKey) {
  return [
    { pubkey: payer, isSigner: true, isWritable: true },
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
  ];
}

function buildFlashBorrowIx(payer: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: KAMINO_PROGRAM_ID,
    keys: kaminoFlashKeys(payer),
    data: Buffer.concat([anchorDiscriminator("flash_borrow_reserve_liquidity"), u64(amount)]),
  });
}

function buildFlashRepayIx(payer: PublicKey, amount: bigint, borrowIndex: number): TransactionInstruction {
  return new TransactionInstruction({
    programId: KAMINO_PROGRAM_ID,
    keys: kaminoFlashKeys(payer),
    data: Buffer.concat([
      anchorDiscriminator("flash_repay_reserve_liquidity"),
      u64(amount),
      Buffer.from([borrowIndex]),
    ]),
  });
}

// Direct (non-CPI) Raydium swap_base_in_v2, same account order the program uses.
function buildRaydiumSwapIx(
  pool: Pool,
  source: PublicKey,
  dest: PublicKey,
  owner: PublicKey,
  amountIn: bigint,
  minOut: bigint
): TransactionInstruction {
  return new TransactionInstruction({
    programId: RAYDIUM_PROGRAM_ID,
    keys: [
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: pool.amm, isSigner: false, isWritable: true },
      { pubkey: RAYDIUM_AMM_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: pool.coinVault, isSigner: false, isWritable: true },
      { pubkey: pool.pcVault, isSigner: false, isWritable: true },
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([16]), u64(amountIn), u64(minOut)]),
  });
}

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
  const info = await connection.getAccountInfo(account);
  if (!info) return BigInt(0);
  return BigInt((await connection.getTokenAccountBalance(account)).value.amount);
}

interface Reserves {
  sol: bigint;
  usdc: bigint;
}

async function poolReserves(connection: Connection, pool: Pool): Promise<Reserves> {
  return {
    sol: await tokenBalance(connection, pool.coinVault),
    usdc: await tokenBalance(connection, pool.pcVault),
  };
}

// Constant-product quote with Raydium's fee taken from the input. This uses raw
// vault balances and ignores the AMM's pending PnL, so it is an estimate; the
// on-chain profit check is what actually decides.
function quote(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  const inAfterFee = (amountIn * (RAYDIUM_FEE_DEN - RAYDIUM_FEE_NUM)) / RAYDIUM_FEE_DEN;
  return (inAfterFee * reserveOut) / (reserveIn + inAfterFee);
}

function roundTrip(usdcIn: bigint, b: Reserves, a: Reserves): bigint {
  const sol = quote(usdcIn, b.usdc, b.sol);
  return quote(sol, a.sol, a.usdc);
}

// Ternary search over the concave profit curve for the best USDC input size.
function optimalInput(b: Reserves, a: Reserves): bigint {
  let lo = BigInt(1);
  let hi = b.usdc; // never sensible to push more than the pool's whole USDC side
  const profit = (x: bigint) => roundTrip(x, b, a) - x;
  while (hi - lo > BigInt(2)) {
    const m1 = lo + (hi - lo) / BigInt(3);
    const m2 = hi - (hi - lo) / BigInt(3);
    if (profit(m1) < profit(m2)) lo = m1;
    else hi = m2;
  }
  return lo;
}

function describePrice(label: string, r: Reserves) {
  // USDC has 6 decimals, SOL 9.
  const price = (Number(r.usdc) / 1e6) / (Number(r.sol) / 1e9);
  console.log(`  pool ${label}: ${Number(r.sol) / 1e9} SOL / ${Number(r.usdc) / 1e6} USDC  -> ${price.toFixed(4)} USDC/SOL`);
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
const argsSchema = {
  struct: {
    route: { array: { type: swapStepSchema } },
    amount_in: "u64",
    min_profit_lamports: "u64",
    required_repay_amount: "u64",
  },
};

async function skewPoolB(connection: Connection) {
  const whale = Keypair.generate();
  const sig = await connection.requestAirdrop(whale.publicKey, (SKEW_SOL + 1) * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");

  const whaleWsol = getAssociatedTokenAddressSync(WSOL_MINT, whale.publicKey);
  const whaleUsdc = getAssociatedTokenAddressSync(USDC_MINT, whale.publicKey);
  const skewLamports = BigInt(SKEW_SOL * LAMPORTS_PER_SOL);

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(whale.publicKey, whaleWsol, whale.publicKey, WSOL_MINT),
    createAssociatedTokenAccountIdempotentInstruction(whale.publicKey, whaleUsdc, whale.publicKey, USDC_MINT),
    SystemProgram.transfer({ fromPubkey: whale.publicKey, toPubkey: whaleWsol, lamports: skewLamports }),
    createSyncNativeInstruction(whaleWsol),
    buildRaydiumSwapIx(POOL_B, whaleWsol, whaleUsdc, whale.publicKey, skewLamports, BigInt(0))
  );
  await sendAndConfirmTransaction(connection, tx, [whale]);
  console.log(`Whale dumped ${SKEW_SOL} SOL into pool B.`);
}

async function main() {
  const connection = new Connection("http://127.0.0.1:8899", "confirmed");
  const secret = JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf-8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));

  const wsolAta = getAssociatedTokenAddressSync(WSOL_MINT, payer.publicKey);
  // Leftover WSOL here is fine: hop 1 sells only what hop 0 produced.

  console.log("Before skew:");
  describePrice("A", await poolReserves(connection, POOL_A));
  describePrice("B", await poolReserves(connection, POOL_B));

  await skewPoolB(connection);

  const a = await poolReserves(connection, POOL_A);
  const b = await poolReserves(connection, POOL_B);
  console.log("After skew:");
  describePrice("A", a);
  describePrice("B", b);

  // The program swaps exactly amount_in (= the borrow), never other funds
  // in the account, so the borrow is simply the optimal route input.
  const preExistingBalance = await tokenBalance(connection, USER_BORROW_ACCOUNT);
  const borrowAmount = optimalInput(b, a);
  const expectedOut = roundTrip(borrowAmount, b, a);

  const feeSf = await readFlashLoanFeeSf(connection);
  const fee = flashLoanFee(borrowAmount, feeSf);

  // The route's own output must cover principal + fee (+ min_profit).
  const requiredRepayAmount = borrowAmount + fee;
  console.log(
    `other balance=${preExistingBalance} amount_in=${borrowAmount} fee=${fee} ` +
      `expected_out=${expectedOut} expected_net=${expectedOut - requiredRepayAmount} ` +
      `required_repay_amount=${requiredRepayAmount}`
  );

  const route = [
    { amm: POOL_B.amm.toBytes(), input_mint: USDC_MINT.toBytes(), output_mint: WSOL_MINT.toBytes(), min_out: BigInt(0) },
    { amm: POOL_A.amm.toBytes(), input_mint: WSOL_MINT.toBytes(), output_mint: USDC_MINT.toBytes(), min_out: BigInt(0) },
  ];
  const args = { route, amount_in: borrowAmount, min_profit_lamports: BigInt(0), required_repay_amount: requiredRepayAmount };
  const swapData = Buffer.concat([
    anchorDiscriminator("execute_swap_route"),
    Buffer.from(borsh.serialize(argsSchema, args)),
  ]);

  const hopAccounts = (pool: Pool, source: PublicKey, dest: PublicKey) => [
    { pubkey: pool.amm, isSigner: false, isWritable: true },
    { pubkey: RAYDIUM_AMM_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: pool.coinVault, isSigner: false, isWritable: true },
    { pubkey: pool.pcVault, isSigner: false, isWritable: true },
    { pubkey: source, isSigner: false, isWritable: true },
    { pubkey: dest, isSigner: false, isWritable: true },
  ];

  const swapIx = new TransactionInstruction({
    programId: ARB_PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: USER_BORROW_ACCOUNT, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: RAYDIUM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...hopAccounts(POOL_B, USER_BORROW_ACCOUNT, wsolAta), // hop 0: USDC -> WSOL on B
      ...hopAccounts(POOL_A, wsolAta, USER_BORROW_ACCOUNT), // hop 1: WSOL -> USDC on A
    ],
    data: swapData,
  });

  const createWsolAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey,
    wsolAta,
    payer.publicKey,
    WSOL_MINT
  );
  // createWsolAtaIx is index 0, so the borrow is index 1.
  const tx = new Transaction().add(
    createWsolAtaIx,
    buildFlashBorrowIx(payer.publicKey, borrowAmount),
    swapIx,
    buildFlashRepayIx(payer.publicKey, borrowAmount, 1)
  );

  console.log("Sending two-pool flash-loan arb (create WSOL ATA, borrow, B->A swap route, repay)...");
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
    console.log("Success! Signature:", sig);
    const after = await tokenBalance(connection, USER_BORROW_ACCOUNT);
    console.log(`Net profit after repaying principal + fee: ${after - preExistingBalance} USDC units`);
  } catch (err: any) {
    console.log("Transaction failed.");
    console.log(err.message ?? err);
    if (err.logs) {
      console.log("--- Program logs ---");
      err.logs.forEach((l: string) => console.log(l));
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
