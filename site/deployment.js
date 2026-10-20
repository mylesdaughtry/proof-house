// Where the contracts live and what their functions are called.
// Fill the addresses in from the IMD release once it is live (its dist/imd-deployment.json lists them).
// If a function in the real contracts has a different name, change its "sig" here; mint.js needs no edits.
window.PROOF_HOUSE = {
  chainId: 1,
  chainName: 'Ethereum',
  // The live site reads through the house's own domain-locked RPC here; use your own endpoint.
  rpcUrl: 'https://ethereum-rpc.publicnode.com',
  // What rpcUrl can't answer (down, over its limits, a refused address) goes to this public RPC, so the pages keep working.
  rpcFallback: 'https://ethereum-rpc.publicnode.com',
  explorer: 'https://etherscan.io',
  // Read-only: pages read the chain, but nothing connects, signs or sends. publish.py turns it on for the public site.
  readOnly: false,
  // Chainlink VRF's key hash gas lane on this network, in gwei (Sepolia has one: 500). The curator page uses it to
  // show the subscription balance Chainlink needs before it will answer a draw.
  vrfLaneGwei: 200,
  addChain: null,

  // Drops, by slug: each drop page (drops/<slug>.html) reads its contracts and proof links from here.
  drops: {
    artifacts: {
      number: '001',
      name: 'Artifacts',
      artist: 'Myles Daughtry',
      // The artist's thesis, quoted as written on the drop page, in the docs and in drops.json.
      thesis: 'In a world where everyone has access, where people feel entitled to information, Artifacts represents things that maintain privacy. The value is in the idea and not the output.',
      // Ethereum mainnet: IMD launch 2199 (commit a1735ce), plus the piece implementation and the buyback burner deployed
      // after it by the setup wallet; every contract checked against the reviewed build (tools/deploy/verify_code.py).
      deployBlock: 26224242, // where bid history starts
      // THE SOURCE's auction terms, prefilled on the curator page's Go live step.
      auction: { reserveEth: '0.01', hours: 24 },
      // Holders only: THE SOURCE's auction is for identity.md seat holders, wallets with at least minImd IMD, or
      // Cncptl Prspctv members (any points), start to finish; the editions are holders first for `hours`, then anyone.
      // The curator sets it on the curator page.
      // editions: holders only for 24 h (up to 2 per wallet for 12 h, then up to 3 for 12 h), then public, up to 5
      gate: { hours: 24, minImd: '10', phases: [{ hours: 12, cap: 2 }, { hours: 12, cap: 3 }] },
      // the third way in: a Cncptl Prspctv membership (its soulbound points; contracts.gateMember)
      members: { name: 'Cncptl Prspctv', url: 'https://cncptlprspctv.xyz/how' },
      // Resale lives on the collection's own site, not on Proof House.
      market: 'https://artifacts.proofhouse.fun/',
      // Sale order: THE SOURCE's auction first, then the editions. Optional: schedule: { auctionOpens: '2026-11-01T18:00:00Z' }
      contracts: {
        artHouse: '0x73b1e5825280df29ea7124e927f3ebd9710b5a99',
        factory: '0x62527f742de81a59e2bcd4d2633f796426553200',
        source: '0xe57e3f2ce296252b461911b34787371d6d806ab2',
        artStorage: '0x78d21b32dbd1bf216015b1dc4273072d3511bea7',
        piece: '0x8b003b73cb5adeff29d27819e9953cdc9dd5a261',
        // holders first: identity.md seats and IMD (on Sepolia: test stand-ins)
        seats: '0x0000ec93127baa929e58e97dd0095a2bfb38ec1d',
        gateToken: '0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7',
        // Cncptl Prspctv's points (EngageV2, read with points(address); on Sepolia: a test stand-in, none until v13r2)
        gateMember: '0x684a61e46ac3db9806a199bae7b9d456f525687d',
        brokerPass: '0xa6958cbc41325e97ecb3bb9d837fbd0938cb2b4f',
        // reviews of artist submissions, one voice per seat or piece (SubmissionReviews; none before v9)
        reviews: '0xaa1142e3dc35d28cbf3a170bd931a76fc5b8aeab',
        // the IMD buyback and burn (ImdBuybackBurner; none before v9)
        burner: '0x3d15de58d49af694236881403d9381d590008d1c',
      },
      // the ETH/IMD Uniswap v4 pool the burner swaps in (Ethereum mainnet: 1% fee, tick spacing 200, no hook)
      buybackPool: { fee: 10000, tickSpacing: 200, hooks: '0x0000000000000000000000000000000000000000' },
      proof: {},
    },
  },
  // The curator page's hand-over form starts with this address. Sepolia only: the rehearsal's test owner.
  // WalletConnect (phone wallets by QR code): its code is self-hosted (@walletconnect/ethereum-provider 2.25.0, bundled
  // into one file) and loads only when someone picks it. The project ID (Reown, team Organik Studio) is public.
  walletConnect: { projectId: 'd8ec9587b79c31441ecea42eb9961752', script: '/vendor/walletconnect-2.25.0.js' },
  handoverTo: '',

  artHouse: '0x0000000000000000000000000000000000000000',
  imd: '0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7',
  collections: {
    1: { contract: '0x0000000000000000000000000000000000000000', commissionPct: 15 },
  },

  // args name the values to pass: collection, piece, broker.
  calls: {
    priceEth:    { to: 'artHouse',   sig: 'price(uint256)(uint256)',               args: ['collection'] },
    priceImd:    { to: 'artHouse',   sig: 'priceIMD(uint256)(uint256)',            args: ['collection'] },
    finalized:   { to: 'artHouse',   sig: 'isFinalized(uint256,uint256)(bool)',    args: ['collection', 'piece'] },
    ownerOf:     { to: 'collection', sig: 'ownerOf(uint256)(address)',             args: ['piece'] },
    isBroker:    { to: 'artHouse',   sig: 'isBroker(address)(bool)',               args: ['broker'] },
    mint:        { to: 'artHouse',   sig: 'mint(uint256,uint256,address)',         args: ['collection', 'piece', 'broker'] },
    mintWithImd: { to: 'artHouse',   sig: 'mintWithIMD(uint256,uint256,address)',  args: ['collection', 'piece', 'broker'] },
  },
};
