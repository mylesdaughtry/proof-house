// Proof House: wallet connection and minting.
// No dependencies: it talks to the browser wallet (EIP-1193 / EIP-6963) and reads the chain through
// the public RPC in deployment.js. Addresses and function names come from deployment.js.
(function () {
  'use strict';
  if (!window.PROOF_HOUSE) return;
  // Copied and frozen at load, so nothing that runs later can redirect a payment.
  const cfg = deepFreeze(JSON.parse(JSON.stringify(window.PROOF_HOUSE)));
  function deepFreeze(o) {
    Object.values(o).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v); });
    return Object.freeze(o);
  }

  const ZERO = '0x0000000000000000000000000000000000000000';
  const ADDR = /^0x[0-9a-fA-F]{40}$/;
  const TXHASH = /^0x[0-9a-fA-F]{64}$/;
  const CHAIN_HEX = '0x' + cfg.chainId.toString(16);
  const RECEIPT_TIMEOUT_MS = 15 * 60 * 1000;
  // On a path gateway (gateway.example/ipfs/<cid>/…) every site shares one origin and could tamper with this page.
  const PATH_GATEWAY = /^\/(ipfs|ipns)\//.test(location.pathname);
  const GATEWAY_MSG = 'To buy, open Proof House at its own web address. Minting is switched off on shared IPFS gateway links, where other sites could tamper with the page.';
  const ERC20 = {
    balanceOf: 'balanceOf(address)(uint256)',
    allowance: 'allowance(address,address)(uint256)',
    approve: 'approve(address,uint256)',
  };

  // ---------- keccak-256, for function selectors ----------

  const MASK = (1n << 64n) - 1n;
  const RC = [
    '0x0000000000000001', '0x0000000000008082', '0x800000000000808a', '0x8000000080008000',
    '0x000000000000808b', '0x0000000080000001', '0x8000000080008081', '0x8000000000008009',
    '0x000000000000008a', '0x0000000000000088', '0x0000000080008009', '0x000000008000000a',
    '0x000000008000808b', '0x800000000000008b', '0x8000000000008089', '0x8000000000008003',
    '0x8000000000008002', '0x8000000000000080', '0x000000000000800a', '0x800000008000000a',
    '0x8000000080008081', '0x8000000000008080', '0x0000000080000001', '0x8000000080008008',
  ].map(BigInt);
  const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];

  function rotl(v, n) {
    return n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK;
  }

  function keccakF(s) {
    const c = new Array(5);
    const b = new Array(25);
    for (let round = 0; round < 24; round++) {
      for (let x = 0; x < 5; x++) c[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
      for (let x = 0; x < 5; x++) {
        const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
        for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
      }
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
      }
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 25; y += 5) s[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & MASK & b[((x + 2) % 5) + y]);
      }
      s[0] ^= RC[round];
    }
  }

  function keccak256(bytes) {
    const rate = 136;
    const s = new Array(25).fill(0n);
    const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
    padded.set(bytes);
    padded[bytes.length] ^= 0x01;
    padded[padded.length - 1] ^= 0x80;
    for (let off = 0; off < padded.length; off += rate) {
      for (let i = 0; i < rate / 8; i++) {
        let lane = 0n;
        for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + k]);
        s[i] ^= lane;
      }
      keccakF(s);
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 4; i++) {
      let lane = s[i];
      for (let k = 0; k < 8; k++) {
        out[i * 8 + k] = Number(lane & 0xffn);
        lane >>= 8n;
      }
    }
    return out;
  }

  const toHex = (bytes) => '0x' + Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('');
  const utf8 = (s) => new TextEncoder().encode(s);

  // ---------- ABI (static types only: uint, address, bool, bytes32) ----------

  function splitSig(sig) {
    const open = sig.indexOf('(');
    let depth = 0;
    let end = -1;
    for (let k = open; k < sig.length; k++) {
      if (sig[k] === '(') depth++;
      else if (sig[k] === ')' && --depth === 0) { end = k; break; }
    }
    const list = (t) => (t ? t.split(',').map((x) => x.trim()) : []);
    return {
      name: sig.slice(0, open),
      inputs: list(sig.slice(open + 1, end)),
      outputs: list(sig.slice(end + 1).replace(/^\(|\)$/g, '')),
    };
  }

  const selectors = {};
  function selector(name, inputs) {
    const key = `${name}(${inputs.join(',')})`;
    if (!selectors[key]) selectors[key] = toHex(keccak256(utf8(key))).slice(0, 10);
    return selectors[key];
  }

  function word(type, v) {
    const m = /^uint(\d*)$/.exec(type);
    if (m) {
      const n = BigInt(v);
      if (n < 0n || n >= (1n << BigInt(m[1] || 256))) throw new Error(`${type} out of range: ${v}`);
      return n.toString(16).padStart(64, '0');
    }
    if (type === 'address') {
      if (!ADDR.test(v)) throw new Error(`Not an address: ${v}`);
      return v.slice(2).toLowerCase().padStart(64, '0');
    }
    if (type === 'bool') return (v ? '1' : '0').padStart(64, '0');
    if (type === 'bytes32') {
      if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`Not bytes32: ${v}`);
      return v.slice(2);
    }
    throw new Error(`Unsupported ABI type ${type}`);
  }

  function encodeCall(sig, values) {
    const { name, inputs } = splitSig(sig);
    return selector(name, inputs) + inputs.map((t, i) => word(t, values[i])).join('');
  }

  function decode(types, hex) {
    const h = (hex || '0x').slice(2);
    if (h.length < types.length * 64) {
      // An address with no contract answers eth_call with "0x"; never read that as zero values.
      const e = new Error('No contract answered at this address.');
      e.code = 'NO_CODE';
      throw e;
    }
    return types.map((t, i) => {
      const w = h.slice(i * 64, i * 64 + 64);
      if (/^uint\d*$/.test(t)) return BigInt('0x' + w);
      if (t === 'address') return '0x' + w.slice(24);
      if (t === 'bool') return BigInt('0x' + w) !== 0n;
      if (t === 'bytes32') return '0x' + w;
      throw new Error(`Unsupported ABI type ${t}`);
    });
  }

  const KNOWN_ERRORS = {
    '0xfb8f41b2': 'the IMD approval is lower than the price',
    '0xe450d38c': 'not enough IMD in this wallet',
  };

  function revertReason(data) {
    if (typeof data !== 'string' || !/^0x[0-9a-fA-F]{8}/.test(data)) return '';
    const sel = data.slice(0, 10).toLowerCase();
    if (sel === '0x08c379a0') {
      try {
        const h = data.slice(10);
        const len = Number(BigInt('0x' + h.slice(64, 128)));
        const bytes = (h.slice(128, 128 + len * 2).match(/../g) || []).map((x) => parseInt(x, 16));
        return new TextDecoder().decode(Uint8Array.from(bytes));
      } catch (_) {
        return '';
      }
    }
    return KNOWN_ERRORS[sel] || `error ${sel}`;
  }

  // ---------- chain reads ----------

  let rpcId = 0;
  async function rpc(method, params) {
    const res = await fetch(cfg.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    const j = await res.json();
    if (j.error) {
      const e = new Error(j.error.message || 'RPC error');
      e.code = j.error.code;
      e.data = j.error.data;
      throw e;
    }
    return j.result;
  }

  // Wallets nest the real error differently (MetaMask wraps it in -32603 with the cause in .data).
  const errCodes = (e) => (e ? [e.code, e.data && e.data.code, e.cause && e.cause.code].filter((c) => c != null) : []);
  const errText = (e) => (e ? [e.data && e.data.message, e.message].filter(Boolean).join(' ') : '');
  const errData = (e) => e && (typeof e.data === 'string' ? e.data
    : e.data && (e.data.data || (e.data.originalError && e.data.originalError.data)));
  const isRevert = (e) => !!e && (errCodes(e).includes(3) || /revert/i.test(errText(e)) || !!revertReason(errData(e)));

  async function read(to, sig, args) {
    const out = await rpc('eth_call', [{ to, data: encodeCall(sig, args) }, 'latest']);
    return decode(splitSig(sig).outputs, out);
  }

  function resolveTo(to, ctx) {
    if (to === 'artHouse') return cfg.artHouse;
    if (to === 'imd') return cfg.imd;
    if (to === 'collection') return (cfg.collections[ctx.collection] || {}).contract || ZERO;
    return to;
  }

  function prepared(name, ctx) {
    const c = cfg.calls[name];
    if (!c) return null;
    return { to: resolveTo(c.to, ctx), sig: c.sig, args: c.args.map((a) => ctx[a]) };
  }

  async function readCall(name, ctx) {
    const p = prepared(name, ctx);
    if (!p) return undefined;
    return (await read(p.to, p.sig, p.args))[0];
  }

  // ---------- wallet ----------

  class UserError extends Error {}
  const announced = [];
  window.addEventListener('eip6963:announceProvider', (e) => {
    if (!announced.some((p) => p.info.uuid === e.detail.info.uuid)) announced.push(e.detail);
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  const discover = () => (announced[0] && announced[0].provider) || window.ethereum || null;

  let wallet = null; // the one provider this page uses once chosen
  let account = null;
  let listening = null;
  const changeHandlers = [];

  async function connect(interactive) {
    const p = wallet || discover();
    if (!p) {
      if (interactive) throw new UserError('No wallet found. Install a browser wallet such as MetaMask or Rabby, then reload this page.');
      return null;
    }
    const accounts = await p.request({ method: interactive ? 'eth_requestAccounts' : 'eth_accounts' });
    wallet = p;
    account = accounts && accounts[0] ? accounts[0].toLowerCase() : null;
    if (listening !== p && p.on) {
      listening = p;
      p.on('accountsChanged', (a) => { account = a && a[0] ? a[0].toLowerCase() : null; changed(); });
      p.on('chainChanged', () => changed());
    }
    changed();
    return account;
  }

  function changed() {
    renderConnect();
    changeHandlers.forEach((f) => f());
  }

  async function ensureChain() {
    if (parseInt(await wallet.request({ method: 'eth_chainId' }), 16) === cfg.chainId) return;
    try {
      await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] });
    } catch (e) {
      if (errCodes(e).includes(4902) && cfg.addChain) await wallet.request({ method: 'wallet_addEthereumChain', params: [cfg.addChain] });
      else throw e;
    }
    if (parseInt(await wallet.request({ method: 'eth_chainId' }), 16) !== cfg.chainId) {
      throw new UserError(`Switch your wallet to ${cfg.chainName} to mint.`);
    }
  }

  // Checked again right before every transaction: the network and account the purchase started on.
  async function guard(buyer) {
    const [chainHex, accounts] = await Promise.all([
      wallet.request({ method: 'eth_chainId' }),
      wallet.request({ method: 'eth_accounts' }),
    ]);
    const now = accounts && accounts[0] ? accounts[0].toLowerCase() : null;
    if (parseInt(chainHex, 16) !== cfg.chainId || now !== buyer) {
      throw new UserError('Your wallet switched network or account during the purchase, so it stopped before sending anything more.');
    }
  }

  async function send(buyer, to, sig, args, value) {
    await guard(buyer);
    const tx = { from: buyer, to, data: encodeCall(sig, args), chainId: CHAIN_HEX };
    if (value) tx.value = '0x' + value.toString(16);
    const hash = await wallet.request({ method: 'eth_sendTransaction', params: [tx] });
    if (typeof hash !== 'string' || !TXHASH.test(hash)) {
      throw new UserError('Your wallet did not return a normal transaction hash, so this page cannot follow the purchase. Check your wallet for the result.');
    }
    return hash.toLowerCase();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Returns the receipt, or null after the timeout. `stop` may end the wait early with a message.
  async function waitFor(hash, stop) {
    const start = Date.now();
    for (let n = 1; Date.now() - start < RECEIPT_TIMEOUT_MS; n++) {
      let r = null;
      try {
        r = await rpc('eth_getTransactionReceipt', [hash]);
      } catch (_) {
        if (wallet) {
          try { r = await wallet.request({ method: 'eth_getTransactionReceipt', params: [hash] }); } catch (__) { r = null; }
        }
      }
      if (r) return r;
      if (stop && n % 4 === 0) {
        const why = await stop().catch(() => null);
        if (why) throw new UserError(why);
      }
      await sleep(2500);
    }
    return null;
  }

  function friendly(e) {
    if (e instanceof UserError) return e.message;
    const codes = errCodes(e);
    const text = errText(e) || String(e);
    if (codes.some((c) => c === 4001 || c === 5000 || c === 'ACTION_REJECTED') || /user (rejected|denied|cancel)/i.test(text)) {
      return 'You cancelled in your wallet.';
    }
    if (codes.includes(-32002)) return 'Your wallet already has a request waiting. Open it to continue.';
    if (/insufficient funds/i.test(text)) return 'Not enough ETH in this wallet to cover the price and gas.';
    if (isRevert(e)) {
      const reason = revertReason(errData(e)) || [e.data && e.data.message, e.message]
        .map((t) => ((t || '').match(/revert(?:ed)?:?\s*([^.]+)/i) || [])[1]).find(Boolean);
      return `The contract refused${reason ? `: ${reason.trim()}` : ''}.`;
    }
    return (e && e.message) || String(e);
  }

  // ---------- formatting ----------

  // Exact: every digit of the amount that will be sent.
  function units(v, decimals = 18) {
    const s = v.toString().padStart(decimals + 1, '0');
    const whole = s.slice(0, -decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const frac = s.slice(-decimals).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole;
  }
  const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const pad3 = (n) => String(n).padStart(3, '0');

  const store = {
    get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch (_) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* private mode */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch (_) { /* private mode */ } },
  };

  // ---------- connect buttons (every page) ----------

  let showMessage = () => {};
  const connectButtons = Array.from(document.querySelectorAll('[data-connect]'));
  function renderConnect() {
    connectButtons.forEach((b) => {
      b.textContent = account ? short(account) : 'Connect';
      b.title = account ? `Connected: ${account}` : 'Connect a wallet';
    });
  }
  connectButtons.forEach((b) => b.addEventListener('click', async () => {
    if (account) return;
    try {
      await connect(true);
    } catch (e) {
      const text = friendly(e);
      b.textContent = discover() ? 'Not connected' : 'No wallet';
      b.title = text;
      showMessage(text, 'error');
      setTimeout(renderConnect, 3000);
    }
  }));
  connect(false).catch(() => {});

  // ---------- piece page ----------

  const page = document.querySelector('[data-piece-page]');
  if (!page) return;

  const $ = (sel) => page.querySelector(sel);
  const params = new URLSearchParams(location.search);
  const rawId = params.get('id') || page.dataset.piece || '1';
  const pieceId = /^\d{1,9}$/.test(rawId) && Number(rawId) > 0 ? Number(rawId) : 1;
  const collection = page.dataset.collection || '1';
  const colCfg = cfg.collections[collection] || {};
  const commission = colCfg.commissionPct;
  const pendingKey = `ph-pending-${cfg.chainId}-${collection}-${pieceId}`;

  let broker = ZERO;
  const fromUrl = params.get('broker');
  if (fromUrl && ADDR.test(fromUrl)) {
    broker = fromUrl.toLowerCase();
    store.set('ph-broker', broker);
  } else {
    const saved = store.get('ph-broker');
    if (typeof saved === 'string' && ADDR.test(saved)) broker = saved.toLowerCase();
  }
  const ctx = { collection, piece: pieceId, broker };

  // Which piece this page shows.
  const art = `art/${pad3(pieceId)}.svg`;
  $('[data-kicker]').textContent = `Collection ${pad3(collection)} · No. ${pad3(pieceId)}`;
  $('[data-art]').src = art;
  $('[data-art]').onerror = function () { this.onerror = null; this.src = 'art/001.svg'; };
  $('[data-art-link]').href = art;
  $('[data-raw-svg]').href = art;
  const setTitle = (t) => {
    $('[data-title]').textContent = t;
    $('[data-crumb-title]').textContent = `/ ${t}`;
    document.title = `${t} by Myles — Proof House`;
  };
  setTitle(`[Title ${String(pieceId).padStart(2, '0')}]`);
  fetch('catalog.json').then((r) => r.json()).then((c) => {
    const col = (c.collections || []).find((x) => String(x.id) === String(collection));
    const p = col && (col.pieces || []).find((x) => x.id === pieceId);
    if (p && typeof p.title === 'string' && p.title) setTitle(p.title);
  }).catch(() => {});

  const msg = $('[data-mint-message]');
  showMessage = (text, tone, link) => {
    msg.textContent = text;
    msg.dataset.tone = tone || '';
    if (link) {
      msg.append(' ');
      const a = document.createElement('a');
      a.href = link.href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = link.text;
      msg.append(a);
    }
  };
  const txLink = (hash) => (cfg.explorer && /^https:\/\//.test(cfg.explorer)
    ? { href: `${cfg.explorer}/tx/${hash}`, text: 'View transaction' } : null);

  const ethBtn = $('[data-mint="eth"]');
  const imdBtn = $('[data-mint="imd"]');
  const imdNote = $('[data-imd-note]');
  const statusEl = $('[data-status]');
  const priceEl = $('[data-price]');
  let state = {};
  let busy = false;
  let codeOk = null; // do the configured addresses hold contracts?
  let imdOk = false;

  const configured = () => [cfg.artHouse, colCfg.contract].every((a) => ADDR.test(a || '') && a.toLowerCase() !== ZERO);

  // The broker box only appears when a broker link brought the buyer here.
  const brokerBox = $('[data-broker-box]');
  if (broker !== ZERO) {
    brokerBox.hidden = false;
    $('[data-broker-address]').textContent = short(broker);
    $('[data-broker-pct]').textContent = commission != null ? `${commission}%` : 'a commission';
  }

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = `status ${kind || ''}`.trim();
  }

  function render() {
    const s = state;
    ethBtn.disabled = imdBtn.disabled = busy;
    if (!configured() || codeOk === false) {
      setStatus('Not on sale yet', 'pending');
      priceEl.textContent = '[Price] ETH · [Price] IMD';
      ethBtn.textContent = 'Mint · [Price] ETH';
      imdBtn.textContent = 'Mint with IMD · [Price] IMD';
      return;
    }
    if (s.error) {
      setStatus('Could not reach the chain', 'pending');
      return;
    }
    const parts = [];
    if (s.priceEth != null) parts.push(`${units(s.priceEth)} ETH`);
    if (s.priceImd) parts.push(`${units(s.priceImd)} IMD`);
    priceEl.textContent = parts.join(' · ') || '—';
    if (s.priceEth != null) ethBtn.textContent = `Mint · ${units(s.priceEth)} ETH`;
    if (s.priceImd) imdBtn.textContent = `Mint with IMD · ${units(s.priceImd)} IMD`;
    const sold = !!s.owner && s.owner !== ZERO;
    const mintable = !sold && s.finalized !== false && !PATH_GATEWAY;
    const imdOn = mintable && imdOk && !!s.priceImd;
    ethBtn.hidden = !mintable;
    imdBtn.hidden = !imdOn;
    imdNote.hidden = !imdOn;
    if (sold) setStatus(account && s.owner === account ? 'Yours' : `Sold to ${short(s.owner)}`, 'sold');
    else if (s.finalized === false) setStatus('Not on sale yet', 'pending');
    else setStatus('Available', '');
  }

  async function checkCode() {
    const [house, col, imd] = await Promise.all([cfg.artHouse, colCfg.contract, cfg.imd].map((a) => (
      a && ADDR.test(a) ? rpc('eth_getCode', [a, 'latest']) : Promise.resolve('0x'))));
    codeOk = house !== '0x' && col !== '0x';
    imdOk = imd !== '0x';
  }

  async function refresh() {
    if (!configured()) { render(); return; }
    try {
      if (codeOk === null) await checkCode();
      if (!codeOk) { render(); return; }
      const [priceEth, priceImd, finalized, owner] = await Promise.all([
        readCall('priceEth', ctx),
        readCall('priceImd', ctx).catch((e) => (isRevert(e) ? 0n : Promise.reject(e))),
        readCall('finalized', ctx),
        // ownerOf reverts for a token that does not exist yet: that means unsold.
        readCall('ownerOf', ctx).then((o) => o.toLowerCase()).catch((e) => (isRevert(e) ? null : Promise.reject(e))),
      ]);
      state = { priceEth, priceImd, finalized, owner };
    } catch (e) {
      state = { error: e };
    }
    render();
  }
  changeHandlers.push(render);

  async function startMint() {
    if (PATH_GATEWAY) throw new UserError(GATEWAY_MSG);
    if (!configured()) throw new UserError('Minting opens when the contracts are live.');
    if (store.get(pendingKey)) throw new UserError('A purchase of this piece from this browser is still waiting to confirm.');
    if (!account) await connect(true);
    if (!account) throw new UserError('Connect a wallet to mint.');
    await ensureChain();
    const buyer = account;
    await refresh();
    if (!codeOk) throw new UserError(`The contracts were not found on ${cfg.chainName}, so minting is off.`);
    if (state.error) throw new UserError('Could not reach the chain. Try again in a moment.');
    if (state.owner && state.owner !== ZERO) throw new UserError('This piece has already been minted.');
    if (state.finalized === false) throw new UserError('This piece is not on sale yet.');
    return buyer;
  }

  async function soldToSomeoneElse(buyer) {
    const o = await readCall('ownerOf', ctx).then((a) => a.toLowerCase()).catch(() => null);
    return o && o !== ZERO && o !== buyer ? 'Someone else bought this piece first, so your transaction will fail; only gas is spent.' : null;
  }

  async function mintEth() {
    const buyer = await startMint();
    const price = state.priceEth;
    const balance = BigInt(await rpc('eth_getBalance', [buyer, 'latest']));
    if (balance < price) throw new UserError(`You need ${units(price)} ETH plus gas; this wallet has ${units(balance)} ETH.`);
    showMessage('Confirm the purchase in your wallet…');
    const c = prepared('mint', ctx);
    const hash = await send(buyer, c.to, c.sig, c.args, price);
    await finish(hash, buyer, 'Minting…');
  }

  async function allowanceOf(buyer, atLeast) {
    // The public RPC sits behind load balancers, so a fresh approval can take a moment to show.
    let a = 0n;
    for (let i = 0; i < 4; i++) {
      a = (await read(cfg.imd, ERC20.allowance, [buyer, cfg.artHouse]))[0];
      if (a >= atLeast) return a;
      await sleep(1500);
    }
    return a;
  }

  async function mintImd() {
    const buyer = await startMint();
    const price = state.priceImd;
    if (!price || !imdOk) throw new UserError('This collection is not sold in IMD.');
    const balance = (await read(cfg.imd, ERC20.balanceOf, [buyer]))[0];
    if (balance < price) {
      const hint = cfg.chainId === 11155111 ? ' On Sepolia, anyone can mint test IMD from its contract.' : '';
      throw new UserError(`You need ${units(price)} IMD; this wallet has ${units(balance)}.${hint}`);
    }
    let approved = false;
    if ((await read(cfg.imd, ERC20.allowance, [buyer, cfg.artHouse]))[0] < price) {
      showMessage('Step 1 of 2: approve IMD in your wallet…');
      const approveHash = await send(buyer, cfg.imd, ERC20.approve, [cfg.artHouse, price]);
      showMessage('Step 1 of 2: approving IMD…', '', txLink(approveHash));
      const r = await waitFor(approveHash);
      if (!r) throw new UserError('The IMD approval has not confirmed after 15 minutes. Check your wallet, then try again.');
      if (BigInt(r.status) !== 1n) throw new UserError('The IMD approval failed on chain. Nothing was bought.');
      approved = true;
      const allowed = await allowanceOf(buyer, price);
      if (allowed < price) {
        throw new UserError(`Your wallet approved ${units(allowed)} IMD, less than the ${units(price)} IMD price. Approve the full price to buy.`);
      }
      await refresh();
      if (state.owner && state.owner !== ZERO) {
        throw new UserError(`Someone bought this piece while the approval confirmed. Your approval for ${units(price)} IMD is still in place; you can lower it in your wallet.`);
      }
      if (state.priceImd !== price) {
        throw new UserError(`The IMD price changed to ${units(state.priceImd || 0n)} while the approval confirmed. Nothing was bought; try again.`);
      }
      showMessage('Step 2 of 2: confirm the purchase in your wallet…');
    } else {
      showMessage('Confirm the purchase in your wallet…');
    }
    const c = prepared('mintWithImd', ctx);
    try {
      const hash = await send(buyer, c.to, c.sig, c.args);
      await finish(hash, buyer, approved ? 'Step 2 of 2: minting…' : 'Minting…');
    } catch (e) {
      if (!approved) throw e;
      throw new UserError(`${friendly(e)} Your approval for ${units(price)} IMD is still in place, so you can try again without approving.`);
    }
  }

  async function finish(hash, buyer, waiting) {
    store.set(pendingKey, { hash, buyer, at: Date.now() });
    await settle(hash, buyer, waiting);
  }

  async function settle(hash, buyer, waiting) {
    showMessage(waiting, '', txLink(hash));
    let r;
    try {
      r = await waitFor(hash, () => soldToSomeoneElse(buyer));
    } catch (e) {
      store.del(pendingKey);
      throw e;
    }
    store.del(pendingKey);
    if (!r) throw new UserError('Still no confirmation after 15 minutes. Check your wallet: if the transaction was dropped or replaced, you can try again.');
    if (BigInt(r.status) !== 1n) throw new UserError('The transaction failed on chain, so the piece was not bought. Only gas was spent.');
    await refresh();
    if (state.owner !== buyer) throw new UserError('The transaction confirmed, but this wallet does not own the piece. Check the transaction.');
    showMessage(`Minted. No. ${pad3(pieceId)} is yours.`, 'ok', txLink(hash));
  }

  async function run(fn) {
    if (busy) return;
    busy = true;
    render();
    try {
      await fn();
    } catch (e) {
      showMessage(friendly(e), 'error');
    } finally {
      busy = false;
      render();
    }
  }
  ethBtn.addEventListener('click', () => run(mintEth));
  imdBtn.addEventListener('click', () => run(mintImd));

  refresh().then(() => {
    if (PATH_GATEWAY) showMessage(GATEWAY_MSG);
    else if (!configured()) showMessage('Minting opens when the contracts are live.');
    else if (codeOk === false) showMessage(`The contracts were not found on ${cfg.chainName}, so minting is off.`);
    if (broker !== ZERO && codeOk && cfg.calls.isBroker) {
      readCall('isBroker', ctx).then((ok) => {
        if (ok === false) $('[data-broker-note]').textContent = 'This wallet is not an approved broker, so its share goes to the house.';
      }).catch(() => {});
    }
    // A purchase sent from this browser before a reload: follow it instead of allowing a second one.
    const pending = store.get(pendingKey);
    if (pending && TXHASH.test(pending.hash || '') && ADDR.test(pending.buyer || '')) {
      run(() => settle(pending.hash, pending.buyer, 'A purchase of this piece from this browser is waiting to confirm…'));
    } else if (pending) {
      store.del(pendingKey);
    }
  });
})();
