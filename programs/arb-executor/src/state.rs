use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct SwapStep {
    pub amm: Pubkey,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub min_out: u64,
}
