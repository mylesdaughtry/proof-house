// Where the contracts live and what their functions are called.
// Fill the addresses in from the IMD release once it is live (its dist/imd-deployment.json lists them).
// If a function in the real contracts has a different name, change its "sig" here; mint.js needs no edits.
window.PROOF_HOUSE = {
  chainId: 11155111,
  chainName: 'Sepolia',
  rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
  explorer: 'https://sepolia.etherscan.io',
  addChain: {
    chainId: '0xaa36a7',
    chainName: 'Sepolia',
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
    blockExplorerUrls: ['https://sepolia.etherscan.io'],
  },

  artHouse: '0x0000000000000000000000000000000000000000',
  imd: '0x44a1cd38474fb1748400e7deb5f8d786cce3f89a',
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
