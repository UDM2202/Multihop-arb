use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;
use anchor_spl::token::spl_token::state::Account as SplTokenAccount;
use anchor_spl::token::{Token, TokenAccount};
use anchor_lang::solana_program::program_pack::Pack;

mod constants;
mod state;
use crate::constants::*;
use crate::state::*;

declare_id!("DvhAbrZDNsveNYUHCvEEgESdssw8eNeJNZMPMXfAHAeN");

// IMPORTANT: Kamino forbids calling its flash-borrow/repay instructions via
// CPI (error 6031 "No cpi flash borrows allowed" — confirmed against a real
// local-validator fork of mainnet). Flash borrow and repay must be separate
// TOP-LEVEL instructions in the same transaction, built by the client, with
// this program's execute_swap_route as a middle instruction that assumes
// the borrowed funds are already in user_borrow_token_account when it runs
// and leaves the swap output in profit_destination for the repay
// instruction to draw from. Transaction shape:
//   [0] Kamino FlashBorrowReserveLiquidity (top-level)
//   [1] this program's execute_swap_route
//   [2] Kamino FlashRepayReserveLiquidity (top-level, references [0]'s index)
// Kamino's instructions-sysvar introspection enforces borrow/repay pairing;
// if repay fails, the whole transaction reverts, undoing the swaps too —
// this is what makes the "loan" safe without our program touching Kamino.

#[program]
pub mod arb_executor {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }

    /// Swaps exactly `amount_in` (the flash-loan principal) through `route`.
    /// Funds already sitting in any of the user's token accounts are never
    /// traded: hop 0 spends `amount_in`, and each later hop spends only what
    /// the previous hop produced (its destination's balance delta).
    ///
    /// Profit check: the route's net output back into the borrow account,
    /// `final_balance - (starting_balance - amount_in)`, must cover
    /// `required_repay_amount` (principal + Kamino fee) + `min_profit_lamports`.
    pub fn execute_swap_route<'info>(
        ctx: Context<'_, '_, '_, 'info, ExecuteSwapRoute<'info>>,
        route: Vec<SwapStep>,
        amount_in: u64,
        min_profit_lamports: u64,
        required_repay_amount: u64,
    ) -> Result<()> {
        require!(!route.is_empty(), ArbError::EmptyRoute);
        require!(route.len() <= MAX_HOPS, ArbError::TooManyHops);
        require!(amount_in > 0, ArbError::ZeroAmountIn);
        // The route must return at least everything it spends. Without this,
        // a client passing amount_in > principal (with required_repay_amount
        // = principal + fee) would let the route burn pre-existing funds and
        // still pass the profit check.
        require!(required_repay_amount >= amount_in, ArbError::RepayBelowAmountIn);

        let expected_accounts = route.len() * RAYDIUM_ACCOUNTS_PER_HOP;
        require!(
            ctx.remaining_accounts.len() == expected_accounts,
            ArbError::WrongAccountCount
        );

        let borrow_account_info = ctx.accounts.user_borrow_token_account.to_account_info();
        let starting_balance = token_amount(&borrow_account_info)?;
        require!(amount_in <= starting_balance, ArbError::InsufficientInputBalance);
        // Whatever isn't being traded must still be there at the end.
        let untouched_balance = starting_balance - amount_in;

        msg!(
            "Swap route start: borrow account balance = {}, amount_in = {}",
            starting_balance,
            amount_in
        );

        let mut next_amount_in: u64 = amount_in;
        let mut prev_dest: Option<Pubkey> = None;

        for (i, step) in route.iter().enumerate() {
            let start = i * RAYDIUM_ACCOUNTS_PER_HOP;
            let hop_accounts =
                &ctx.remaining_accounts[start..start + RAYDIUM_ACCOUNTS_PER_HOP];

            let amm_id = &hop_accounts[0];
            let amm_authority = &hop_accounts[1];
            let pool_coin_vault = &hop_accounts[2];
            let pool_pc_vault = &hop_accounts[3];
            let user_source = &hop_accounts[4];
            let user_dest = &hop_accounts[5];

            require_keys_eq!(amm_id.key(), step.amm, ArbError::AmmMismatch);

            // Hop 0 spends from the borrow account; every later hop spends
            // from the account the previous hop paid into.
            let expected_source = prev_dest.unwrap_or(borrow_account_info.key());
            require_keys_eq!(user_source.key(), expected_source, ArbError::HopAccountsDontChain);

            let amount_in = next_amount_in;
            let dest_before = token_amount(user_dest)?;

            msg!(
                "Hop {}: swap {} of {} -> {} via amm {}",
                i,
                amount_in,
                step.input_mint,
                step.output_mint,
                step.amm
            );

            let mut data = vec![SWAP_BASE_IN_V2_DISCRIMINATOR];
            data.extend_from_slice(&amount_in.to_le_bytes());
            data.extend_from_slice(&step.min_out.to_le_bytes());

            let accounts = vec![
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
                AccountMeta::new(amm_id.key(), false),
                AccountMeta::new_readonly(amm_authority.key(), false),
                AccountMeta::new(pool_coin_vault.key(), false),
                AccountMeta::new(pool_pc_vault.key(), false),
                AccountMeta::new(user_source.key(), false),
                AccountMeta::new(user_dest.key(), false),
                AccountMeta::new_readonly(ctx.accounts.payer.key(), true),
            ];

            let ix = Instruction {
                program_id: RAYDIUM_AMM_V4_PROGRAM_ID,
                accounts,
                data,
            };

            invoke(
                &ix,
                &[
                    ctx.accounts.token_program.to_account_info(),
                    amm_id.clone(),
                    amm_authority.clone(),
                    pool_coin_vault.clone(),
                    pool_pc_vault.clone(),
                    user_source.clone(),
                    user_dest.clone(),
                    ctx.accounts.payer.to_account_info(),
                    ctx.accounts.raydium_program.to_account_info(),
                ],
            )?;

            // Only what this hop produced moves on, never pre-existing funds.
            next_amount_in = token_amount(user_dest)?
                .checked_sub(dest_before)
                .ok_or(ArbError::MathOverflow)?;
            prev_dest = Some(user_dest.key());

            if i == route.len() - 1 {
                require_keys_eq!(
                    user_dest.key(),
                    borrow_account_info.key(),
                    ArbError::FinalHopMustTargetProfitDestination
                );
            }
        }

        let final_balance = token_amount(&borrow_account_info)?;
        // Net amount the route delivered back, beyond the untouched funds.
        // A shortfall below untouched_balance is unprofitable, not overflow.
        let route_output = final_balance.saturating_sub(untouched_balance);
        let required = required_repay_amount
            .checked_add(min_profit_lamports)
            .ok_or(ArbError::MathOverflow)?;
        require!(route_output >= required, ArbError::NotProfitable);

        msg!(
            "Swap route complete: route_output={}, required_repay_amount={}, min_profit_lamports={}, final_balance={}",
            route_output,
            required_repay_amount,
            min_profit_lamports,
            final_balance
        );

        Ok(())
    }
}

