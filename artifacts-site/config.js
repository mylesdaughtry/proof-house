// ARTIFACTS site: the network and the collection's contracts. The same contracts Proof House sold the drop through;
// this site only reads them and sends resale, viewing and reveal transactions to each piece's own contract.
// (wallet.js reads this object under the name PROOF_HOUSE.)
window.PROOF_HOUSE = {
  siteName: 'the ARTIFACTS site', // how the shared wallet module names this site
  chainId: 1,
  chainName: 'Ethereum',
  // The live site reads through the house's own domain-locked RPC here; use your own endpoint.
  rpcUrl: 'https://ethereum-rpc.publicnode.com',
  // What rpcUrl can't answer (down, over its limits, a refused address) goes to this public RPC, so the pages keep working.
  rpcFallback: 'https://ethereum-rpc.publicnode.com',
  explorer: 'https://etherscan.io',
  // Read-only: pages read the chain, but nothing connects, signs or sends. publish.py turns it on for the public site.
  readOnly: false,
  addChain: null,
  // WalletConnect (phone wallets by QR code): its code is self-hosted (@walletconnect/ethereum-provider 2.25.0, bundled
  // into one file) and loads only when someone picks it. The project ID (Reown, team Organik Studio) is public.
  walletConnect: { projectId: 'd8ec9587b79c31441ecea42eb9961752', script: '/vendor/walletconnect-2.25.0.js' },
  // Where the primary sale lives (THE SOURCE's auction and the 255 editions).
  houseUrl: 'https://proofhouse.fun/drops/artifacts.html',
  thesis: 'In a world where everyone has access, where people feel entitled to information, Artifacts represents things that maintain privacy. The value is in the idea and not the output.',
  drops: {
    artifacts: {
      deployBlock: 26224242,
      contracts: {
        artHouse: '0x73b1e5825280df29ea7124e927f3ebd9710b5a99',
        factory: '0x62527f742de81a59e2bcd4d2633f796426553200',
        source: '0xe57e3f2ce296252b461911b34787371d6d806ab2',
        piece: '0x8b003b73cb5adeff29d27819e9953cdc9dd5a261',
      },
    },
  },
  collections: {},
};
