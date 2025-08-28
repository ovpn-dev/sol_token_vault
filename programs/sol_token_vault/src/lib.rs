use anchor_lang::prelude::*;

declare_id!("DjZLtdJ4Ccz49koPEAuDWAsenAoXjws2nosxHRzBADUJ");

#[program]
pub mod sol_token_vault {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
