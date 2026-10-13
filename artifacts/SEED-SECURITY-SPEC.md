# ARTIFACTS — Seed Security Specification

**Status:** Buildable spec. Pair with the security audit. Must be reviewed by a
firm that audits *both* Solidity and applied cryptography before mainnet.

---

## 0. The core principle

The render algorithm is **public** (open-source, and client-side code is
inspectable regardless). Therefore the **seed is the entire secret**. Every
control in this document exists to protect the seed from *everyone who is not
the current owner*. Protecting it from the owner themselves is impossible and
not a goal — the owner is trusted by definition.

**Threat model — who we lock out:**
- Scrapers, marketplaces, the public, blockchain queries
- Node operators / any third-party network (eliminated by self-custody)
- The artist (minimized via generation ceremony; not cryptographically zero)
- A compromised/tampered viewer (eliminated by content-hashed open-source build)
- Replay attackers (eliminated by nonce + expiry on the viewing challenge)

**Irreducible floor — what we cannot prevent (must be disclosed):**
- The current owner can record/exfiltrate their own decrypted piece.
- A past owner who saved their seed keeps it forever and can keep rendering
  (including the block-evolving version, since block data is public).
- Viewability depends forever on the renderer (and chain access if the piece
  evolves per block) existing. Data is permanent; *seeing* it is not.

---

## 1. Seed generation (most critical stage)

**Requirements**
- Seed = **256-bit**, from a **CSPRNG** (e.g. OS `getrandom`/`crypto.randomBytes`).
- **Never derivable** from any public input: not tokenId, block hash, address,
  timestamp, or sequence index. A guessable/derivable seed defeats all
  encryption because the algorithm is public. (This is audit Finding #1.)
- Seed plaintext **never** appears on-chain, in logs, in analytics, or in any
  derivation using public data.

**Ceremony (recommended)**
1. Generate all 256 seeds **offline / air-gapped**, CSPRNG.
2. Immediately encrypt each seed to its destination (see §2).
3. **Wipe** plaintext seeds (secure delete; wipe RAM/swap if feasible).
4. Produce a signed **attestation** of the process (what was generated,
   that plaintext was destroyed, hashes of ciphertext blobs).

**Residual trust**
The artist sees plaintext at generation. The ceremony reduces this to "knew
momentarily, destroyed it" — *trust-based, not cryptographic*. To eliminate
even artist knowledge, generate inside an **MPC or secure enclave (TEE)** so
plaintext never exists in the clear to any single party. Expensive/complex;
optional. Disclose whichever path is chosen.

---

## 2. Encryption at rest (the airtight part)

**Hybrid encryption per piece:**
- Random **content key K** = 256-bit, per piece.
- `ciphertext_seed = AES-256-GCM(key=K, plaintext=seed||params, aad=pieceId)`
  - GCM provides authentication → tampering is detectable.
  - `aad` (additional authenticated data) binds the ciphertext to its piece id.
- **K is wrapped to the owner** (see §3). Only the wrapped-K blob is per-owner.

**On-chain, only ciphertext is stored:**
- `ciphertext_seed` (fixed; never changes)
- `wrapped_K` (per-owner; changes only on transfer via re-key, §4)
- Public, safe to be public, useless without the owner's key.

> Store the *recipe* (seed+params), never pixels. Fidelity is render-time and
> free; this keeps each piece well under the 4KB on-chain budget.

---

## 3. Owner key & viewing (self-custodial, browser-practical)

Private keys must **never** enter the dapp. Direct ECIES decryption would
require the private key client-side — disallowed. Use **signature-derived
key unwrap** instead:

**Viewing flow**
1. Dapp builds a **domain-separated challenge** containing: a fresh **nonce**,
   a **short expiry**, the `pieceId`, and a fixed purpose string.
2. Owner **signs** the challenge in their wallet (private key stays in wallet).
3. Dapp derives the unwrap key: `uk = HKDF(signature, salt=pieceId, info="artifacts-unwrap")`.
4. `K = unwrap(uk, wrapped_K)` → `seed = AES-256-GCM-decrypt(K, ciphertext_seed)`.
5. Render. Then **discard** seed and K from memory.

**Protections**
- The **signature is secret key material** — never log, cache, transmit, or
  persist it.
- Nonce + expiry → a captured signature **cannot be replayed** later to
  re-derive the key. Authorization is per-session, short-lived.
- Seed/K live in memory **only for the render**; never written to
  localStorage, IndexedDB, cookies, or any storage. All client-side; nothing
  over the network.

**Wallet constraint**
- Requires **deterministic** signatures (same message → same signature).
  Standard EOAs comply. **Smart-contract wallets (Safe, ERC-4337)** do **not**
  cleanly support this → either restrict ownership to EOAs or build
  wallet-type-specific handling. Disclose.

---

## 4. Transfer — re-wrap, never re-expose

On sale, the **seed plaintext is never re-exposed**. Only **K** is re-wrapped
to the new owner; `ciphertext_seed` stays put.

**Preferred: proxy re-encryption (PRE)**
- Seller generates a one-way **re-key** `rk(seller→buyer)` from their key + the
  buyer's public key.
- A third party / contract transforms `wrapped_K_seller` → `wrapped_K_buyer`
  **without ever seeing K or the seed in plaintext.**
- Heavier crypto (pairing-based); libraries less battle-tested; verify on-chain
  feasibility (BN254 precompiles).

**Simpler: seller-cooperative re-wrap**
- Seller's client unwraps K (it already had access as owner), re-wraps K to the
  buyer's key, posts `wrapped_K_buyer`.
- K is briefly in the **seller's** client memory — **not new exposure to them**
  (they owned it). Must be in-memory, client-side, never transmitted.

**Payment safety (orthogonal):**
- Use **escrow** + a timeout/confirmation or optimistic challenge window so the
  buyer isn't griefed (pays, never receives a valid wrapper) and the seller
  isn't griefed (delivers, isn't paid). Escrow protects *payment*, not the
  seed; seed protection is the no-plaintext-re-exposure rule above.

