use anchor_lang::prelude::*;

#[cfg(feature = "devnet")]
pub const RAYDIUM_AMM_V4_PROGRAM_ID: Pubkey =
    pubkey!("HWy1jotHpo6UqeQxx49dpYYdQB8wj9Qk9MdxwjLvDHB8");

#[cfg(not(feature = "devnet"))]
pub const RAYDIUM_AMM_V4_PROGRAM_ID: Pubkey =
    pubkey!("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");

pub const SWAP_BASE_IN_V2_DISCRIMINATOR: u8 = 16;
pub const RAYDIUM_ACCOUNTS_PER_HOP: usize = 6;
pub const MAX_HOPS: usize = 3;
