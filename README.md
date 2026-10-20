<p align="center">
  <a href="https://proofhouse.fun"><img src="docs/assets/banner.png" alt="Proof House. Chosen by a person. Stored on the chain. Sold by people and agents." width="100%"></a>
</p>

<p align="center">
  <a href="https://proofhouse.fun"><b>proofhouse.fun</b></a> &nbsp;·&nbsp;
  <a href="https://artifacts.proofhouse.fun">ARTIFACTS market</a> &nbsp;·&nbsp;
  <a href="https://github.com/mylesdaughtry/proof-house-contracts">Contracts</a> &nbsp;·&nbsp;
  <a href="#whats-here">What's here</a> &nbsp;·&nbsp;
  <a href="#check-the-renderer">Check the renderer</a> &nbsp;·&nbsp;
  <a href="#license">License</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/code-MIT-14161A?style=flat-square" alt="Code: MIT">
  <img src="https://img.shields.io/badge/art-all%20rights%20reserved-14161A?style=flat-square" alt="Art: all rights reserved">
  <img src="https://img.shields.io/badge/ARTIFACTS-256%20pieces-4B5BD6?style=flat-square" alt="ARTIFACTS: 256 pieces">
  <img src="https://img.shields.io/badge/chain-Ethereum%20mainnet-14161A?style=flat-square" alt="Ethereum mainnet">
</p>

# Proof House

A curator-run house for fully on-chain art, sold to people and to AI agents. Its first collection is **ARTIFACTS**: 256 generative colour-spectrum pieces (255 editions and THE SOURCE), encrypted so that only each piece's owner can view it.

This repository holds the reference material the build started from, and the code of the two live sites. It holds no production seeds or keys.

> **Live on Ethereum mainnet since October 2026.** The deployed contracts, their addresses and the current protocol
> are in [proof-house-contracts](https://github.com/mylesdaughtry/proof-house-contracts) (its `reference/` folder
> carries this repository's rules and renderer). This repository is the original reference the build started from;
> where the two differ, the contracts repository is current.

## What's here

| Path | What it is |
|---|---|
| `artifacts/RULES.md` | The generative constitution (R0 to R13). Normative: every implementation must follow it exactly. |
| `artifacts/reference/rules.js` | The reference renderer, written strictly from the rules. |
| `artifacts/reference/check-framed.js` | The acceptance test: rebuilds each piece in `framed/` from the rules and compares the files byte for byte. |
| `artifacts/reference/framed/` | 11 framed pieces: demo seeds 003 to 236 and THE SOURCE. The test targets. |
| `artifacts/reference/the-source.payload.b64` | THE SOURCE's on-chain metadata: base64 JSON whose image is `framed-MASTER.svg` byte for byte. Its revealed `tokenURI` is `data:application/json;base64,` plus this file. |
| `artifacts/PROTOCOL.md` | How ARTIFACTS works on Proof House: the contracts, keys, sale, claim, resale and reveal. |
| `artifacts/SEED-SECURITY-SPEC.md` | The original security spec. Where it differs from `PROTOCOL.md` (viewing keys, transfer), `PROTOCOL.md` wins. |
| `site/` | The Proof House site, as published at [proofhouse.fun](https://proofhouse.fun): the drop page, agents, review, submit and docs. The curator console is not public. |
| `artifacts-site/` | The ARTIFACTS site, as published at [artifacts.proofhouse.fun](https://artifacts.proofhouse.fun): the owner to owner market, the archive and the docs. |
| `design/` | The design concept images the site follows. |

## Check the renderer

```
cd artifacts
node reference/check-framed.js
```

It prints one line per piece and ends with `11 of 11 files rebuilt byte-for-byte from the rules`. Any other implementation, including the on-chain renderer, must pass the same check.

## Never in this repository

Production seeds, content keys, wrapped keys and decrypted renders. Those come from an offline ceremony and are never sent to the build network or any AI session.

## License

The code here (the two sites and the check scripts) is released under the [MIT license](LICENSE). ARTIFACTS by
Myles Daughtry (its rules, renderer, framed pieces and THE SOURCE's payload, everything under `artifacts/`), the
design images under `design/`, the Proof House logo and wordmark, and the images in `docs/assets/` are **all rights
reserved** and are not covered by the MIT license: see [`ART-LICENSE.md`](ART-LICENSE.md). If you own a piece, it is
yours to view, display, share or publish as you wish.
