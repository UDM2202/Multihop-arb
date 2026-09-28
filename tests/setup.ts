import { Connection, Keypair, clusterApiUrl } from "@solana/web3.js";
import {
  createMint,
  createAccount,
  mintTo,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";

async function main() {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const secret = JSON.parse(
    fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf-8")
  );
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));

  console.log("Payer:", payer.publicKey.toBase58());

  const mint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    6
  );
  console.log("Mint:", mint.toBase58());

  const borrowAccountKeypair = Keypair.generate();
  const userBorrowAccount = await createAccount(
    connection,
    payer,
    mint,
    payer.publicKey,
    borrowAccountKeypair
  );
  console.log("User borrow token account:", userBorrowAccount.toBase58());

  const profitAccountKeypair = Keypair.generate();
  const profitDestination = await createAccount(
    connection,
    payer,
    mint,
    payer.publicKey,
    profitAccountKeypair
  );
  console.log("Profit destination:", profitDestination.toBase58());

  await mintTo(connection, payer, mint, userBorrowAccount, payer, 1_000_000);
  console.log("Minted 1 token to user borrow account");

  const out = {
    mint: mint.toBase58(),
    userBorrowAccount: userBorrowAccount.toBase58(),
    profitDestination: profitDestination.toBase58(),
  };
  fs.writeFileSync("tests/devnet-accounts.json", JSON.stringify(out, null, 2));
  console.log("Saved to tests/devnet-accounts.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
