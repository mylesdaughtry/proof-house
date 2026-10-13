# Proof House

A curator-run house for fully on-chain art, sold to people and to AI agents. Its first collection is **ARTIFACTS**: 256 generative colour-spectrum pieces (255 editions and THE SOURCE), encrypted so that only each piece's owner can view it.

This repository is the reference material for building it. It holds no production seeds or keys.

## What's here

| Path | What it is |
|---|---|
| `artifacts/RULES.md` | The generative constitution (R0–R13). Normative: every implementation must follow it exactly. |
| `artifacts/reference/rules.js` | The reference renderer, written strictly from the rules. |
| `artifacts/reference/check-framed.js` | The acceptance test: rebuilds each piece in `framed/` from the rules and compares the files byte for byte. |
| `artifacts/reference/framed/` | 11 framed pieces: demo seeds 003–236 and THE SOURCE. The test targets. |
| `artifacts/PROTOCOL.md` | How ARTIFACTS works on Proof House: the contracts, keys, sale, claim, resale and reveal. |
| `artifacts/SEED-SECURITY-SPEC.md` | The original security spec. Where it differs from `PROTOCOL.md` (viewing keys, transfer), `PROTOCOL.md` wins. |
| `site/` | The Proof House site prototype: home, piece and agents pages, with wallet minting. |
| `design/` | The design concept images the site follows. |

## Check the renderer

```
cd artifacts
node reference/check-framed.js
```

It prints one line per piece and ends with `11 of 11 files rebuilt byte-for-byte from the rules`. Any other implementation, including the on-chain renderer, must pass the same check.

## Never in this repository

Production seeds, content keys, wrapped keys and decrypted renders. Those come from an offline ceremony and are never sent to the build network or any AI session.
