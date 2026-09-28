import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as borsh from "borsh";
import * as fs from "fs";
import * as os from "os";
import { createHash } from "crypto";

const PROGRAM_ID = new PublicKey(
  "DvhAbrZDNsveNYUHCvEEgESdssw8eNeJNZMPMXfAHAeN"
);
const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

function anchorDiscriminator(name: string): Buffer {
  const hash = createHash("sha256").update(`global:${name}`).digest();
  return hash.subarray(0, 8);
}

// --- Borsh schemas mirroring state.rs ---
class SwapStep {
  amm: Uint8Array;
  input_mint: Uint8Array;
  output_mint: Uint8Array;
  min_out: bigint;
  constructor(fields: any) {
    Object.assign(this, fields);
  }
}
class FlashLoanParams {
  borrow_mint: Uint8Array;
  reserve: Uint8Array;
  lending_market: Uint8Array;
  borrow_amount: bigint;
  borrow_fee_bps: bigint;
  constructor(fields: any) {
    Object.assign(this, fields);
  }
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

const flashLoanSchema = {
  struct: {
    borrow_mint: pubkeySchema,
    reserve: pubkeySchema,
    lending_market: pubkeySchema,
    borrow_amount: "u64",
    borrow_fee_bps: "u64",
  },
};

const argsSchema = {
  struct: {
    flash_loan: flashLoanSchema,
    route: { array: { type: swapStepSchema } },
    min_profit_lamports: "u64",
  },
};

async function main() {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const secret = JSON.parse(
    fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf-8")
  );
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));

  const accounts = JSON.parse(
    fs.readFileSync("tests/devnet-accounts.json", "utf-8")
  );
  const mint = new PublicKey(accounts.mint);
  const userBorrowAccount = new PublicKey(accounts.userBorrowAccount);
  const profitDestination = new PublicKey(accounts.profitDestination);

  const dummyAmm = Keypair.generate().publicKey;

  const flashLoan = new FlashLoanParams({
    borrow_mint: mint.toBytes(),
    reserve: Keypair.generate().publicKey.toBytes(),
    lending_market: Keypair.generate().publicKey.toBytes(),
    borrow_amount: BigInt(100000),
    borrow_fee_bps: BigInt(5),
  });

  const route = [
    new SwapStep({
      amm: dummyAmm.toBytes(),
      input_mint: mint.toBytes(),
      output_mint: mint.toBytes(),
      min_out: BigInt(1),
    }),
  ];

  const args = {
    flash_loan: flashLoan,
    route: route,
    min_profit_lamports: BigInt(0),
  };

  const encodedArgs = borsh.serialize(argsSchema, args);
  const discriminator = anchorDiscriminator("execute_route");
  const data = Buffer.concat([discriminator, Buffer.from(encodedArgs)]);

  // 7 dummy remaining_accounts for the 1 hop, matching ACCOUNTS_PER_HOP
  const remainingAccounts = Array.from({ length: 7 }, () => ({
    pubkey: Keypair.generate().publicKey,
    isSigner: false,
    isWritable: false,
  }));

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: userBorrowAccount, isSigner: false, isWritable: true },
      { pubkey: profitDestination, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ...remainingAccounts,
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  console.log("Sending execute_route transaction...");
  const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
  console.log("Success! Signature:", sig);
  console.log(`https://explorer.solana.com/tx/${sig}?cluster=devnet`);
}

main().catch((err) => {
  console.error("Transaction failed:");
  console.error(err);
  if (err.logs) console.error("Logs:", err.logs);
  process.exit(1);
});