fn token_amount(info: &AccountInfo) -> Result<u64> {
    let data = info.try_borrow_data()?;
    Ok(SplTokenAccount::unpack(&data)?.amount)
}

#[derive(Accounts)]
pub struct Initialize {}

#[derive(Accounts)]
pub struct ExecuteSwapRoute<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub user_borrow_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,

    /// CHECK: Raydium AMM v4 program, needed so the runtime can resolve the
    /// swap CPI target. Verified by address, not deserialized.
    #[account(address = RAYDIUM_AMM_V4_PROGRAM_ID)]
    pub raydium_program: UncheckedAccount<'info>,
    // remaining_accounts: per hop, 6 Raydium accounts:
    // [amm_id, amm_authority, pool_coin_vault, pool_pc_vault, user_source,
    // user_dest].
}

#[error_code]
pub enum ArbError {
    #[msg("Route cannot be empty")]
    EmptyRoute,
    #[msg("Route exceeds maximum supported hops")]
    TooManyHops,
    #[msg("remaining_accounts length does not match route length")]
    WrongAccountCount,
    #[msg("Supplied amm account does not match route step")]
    AmmMismatch,
    #[msg("The last hop's output account must be profit_destination")]
    FinalHopMustTargetProfitDestination,
    #[msg("Route output for amount_in is below required repay amount + minimum profit")]
    NotProfitable,
    #[msg("Math overflow")]
    MathOverflow,
    // New variants go below so existing error codes keep their numbers.
    #[msg("amount_in must be greater than zero")]
    ZeroAmountIn,
    #[msg("Borrow account holds less than amount_in")]
    InsufficientInputBalance,
    #[msg("Each hop must spend from the borrow account (hop 0) or the previous hop's output account")]
    HopAccountsDontChain,
    #[msg("required_repay_amount must be at least amount_in")]
    RepayBelowAmountIn,
}