**Buyer's public key:** recoverable from the buyer's claim/transfer transaction
signature (secp256k1 pubkey recovery), or provided in a buyer-signs handshake.

---

## 5. Viewer trust (as important as the encryption)

A malicious viewer can exfiltrate the seed at render time, defeating all of the
above. Therefore the viewer **must** be:
- **Open-source** and auditable.
- **Content-hash-pinned** on **Arweave/IPFS** (immutable; owners verify the hash
  of the app they run).
- A **reproducible build** (source → hash is verifiable).
- Free of any code path that logs, transmits, or persists the seed, K, or the
  deriving signature.

---

## 6. Algorithm: public, not secret

Keep the render algorithm **public**. Hiding it is only obscurity (client code
is reverse-engineerable) and it breaks verifiability/permanence. Security comes
from the seed's **256-bit entropy** (brute force over 2^256 is infeasible), not
from hiding the algorithm.

---

## 7. Crypto stack summary

| Item | Choice |
|---|---|
| Seed | 256-bit, CSPRNG, off-chain, non-derivable |
| Symmetric cipher | AES-256-GCM (authenticated), `aad = pieceId` |
| Content key K | 256-bit random, per piece |
| Key derivation | HKDF over wallet signature (domain-separated) |
| Owner auth | Deterministic wallet signature; nonce + short expiry |
| Transfer | Re-wrap K only (PRE preferred; else cooperative re-wrap) |
| At rest | On-chain: `ciphertext_seed` + per-owner `wrapped_K` only |
| Viewer | Open-source, content-hashed on Arweave/IPFS, reproducible |
| Network | None (self-custodial) — no node operators to trust |

---

## 8. What is and isn't solved

**Solved (with correct implementation + audit):** scrapers/public/marketplaces,
node-operator collusion, replay, viewer supply-chain, tamper detection,
at-rest confidentiality.

**Minimized, not zero:** artist knowledge at generation (ceremony; or MPC/TEE
to eliminate).

**Unsolvable (disclose):** current owner leaking their own piece; past owners
retaining a saved seed; dependence on the renderer/chain access for viewing.

> Do not market "only one person can ever see it." Market: *encrypted,
> owner-gated, invisible to the public, and trusted to its holder.*
