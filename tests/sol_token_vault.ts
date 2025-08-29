import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolTokenVault } from "../target/types/sol_token_vault";
import { 
  PublicKey, 
  Keypair, 
  SystemProgram,
  LAMPORTS_PER_SOL 
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddress,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";

describe("sol_token_vault", () => {
  // Configure the client to use the local cluster
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolTokenVault as Program<SolTokenVault>;
  
  // Test accounts
  let mint: PublicKey;
  let merchant: Keypair;
  let depositor: Keypair;
  let referrer: Keypair;
  let feeReceiver: Keypair;
  
  // Token accounts
  let depositorAta: PublicKey;
  
  // Vault PDA
  let vaultPda: PublicKey;
  let vaultBump: number;
  let vaultAta: PublicKey;

  before(async () => {
    // Create test keypairs
    merchant = Keypair.generate();
    depositor = Keypair.generate();
    referrer = Keypair.generate();
    feeReceiver = Keypair.generate();

    // Airdrop SOL to test accounts
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(merchant.publicKey, 2 * LAMPORTS_PER_SOL)
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(depositor.publicKey, 2 * LAMPORTS_PER_SOL)
    );

    // Create mint
    mint = await createMint(
      provider.connection,
      merchant,
      merchant.publicKey,
      null,
      6 // 6 decimals
    );

    // Create depositor's token account and mint tokens
    depositorAta = await createAssociatedTokenAccount(
      provider.connection,
      depositor,
      mint,
      depositor.publicKey
    );

    // Mint 1000 tokens to depositor
    await mintTo(
      provider.connection,
      merchant,
      mint,
      depositorAta,
      merchant,
      1000 * Math.pow(10, 6) // 1000 tokens with 6 decimals
    );

    // Calculate vault PDA
    [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        merchant.publicKey.toBuffer(),
        mint.toBuffer(),
      ],
      program.programId
    );

    // Calculate vault ATA
    vaultAta = await getAssociatedTokenAddress(mint, vaultPda, true);
  });

  describe("Initialize Vault", () => {
    it("Successfully initializes a vault", async () => {
      const tx = await program.methods
        .initializeVault()
        .accounts({
          merchant: merchant.publicKey,
          vault: vaultPda,
          mint: mint,
          vaultAta: vaultAta,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([merchant])
        .rpc();

      console.log("Initialize vault tx:", tx);

      // Verify vault account was created
      const vaultAccount = await program.account.vault.fetch(vaultPda);
      assert.equal(vaultAccount.merchant.toString(), merchant.publicKey.toString());
      assert.equal(vaultAccount.mint.toString(), mint.toString());
      assert.equal(vaultAccount.bump, vaultBump);

      // Verify vault ATA was created
      const vaultAtaAccount = await getAccount(provider.connection, vaultAta);
      assert.equal(vaultAtaAccount.mint.toString(), mint.toString());
      assert.equal(vaultAtaAccount.owner.toString(), vaultPda.toString());
      assert.equal(vaultAtaAccount.amount.toString(), "0");
    });

    it("Fails to initialize vault with same merchant and mint twice", async () => {
      try {
        await program.methods
          .initializeVault()
          .accounts({
            merchant: merchant.publicKey,
            vault: vaultPda,
            mint: mint,
            vaultAta: vaultAta,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .signers([merchant])
          .rpc();
        
        assert.fail("Should have failed - vault already exists");
      } catch (err) {
        assert.include(err.toString(), "already in use");
      }
    });
  });

  describe("Deposit", () => {
    it("Successfully deposits tokens to vault", async () => {
      const depositAmount = 100 * Math.pow(10, 6); // 100 tokens
      
      const tx = await program.methods
        .deposit(new anchor.BN(depositAmount))
        .accounts({
          depositor: depositor.publicKey,
          vault: vaultPda,
          mint: mint,
          depositorAta: depositorAta,
          vaultAta: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([depositor])
        .rpc();

      console.log("Deposit tx:", tx);

      // Verify vault balance increased
      const vaultAtaAccount = await getAccount(provider.connection, vaultAta);
      assert.equal(vaultAtaAccount.amount.toString(), depositAmount.toString());

      // Verify depositor balance decreased
      const depositorAtaAccount = await getAccount(provider.connection, depositorAta);
      const expectedBalance = (1000 * Math.pow(10, 6)) - depositAmount;
      assert.equal(depositorAtaAccount.amount.toString(), expectedBalance.toString());
    });

    it("Fails to deposit zero amount", async () => {
      try {
        await program.methods
          .deposit(new anchor.BN(0))
          .accounts({
            depositor: depositor.publicKey,
            vault: vaultPda,
            mint: mint,
            depositorAta: depositorAta,
            vaultAta: vaultAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([depositor])
          .rpc();
        
        assert.fail("Should have failed - zero amount");
      } catch (err) {
        assert.include(err.toString(), "AmountIsZero");
      }
    });

    it("Makes additional deposit to increase vault balance", async () => {
      const additionalDeposit = 50 * Math.pow(10, 6); // 50 tokens
      
      await program.methods
        .deposit(new anchor.BN(additionalDeposit))
        .accounts({
          depositor: depositor.publicKey,
          vault: vaultPda,
          mint: mint,
          depositorAta: depositorAta,
          vaultAta: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([depositor])
        .rpc();

      // Verify total vault balance
      const vaultAtaAccount = await getAccount(provider.connection, vaultAta);
      const expectedTotal = (100 + 50) * Math.pow(10, 6);
      assert.equal(vaultAtaAccount.amount.toString(), expectedTotal.toString());
    });
  });

  describe("Settlement", () => {
    let merchantAta: PublicKey;
    let referrerAta: PublicKey;
    let feeReceiverAta: PublicKey;

    beforeEach(async () => {
      // Calculate ATA addresses
      merchantAta = await getAssociatedTokenAddress(mint, merchant.publicKey);
      referrerAta = await getAssociatedTokenAddress(mint, referrer.publicKey);
      feeReceiverAta = await getAssociatedTokenAddress(mint, feeReceiver.publicKey);
    });

    it("Successfully settles tokens without referrer", async () => {
      const settleAmount = 60 * Math.pow(10, 6); // 60 tokens
      const feeBps = 500; // 5%
      const referrerBps = 0; // No referrer
      
      const tx = await program.methods
        .settle(new anchor.BN(settleAmount), feeBps, referrerBps)
        .accounts({
          merchant: merchant.publicKey,
          vault: vaultPda,
          mint: mint,
          vaultAta: vaultAta,
          merchantAta: merchantAta,
          referrer: null,
          referrerAta: null,
          feeReceiver: feeReceiver.publicKey,
          feeAta: feeReceiverAta,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([merchant])
        .rpc();

      console.log("Settlement tx (no referrer):", tx);

      // Calculate expected amounts
      const feeAmount = Math.floor(settleAmount * feeBps / 10000);
      const merchantAmount = settleAmount - feeAmount;

      // Verify balances
      const merchantAtaAccount = await getAccount(provider.connection, merchantAta);
      const feeReceiverAtaAccount = await getAccount(provider.connection, feeReceiverAta);
      const vaultAtaAccount = await getAccount(provider.connection, vaultAta);

      assert.equal(merchantAtaAccount.amount.toString(), merchantAmount.toString());
      assert.equal(feeReceiverAtaAccount.amount.toString(), feeAmount.toString());
      
      // Vault should have remaining balance
      const expectedVaultBalance = (150 * Math.pow(10, 6)) - settleAmount;
      assert.equal(vaultAtaAccount.amount.toString(), expectedVaultBalance.toString());
    });

    it("Successfully settles tokens with referrer", async () => {
      const settleAmount = 30 * Math.pow(10, 6); // 30 tokens
      const feeBps = 300; // 3%
      const referrerBps = 200; // 2%
      
      const tx = await program.methods
        .settle(new anchor.BN(settleAmount), feeBps, referrerBps)
        .accounts({
          merchant: merchant.publicKey,
          vault: vaultPda,
          mint: mint,
          vaultAta: vaultAta,
          merchantAta: merchantAta,
          referrer: referrer.publicKey,
          referrerAta: referrerAta,
          feeReceiver: feeReceiver.publicKey,
          feeAta: feeReceiverAta,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([merchant])
        .rpc();

      console.log("Settlement tx (with referrer):", tx);

      // Calculate expected amounts
      const feeAmount = Math.floor(settleAmount * feeBps / 10000);
      const referrerAmount = Math.floor(settleAmount * referrerBps / 10000);
      const merchantAmount = settleAmount - feeAmount - referrerAmount;

      // Verify balances
      const merchantAtaAccount = await getAccount(provider.connection, merchantAta);
      const referrerAtaAccount = await getAccount(provider.connection, referrerAta);
      const feeReceiverAtaAccount = await getAccount(provider.connection, feeReceiverAta);

      // Note: These are cumulative balances from previous test
      const previousMerchantBalance = 57 * Math.pow(10, 6); // From previous test
      const previousFeeBalance = 3 * Math.pow(10, 6); // From previous test

      assert.equal(
        merchantAtaAccount.amount.toString(), 
        (previousMerchantBalance + merchantAmount).toString()
      );
      assert.equal(referrerAtaAccount.amount.toString(), referrerAmount.toString());
      assert.equal(
        feeReceiverAtaAccount.amount.toString(), 
        (previousFeeBalance + feeAmount).toString()
      );
    });

    it("Fails settlement with invalid basis points", async () => {
      const settleAmount = 10 * Math.pow(10, 6);
      const feeBps = 6000; // 60%
      const referrerBps = 5000; // 50% - Total > 100%
      
      try {
        await program.methods
          .settle(new anchor.BN(settleAmount), feeBps, referrerBps)
          .accounts({
            merchant: merchant.publicKey,
            vault: vaultPda,
            mint: mint,
            vaultAta: vaultAta,
            merchantAta: merchantAta,
            referrer: referrer.publicKey,
            referrerAta: referrerAta,
            feeReceiver: feeReceiver.publicKey,
            feeAta: feeReceiverAta,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .signers([merchant])
          .rpc();
        
        assert.fail("Should have failed - invalid basis points");
      } catch (err) {
        assert.include(err.toString(), "InvalidBasisPoints");
      }
    });

    it("Fails settlement with wrong signer", async () => {
      const settleAmount = 10 * Math.pow(10, 6);
      const feeBps = 100;
      const referrerBps = 0;
      
      try {
        await program.methods
          .settle(new anchor.BN(settleAmount), feeBps, referrerBps)
          .accounts({
            merchant: depositor.publicKey, // Wrong signer!
            vault: vaultPda,
            mint: mint,
            vaultAta: vaultAta,
            merchantAta: merchantAta,
            referrer: null,
            referrerAta: null,
            feeReceiver: feeReceiver.publicKey,
            feeAta: feeReceiverAta,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .signers([depositor]) // Wrong signer!
          .rpc();
        
        assert.fail("Should have failed - wrong signer");
      } catch (err) {
        assert.include(err.toString(), "ConstraintHasOne");
      }
    });

    it("Fails settlement with insufficient vault balance", async () => {
      const settleAmount = 1000 * Math.pow(10, 6); // More than vault balance
      const feeBps = 100;
      const referrerBps = 0;
      
      try {
        await program.methods
          .settle(new anchor.BN(settleAmount), feeBps, referrerBps)
          .accounts({
            merchant: merchant.publicKey,
            vault: vaultPda,
            mint: mint,
            vaultAta: vaultAta,
            merchantAta: merchantAta,
            referrer: null,
            referrerAta: null,
            feeReceiver: feeReceiver.publicKey,
            feeAta: feeReceiverAta,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .signers([merchant])
          .rpc();
        
        assert.fail("Should have failed - insufficient balance");
      } catch (err) {
        assert.include(err.toString(), "InsufficientVaultBalance");
      }
    });
  });

  describe("PDA and CPI Validation", () => {
    it("Fails with wrong PDA seeds", async () => {
      const wrongMerchant = Keypair.generate();
      
      // Calculate wrong vault PDA
      const [wrongVaultPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vault"),
          wrongMerchant.publicKey.toBuffer(), // Wrong merchant
          mint.toBuffer(),
        ],
        program.programId
      );

      try {
        await program.methods
          .deposit(new anchor.BN(10 * Math.pow(10, 6)))
          .accounts({
            depositor: depositor.publicKey,
            vault: wrongVaultPda, // Wrong PDA
            mint: mint,
            depositorAta: depositorAta,
            vaultAta: vaultAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([depositor])
          .rpc();
        
        assert.fail("Should have failed - wrong PDA");
      } catch (err) {
        assert.include(err.toString(), "AccountNotFound");
      }
    });

    it("Validates CPI transfers work correctly", async () => {
      // Get initial balances
      const initialDepositorBalance = await getAccount(provider.connection, depositorAta);
      const initialVaultBalance = await getAccount(provider.connection, vaultAta);
      
      const depositAmount = 25 * Math.pow(10, 6); // 25 tokens
      
      // Perform deposit (CPI to SPL Token Program)
      await program.methods
        .deposit(new anchor.BN(depositAmount))
        .accounts({
          depositor: depositor.publicKey,
          vault: vaultPda,
          mint: mint,
          depositorAta: depositorAta,
          vaultAta: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([depositor])
        .rpc();

      // Verify CPI worked correctly
      const finalDepositorBalance = await getAccount(provider.connection, depositorAta);
      const finalVaultBalance = await getAccount(provider.connection, vaultAta);

      const depositorDecrease = Number(initialDepositorBalance.amount) - Number(finalDepositorBalance.amount);
      const vaultIncrease = Number(finalVaultBalance.amount) - Number(initialVaultBalance.amount);

      assert.equal(depositorDecrease, depositAmount);
      assert.equal(vaultIncrease, depositAmount);
      assert.equal(depositorDecrease, vaultIncrease);
    });
  });

  describe("Complete Integration Test", () => {
    it("End-to-end flow: deposit → settle with all parties", async () => {
      // Get current vault balance
      const currentVault = await getAccount(provider.connection, vaultAta);
      const availableBalance = Number(currentVault.amount);
      
      // Settle remaining balance with all parties
      const settleAmount = availableBalance;
      const feeBps = 1000; // 10%
      const referrerBps = 500; // 5%
      
      // Get initial balances
      const initialMerchant = await getAccount(provider.connection, merchantAta);
      const initialReferrer = await getAccount(provider.connection, referrerAta);
      const initialFeeReceiver = await getAccount(provider.connection, feeReceiverAta);
      
      const tx = await program.methods
        .settle(new anchor.BN(settleAmount), feeBps, referrerBps)
        .accounts({
          merchant: merchant.publicKey,
          vault: vaultPda,
          mint: mint,
          vaultAta: vaultAta,
          merchantAta: merchantAta,
          referrer: referrer.publicKey,
          referrerAta: referrerAta,
          feeReceiver: feeReceiver.publicKey,
          feeAta: feeReceiverAta,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([merchant])
        .rpc();

      console.log("Final settlement tx:", tx);

      // Calculate expected distributions
      const expectedFeeAmount = Math.floor(settleAmount * feeBps / 10000);
      const expectedReferrerAmount = Math.floor(settleAmount * referrerBps / 10000);
      const expectedMerchantAmount = settleAmount - expectedFeeAmount - expectedReferrerAmount;

      // Verify final balances
      const finalMerchant = await getAccount(provider.connection, merchantAta);
      const finalReferrer = await getAccount(provider.connection, referrerAta);
      const finalFeeReceiver = await getAccount(provider.connection, feeReceiverAta);
      const finalVault = await getAccount(provider.connection, vaultAta);

      // Check increases
      const merchantIncrease = Number(finalMerchant.amount) - Number(initialMerchant.amount);
      const referrerIncrease = Number(finalReferrer.amount) - Number(initialReferrer.amount);
      const feeIncrease = Number(finalFeeReceiver.amount) - Number(initialFeeReceiver.amount);

      assert.equal(merchantIncrease, expectedMerchantAmount);
      assert.equal(referrerIncrease, expectedReferrerAmount);
      assert.equal(feeIncrease, expectedFeeAmount);
      
      // Vault should be empty or nearly empty
      assert.equal(Number(finalVault.amount), 0);

      // Verify total conservation
      const totalDistributed = merchantIncrease + referrerIncrease + feeIncrease;
      assert.equal(totalDistributed, settleAmount);
      
      console.log("Settlement breakdown:");
      console.log(`- Total settled: ${settleAmount / Math.pow(10, 6)} tokens`);
      console.log(`- Merchant (${100 - feeBps/100 - referrerBps/100}%): ${merchantIncrease / Math.pow(10, 6)} tokens`);
      console.log(`- Referrer (${referrerBps/100}%): ${referrerIncrease / Math.pow(10, 6)} tokens`);
      console.log(`- Fee (${feeBps/100}%): ${feeIncrease / Math.pow(10, 6)} tokens`);
    });
  });

  describe("Edge Cases", () => {
    it("Handles settlement with referrer but no referrer amount", async () => {
      // First make another deposit
      const depositAmount = 100 * Math.pow(10, 6);
      await program.methods
        .deposit(new anchor.BN(depositAmount))
        .accounts({
          depositor: depositor.publicKey,
          vault: vaultPda,
          mint: mint,
          depositorAta: depositorAta,
          vaultAta: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([depositor])
        .rpc();

      // Settle with referrer present but 0 referrer_bps
      const tx = await program.methods
        .settle(new anchor.BN(depositAmount), 500, 0) // 5% fee, 0% referrer
        .accounts({
          merchant: merchant.publicKey,
          vault: vaultPda,
          mint: mint,
          vaultAta: vaultAta,
          merchantAta: merchantAta,
          referrer: referrer.publicKey,
          referrerAta: referrerAta,
          feeReceiver: feeReceiver.publicKey,
          feeAta: feeReceiverAta,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([merchant])
        .rpc();

      console.log("Settlement with 0% referrer tx:", tx);
      // This should work - referrer gets nothing but no error
    });

    it("Fails when referrer_bps > 0 but no referrer provided", async () => {
      // First make another deposit
      const depositAmount = 50 * Math.pow(10, 6);
      await program.methods
        .deposit(new anchor.BN(depositAmount))
        .accounts({
          depositor: depositor.publicKey,
          vault: vaultPda,
          mint: mint,
          depositorAta: depositorAta,
          vaultAta: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([depositor])
        .rpc();

      try {
        await program.methods
          .settle(new anchor.BN(depositAmount), 100, 200) // 2% referrer but no referrer account
          .accounts({
            merchant: merchant.publicKey,
            vault: vaultPda,
            mint: mint,
            vaultAta: vaultAta,
            merchantAta: merchantAta,
            referrer: null, // No referrer
            referrerAta: null, // No referrer ATA
            feeReceiver: feeReceiver.publicKey,
            feeAta: feeReceiverAta,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .signers([merchant])
          .rpc();
        
        assert.fail("Should have failed - referrer_bps > 0 but no referrer");
      } catch (err) {
        assert.include(err.toString(), "InvalidBasisPoints");
      }
    });
  });
});