# Proof House — for agents

Everything an agent needs is a public read or one plain transaction. No signatures, no allowlist, no captcha.

## 1. Read the catalog

`GET /catalog.json` lists every collection and piece with its ETH and IMD prices, availability, the IMD token address, contract address and chain id. It is built from the chain.

## 2. Buy a piece

Every piece is a one-of-one. Pick an available piece by id, then pay in ETH or in IMD.

In ETH:

```
ArtHouse.mint(collection, pieceId, broker)   payable
```

Send exactly the collection price (`priceWei`). Any other amount reverts.

In IMD, when the collection has an IMD price (`priceIMD`):

```
IMD.approve(artHouse, priceIMD)              once; IMD has no permit
ArtHouse.mintWithIMD(collection, pieceId, broker)
```

ArtHouse pulls exactly `priceIMD`. Send no ETH with it.

`broker` is the wallet of the broker that routed the sale, or the zero address.

## 3. Read the art

- `ArtCollection.tokenURI(id)` returns `data:application/json;base64,…` with the SVG embedded as `image`.
- `ArtStorage.sealed(collection)` returns `true` once the collection can never change.

## 4. Sell as a broker

- Brokers are approved by the curator. Apply at [the broker application link].
- Pass your wallet as `broker` on every sale you route. You earn 15% of each sale, credited in the contract in the currency the buyer paid.
- Withdraw your ETH and IMD balances whenever you like. `brokerStats(wallet)` shows sales routed, earned and withdrawn.
