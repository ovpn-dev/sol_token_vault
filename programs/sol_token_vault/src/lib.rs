use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

declare_id!("DjZLtdJ4Ccz49koPEAuDWAsenAoXjws2nosxHRzBADUJ");

#[program]
pub mod sol_token_vault {
    use super::*;

    /// Creates the vault PDA and its associated token account
    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        
        // Store vault data
        vault.merchant = ctx.accounts.merchant.key();
        vault.mint = ctx.accounts.mint.key();
        vault.bump = ctx.bumps.vault;
        
        // Emit event for indexing
        emit!(VaultInitialized {
            merchant: vault.merchant,
            mint: vault.mint,
            vault: ctx.accounts.vault.key(),
            vault_ata: ctx.accounts.vault_ata.key(),
        });

        Ok(())
    }

    /// Deposit tokens into the vault
    /// Anyone can deposit, but tokens go to the vault's ATA
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        // Validation
        require!(amount > 0, VaultError::AmountIsZero);
        
        // CPI to SPL Token Program to transfer from depositor to vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.depositor_ata.to_account_info(),
            to: ctx.accounts.vault_ata.to_account_info(),
            authority: ctx.accounts.depositor.to_account_info(),
        };

        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        
        token::transfer(cpi_ctx, amount)?;

        // Emit event
        emit!(TokensDeposited {
            vault: ctx.accounts.vault.key(),
            depositor: ctx.accounts.depositor.key(),
            amount,
        });

        Ok(())
    }

    /// Settle tokens from vault to merchant, optional referrer, and fee receiver
    /// Only the merchant can call this function
    pub fn settle(
        ctx: Context<Settle>,
        amount: u64,
        fee_bps: u16,
        referrer_bps: u16,
    ) -> Result<()> {
        // Validations
        require!(amount > 0, VaultError::AmountIsZero);
        require!(
            fee_bps <= 10_000 && referrer_bps <= 10_000,
            VaultError::InvalidBasisPoints
        );
        require!(
            (fee_bps as u32 + referrer_bps as u32) <= 10_000,
            VaultError::InvalidBasisPoints
        );
        require!(
            ctx.accounts.vault_ata.amount >= amount,
            VaultError::InsufficientVaultBalance
        );

        // If no referrer provided, referrer_bps must be 0
        if ctx.accounts.referrer.is_none() && referrer_bps > 0 {
            return err!(VaultError::InvalidBasisPoints);
        }

        // Calculate amounts using u128 to prevent overflow
        let fee_amount: u64 = ((amount as u128 * fee_bps as u128) / 10_000) as u64;
        let referrer_amount: u64 = if referrer_bps > 0 && ctx.accounts.referrer.is_some() {
            ((amount as u128 * referrer_bps as u128) / 10_000) as u64
        } else {
            0
        };
        
        // Merchant gets the rest
        let merchant_amount = amount
            .checked_sub(fee_amount)
            .and_then(|v| v.checked_sub(referrer_amount))
            .ok_or(VaultError::InvalidSettlement)?;

        // Create signer seeds for PDA
        let vault = &ctx.accounts.vault;
        let seeds = &[
            b"vault",
            vault.merchant.as_ref(),
            vault.mint.as_ref(),
            &[vault.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        // Transfer to merchant (if any amount)
        if merchant_amount > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault_ata.to_account_info(),
                to: ctx.accounts.merchant_ata.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            };

            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );

            token::transfer(cpi_ctx, merchant_amount)?;
        }

        // Transfer to referrer (if any amount and referrer exists)
        if referrer_amount > 0 {
            if let Some(referrer_ata) = &ctx.accounts.referrer_ata {
                let cpi_accounts = Transfer {
                    from: ctx.accounts.vault_ata.to_account_info(),
                    to: referrer_ata.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                };

                let cpi_ctx = CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi_accounts,
                    signer_seeds,
                );

                token::transfer(cpi_ctx, referrer_amount)?;
            }
        }

        // Transfer fee (if any amount)
        if fee_amount > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault_ata.to_account_info(),
                to: ctx.accounts.fee_ata.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            };

            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );

            token::transfer(cpi_ctx, fee_amount)?;
        }

        // Emit settlement event
        emit!(TokensSettled {
            vault: ctx.accounts.vault.key(),
            amount,
            merchant_amount,
            referrer_amount,
            fee_amount,
            referrer: ctx.accounts.referrer.as_ref().map(|r| r.key()),
        });

        Ok(())
    }
}

// Account Validation Structs

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub merchant: Signer<'info>,

    #[account(
        init,
        payer = merchant,
        space = 8 + 32 + 32 + 1, // discriminator + merchant + mint + bump
        seeds = [b"vault", merchant.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = merchant,
        associated_token::mint = mint,
        associated_token::authority = vault
    )]
    pub vault_ata: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        seeds = [b"vault", vault.merchant.as_ref(), vault.mint.as_ref()],
        bump = vault.bump,
        has_one = mint
    )]
    pub vault: Account<'info, Vault>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = depositor
    )]
    pub depositor_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault
    )]
    pub vault_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut)]
    pub merchant: Signer<'info>,

    #[account(
        seeds = [b"vault", vault.merchant.as_ref(), vault.mint.as_ref()],
        bump = vault.bump,
        has_one = merchant,
        has_one = mint
    )]
    pub vault: Account<'info, Vault>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault
    )]
    pub vault_ata: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = merchant,
        associated_token::mint = mint,
        associated_token::authority = merchant
    )]
    pub merchant_ata: Account<'info, TokenAccount>,

    /// CHECK: Optional referrer account
    pub referrer: Option<UncheckedAccount<'info>>,

    #[account(
        init,
        payer = merchant,
        associated_token::mint = mint,
        associated_token::authority = referrer
    )]
    pub referrer_ata: Option<Account<'info, TokenAccount>>,

    /// CHECK: Fee receiver - doesn't need to sign
    pub fee_receiver: UncheckedAccount<'info>,

    #[account(
        init,
        payer = merchant,
        associated_token::mint = mint,
        associated_token::authority = fee_receiver
    )]
    pub fee_ata: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

// State Accounts

#[account]
pub struct Vault {
    pub merchant: Pubkey,
    pub mint: Pubkey,
    pub bump: u8,
}

// Events

#[event]
pub struct VaultInitialized {
    pub merchant: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub vault_ata: Pubkey,
}

#[event]
pub struct TokensDeposited {
    pub vault: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
}

#[event]
pub struct TokensSettled {
    pub vault: Pubkey,
    pub amount: u64,
    pub merchant_amount: u64,
    pub referrer_amount: u64,
    pub fee_amount: u64,
    pub referrer: Option<Pubkey>,
}

// Errors

#[error_code]
pub enum VaultError {
    #[msg("Amount must be greater than zero")]
    AmountIsZero,
    
    #[msg("Invalid basis points: must be <= 10,000 and fee + referrer <= 10,000")]
    InvalidBasisPoints,
    
    #[msg("Insufficient vault balance for settlement")]
    InsufficientVaultBalance,
    
    #[msg("Invalid settlement calculation")]
    InvalidSettlement,
}