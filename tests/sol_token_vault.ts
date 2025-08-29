import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolTokenVault } from "../target/types/sol_token_vault";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";

describe("Sol Token Vault", () => {
  // Configure the client to use the local cluster
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolTokenVault as Program<SolTokenVault>;

  // Test accounts
  let mint: anchor.web3.PublicKey;
  let merchant: anchor.web3.Keypair;
  let depositor: anchor.web3.Keypair;
  let referrer: anchor.web3.Keypair;
  let feeReceiver: anchor.web3.Keypair;
  let payer: anchor.web3.Keypair;

  // PDAs and ATAs
  let vaultPda: anchor.web3.PublicKey;
  let vaultBump: number;
  let vaultAta: anchor.web3.PublicKey;

  before(async () => {
    // Generate keypairs
    merchant = anchor.web3.Keypair.generate();
    depositor = anchor.web3.Keypair.generate();
    referrer = anchor.web3.Keypair.generate();
    feeReceiver = anchor.web3.Keypair.generate();
    payer = anchor.web3.Keypair.generate();

    // Airdrop SOL to all accounts
    const accounts = [merchant, depositor, referrer, feeReceiver, payer];
    for (const account of accounts) {
      const signature = await provider.connection.requestAirdrop(
        account.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(signature, "confirmed");
    }

    // Create a mint
    mint = await createMint(
      provider.connection,
      payer, // payer
      merchant.publicKey, // mint authority
      null, // freeze authority
      6 // decimals
    );

    console.log("Mint created:", mint.toString());

    // Find vault PDA
    [vaultPda, vaultBump] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        merchant.publicKey.toBuffer(),
        mint.toBuffer(),
      ],
      program.programId
    );

    // Calculate vault ATA
    vaultAta = getAssociatedTokenAddressSync(mint, vaultPda, true);

    console.log("Vault PDA:", vaultPda.toString());
    console.log("Vault ATA:", vaultAta.toString());
  });

  describe("Vault Initialization", () => {
    it("should initialize a vault successfully", async () => {
      const tx = await program.methods
        .initializeVault()
        .accounts({
          merchant: merchant.publicKey,
          vault: vaultPda,
          mint: mint,
          vaultAta: vaultAta,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([merchant])
        .rpc();

      console.log("Initialize vault transaction:", tx);

      // Verify vault state
      const vault = await program.account.vault.fetch(vaultPda);
      expect(vault.merchant.toString()).to.equal(merchant.publicKey.toString());
      expect(vault.mint.toString()).to.equal(mint.toString());
      expect(vault.bump).to.equal(vaultBump);

      // Verify vault ATA was created
      const vaultAtaInfo = await provider.connection.getAccountInfo(vaultAta);
      expect(vaultAtaInfo).to.not.be.null;
    });

    it("should fail to initialize vault with wrong signer", async () => {
      const wrongSigner = anchor.web3.Keypair.generate();
      
      // Airdrop SOL for transaction fees
      const sig = await provider.connection.requestAirdrop(
        wrongSigner.publicKey,
        anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig, "confirmed");

      // This should fail because vault PDA expects merchant as seed
      try {
        await program.methods
          .initializeVault()
          .accounts({
            merchant: wrongSigner.publicKey,
            vault: vaultPda, // This PDA was derived with merchant, not wrongSigner
            mint: mint,
            vaultAta: vaultAta,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .signers([wrongSigner])
          .rpc();
        
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error.message).to.include("seeds constraint was violated");
      }
    });
  });

  describe("Token Deposits", () => {
    let depositorAta: anchor.web3.PublicKey;

    before(async () => {
      // Create depositor's ATA and mint tokens
      const depositorAtaInfo = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        mint,
        depositor.publicKey
      );
      depositorAta = depositorAtaInfo.address;

      // Mint 1000 tokens to depositor
      await mintTo(
        provider.connection,
        payer,
        mint,
        depositorAta,
        merchant, // mint authority
        1000 * 10 ** 6 // 1000 tokens with 6 decimals
      );
    });

    it("should deposit tokens successfully", async () => {
      const depositAmount = 100 * 10 ** 6; // 100 tokens

      // Get initial balances
      const initialDepositorBalance = (
        await provider.connection.getTokenAccountBalance(depositorAta)
      ).value.uiAmount;
      const initialVaultBalance = (
        await provider.connection.getTokenAccountBalance(vaultAta)
      ).value.uiAmount;

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

      console.log("Deposit transaction:", tx);

      // Verify balances changed correctly
      const finalDepositorBalance = (
        await provider.connection.getTokenAccountBalance(depositorAta)
      ).value.uiAmount;
      const finalVaultBalance = (
        await provider.connection.getTokenAccountBalance(vaultAta)
      ).value.uiAmount;

      expect(finalDepositorBalance).to.equal(initialDepositorBalance! - 100);
      expect(finalVaultBalance).to.equal(initialVaultBalance! + 100);
    });

    it("should fail to deposit zero amount", async () => {
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

        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error.message).to.include("AmountIsZero");
      }
    });

    it("should fail to deposit more than balance", async () => {
      const excessiveAmount = new anchor.BN("999999999999999"); // Very large amount

      try {
        await program.methods
          .deposit(excessiveAmount)
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

        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error.message).to.include("insufficient");
      }
    });
  });

  describe("Token Settlement", () => {
    let merchantAta: anchor.web3.PublicKey;
    let referrerAta: anchor.web3.PublicKey;
    let feeReceiverAta: anchor.web3.PublicKey;

    before(async () => {
      // Calculate ATA addresses (they'll be created during settlement)
      merchantAta = getAssociatedTokenAddressSync(mint, merchant.publicKey);
      referrerAta = getAssociatedTokenAddressSync(mint, referrer.publicKey);
      feeReceiverAta = getAssociatedTokenAddressSync(mint, feeReceiver.publicKey);
    });

    it("should settle without referrer", async () => {
      const settlementAmount = 50 * 10 ** 6; // 50 tokens
      const feeBps = 500; // 5%
      const referrerBps = 0; // No referrer

      // Calculate expected amounts
      const expectedFee = (settlementAmount * feeBps) / 10000;
      const expectedMerchantAmount = settlementAmount - expectedFee;

      // Get initial vault balance
      const initialVaultBalance = (
        await provider.connection.getTokenAccountBalance(vaultAta)
      ).value.amount;

      const tx = await program.methods
        .settle(
          new anchor.BN(settlementAmount),
          feeBps,
          referrerBps
        )
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
          payer: payer.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([merchant, payer])
        .rpc();

      console.log("Settlement transaction:", tx);

      // Verify balances
      const finalVaultBalance = (
        await provider.connection.getTokenAccountBalance(vaultAta)
      ).value.amount;
      const merchantBalance = (
        await provider.connection.getTokenAccountBalance(merchantAta)
      ).value.amount;
      const feeBalance = (
        await provider.connection.getTokenAccountBalance(feeReceiverAta)
      ).value.amount;

      expect(parseInt(finalVaultBalance)).to.equal(
        parseInt(initialVaultBalance) - settlementAmount
      );
      expect(parseInt(merchantBalance)).to.equal(expectedMerchantAmount);
      expect(parseInt(feeBalance)).to.equal(expectedFee);
    });

    it("should settle with referrer", async () => {
      const settlementAmount = 30 * 10 ** 6; // 30 tokens
      const feeBps = 300; // 3%
      const referrerBps = 200; // 2%

      // Calculate expected amounts
      const expectedFee = (settlementAmount * feeBps) / 10000;
      const expectedReferrerAmount = (settlementAmount * referrerBps) / 10000;
      const expectedMerchantAmount = settlementAmount - expectedFee - expectedReferrerAmount;

      // Get initial balances
      const initialVaultBalance = parseInt(
        (await provider.connection.getTokenAccountBalance(vaultAta)).value.amount
      );
      const initialMerchantBalance = parseInt(
        (await provider.connection.getTokenAccountBalance(merchantAta)).value.amount
      );
      const initialFeeBalance = parseInt(
        (await provider.connection.getTokenAccountBalance(feeReceiverAta)).value.amount
      );

      const tx = await program.methods
        .settle(
          new anchor.BN(settlementAmount),
          feeBps,
          referrerBps
        )
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
          payer: payer.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([merchant, payer])
        .rpc();

      console.log("Settlement with referrer transaction:", tx);

      // Verify balances
      const finalVaultBalance = parseInt(
        (await provider.connection.getTokenAccountBalance(vaultAta)).value.amount
      );
      const finalMerchantBalance = parseInt(
        (await provider.connection.getTokenAccountBalance(merchantAta)).value.amount
      );
      const finalReferrerBalance = parseInt(
        (await provider.connection.getTokenAccountBalance(referrerAta)).value.amount
      );
      const finalFeeBalance = parseInt(
        (await provider.connection.getTokenAccountBalance(feeReceiverAta)).value.amount
      );

      expect(finalVaultBalance).to.equal(initialVaultBalance - settlementAmount);
      expect(finalMerchantBalance).to.equal(initialMerchantBalance + expectedMerchantAmount);
      expect(finalReferrerBalance).to.equal(expectedReferrerAmount);
      expect(finalFeeBalance).to.equal(initialFeeBalance + expectedFee);
    });

    it("should fail settlement with invalid basis points", async () => {
      try {
        await program.methods
          .settle(
            new anchor.BN(10 * 10 ** 6),
            5000, // 50% fee
            6000  // 60% referrer - total > 100%
          )
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
            payer: payer.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .signers([merchant, payer])
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error.message).to.include("InvalidBasisPoints");
      }
    });

    it("should fail settlement by non-merchant", async () => {
      const wrongSigner = anchor.web3.Keypair.generate();
      
      // Airdrop SOL for transaction fees
      const sig = await provider.connection.requestAirdrop(
        wrongSigner.publicKey,
        anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig, "confirmed");

      try {
        await program.methods
          .settle(
            new anchor.BN(10 * 10 ** 6),
            500,
            0
          )
          .accounts({
            merchant: wrongSigner.publicKey, // Wrong merchant
            vault: vaultPda,
            mint: mint,
            vaultAta: vaultAta,
            merchantAta: merchantAta,
            referrer: null,
            referrerAta: null,
            feeReceiver: feeReceiver.publicKey,
            feeAta: feeReceiverAta,
            payer: payer.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .signers([wrongSigner, payer])
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error.message).to.include("has_one");
      }
    });

    it("should fail settlement with insufficient vault balance", async () => {
      const excessiveAmount = new anchor.BN("999999999999999");

      try {
        await program.methods
          .settle(excessiveAmount, 500, 0)
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
            payer: payer.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .signers([merchant, payer])
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error.message).to.include("InsufficientVaultBalance");
      }
    });

    it("should fail settlement with referrer bps but no referrer", async () => {
      try {
        await program.methods
          .settle(
            new anchor.BN(10 * 10 ** 6),
            500,
            200 // referrer bps but no referrer provided
          )
          .accounts({
            merchant: merchant.publicKey,
            vault: vaultPda,
            mint: mint,
            vaultAta: vaultAta,
            merchantAta: merchantAta,
            referrer: null, // No referrer
            referrerAta: null,
            feeReceiver: feeReceiver.publicKey,
            feeAta: feeReceiverAta,
            payer: payer.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .signers([merchant, payer])
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error.message).to.include("InvalidBasisPoints");
      }
    });
  });

  describe("Edge Cases and Security", () => {
    it("should handle zero-amount settlements gracefully", async () => {
      try {
        await program.methods
          .settle(new anchor.BN(0), 500, 0)
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
            payer: payer.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .signers([merchant, payer])
          .rpc();

        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error.message).to.include("AmountIsZero");
      }
    });

    it("should verify final vault state", async () => {
      const vault = await program.account.vault.fetch(vaultPda);
      expect(vault.merchant.toString()).to.equal(merchant.publicKey.toString());
      expect(vault.mint.toString()).to.equal(mint.toString());
      expect(vault.bump).to.equal(vaultBump);

      // Check that vault still has some tokens for additional tests
      const vaultBalance = await provider.connection.getTokenAccountBalance(vaultAta);
      console.log("Final vault balance:", vaultBalance.value.uiAmount);
      expect(parseInt(vaultBalance.value.amount)).to.be.greaterThan(0);
    });
  });
});