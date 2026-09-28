import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ArbExecutor } from "../target/types/arb_executor";

describe("arb-executor", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.ArbExecutor as Program<ArbExecutor>;

  it("initializes", async () => {
    const tx = await program.methods.initialize().rpc();
    console.log("Init tx:", tx);
  });

  it("executes a 2-hop route (placeholder)", async () => {
    // TODO: Replace with actual devnet pool addresses
    // You'll need to fetch real Raydium pool accounts from devnet
    console.log("Configure real pools before running");
  });
});