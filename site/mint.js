// Proof House: wallet connection and minting.
// No dependencies: it talks to the browser wallet (EIP-1193 / EIP-6963) and reads the chain through
// the public RPC in deployment.js. Addresses and function names come from deployment.js.
(function () {
  'use strict';
  if (!window.PROOF_HOUSE) return;
  // Copied and frozen at load, so nothing that runs later can redirect a payment.
  const cfg = deepFreeze(JSON.parse(JSON.stringify(window.PROOF_HOUSE)));
  // Read-only (the public preview): every page still reads the chain, but no wallet connects and nothing is signed or sent.
  const READ_ONLY = cfg.readOnly === true;
  const READ_ONLY_TEXT = 'This site is read-only for now: nothing can be bought, bid on, listed, brokered or submitted yet.';
  function deepFreeze(o) {
    Object.values(o).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v); });
    return Object.freeze(o);
  }

  const ZERO = '0x0000000000000000000000000000000000000000';
  const ADDR = /^0x[0-9a-fA-F]{40}$/;
  const TXHASH = /^0x[0-9a-fA-F]{64}$/;
  const CHAIN_HEX = '0x' + cfg.chainId.toString(16);
  const RECEIPT_TIMEOUT_MS = 15 * 60 * 1000;

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
    if (type === 'bytes4') {
      if (!/^0x[0-9a-fA-F]{8}$/.test(v)) throw new Error(`Not bytes4: ${v}`);
      return v.slice(2).padEnd(64, '0'); // fixed bytes sit at the left of the word
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
      if (t === 'bytes4') return '0x' + w.slice(0, 8);
      throw new Error(`Unsupported ABI type ${t}`);
    });
  }

  const KNOWN_ERRORS = {
    '0xfb8f41b2': 'the IMD approval is lower than the price',
    '0xe450d38c': 'not enough IMD in this wallet',
    '0x4c013bd7': 'the sale is closed',
    '0xf7760f25': 'the amount does not match the price',
    '0x52df9fe5': 'not enough editions are left for that many',
    '0x5426a580': 'this wallet has reached its limit for now: 5 in all, fewer in the first hours',
    '0x888e58a8': 'you can mint 1 to 5 editions at a time',
    '0xf8eb54de': 'holders only right now: this wallet needs an identity.md seat, the IMD minimum or a Cncptl Prspctv membership (or that seat is not yours)',
    '0x24a3bd64': 'this seat has reached its limit for now: 5 in all, fewer in the first hours',
    '0x6cce4b7c': 'the edition sale has ended for good',
    '0x30712f1d': 'the edition sale has not opened yet',
    '0x969bf728': 'there is nothing ready to claim',
    '0x52726595': "this edition's key has not arrived yet",
    '0x646cf558': 'this edition is already claimed',
    '0x472e017e': 'only the buyer can claim this edition',
    '0xee2bdc06': "another buyer's fallback draw is under way: anyone can finish it a minute after it starts, then try again",
    '0x0eb0e6e2': 'Chainlink is still answering draws, so ask it again for yours instead (the fallback opens after 3 quiet days)',
    '0x1508bcfc': 'this draw has started already: finish it once its block is mined',
    '0x11d4a861': "this draw's block hasn't been mined yet: try again in a minute",
    '0x11c9eb86': "this draw's block is too old to read now: start it again",
    '0x4e29635d': 'too soon: wait a little longer before asking again',
    '0x841c6a13': 'the piece template is not connected yet (an owner setup step)',
    '0x2122cead': 'the piece template is already connected, and it can never change',
    '0xaba47339': 'the ledger does not take this contract\'s sales yet (an owner setup step)',
    '0xecdd1c29': 'too late: the 24 hours for sending the key have passed, so refund the buyer instead',
    '0x085de625': 'too early: the waiting period is not over yet',
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
  // Two RPCs: the house's own (cfg.rpcUrl, a paid plan that answers only these sites' addresses) and a public one
  // (cfg.rpcFallback). What the first can't answer (down, over its limits, refusing this page's address) goes to the
  // second, which then takes every read for a minute before the first is tried again. A revert is an answer, never a
  // reason to move.
  const RPCS = [cfg.rpcUrl, cfg.rpcFallback].filter(Boolean);
  let fallbackUntil = 0;
  const LIMITED = /limit|rate|capacity|exceed|range|too many|compute units|unauthori|not allowed|forbidden|origin/i;
  const refused = (j) => !!(j && j.error && j.error.code !== 3 && !/revert/i.test(j.error.message || '')
    && (j.error.code === 429 || LIMITED.test(j.error.message || '')));
  // An RPC drops a request now and then (a reset connection, a 5xx, a rate limit): the last one tried gets two more tries.
  async function postTo(url, body, tries) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (res.status >= 500 || res.status === 429 || res.status === 401 || res.status === 403) throw new Error(`RPC HTTP ${res.status}`);
        return await res.json();
      } catch (e) {
        if (attempt >= tries) throw e;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
  }
  async function post(body) {
    const order = RPCS.length > 1 && Date.now() < fallbackUntil ? [RPCS[1], RPCS[0]] : RPCS;
    let err;
    for (let i = 0; i < order.length; i++) {
      const last = i === order.length - 1;
      try {
        const j = await postTo(order[i], body, last ? 2 : 0);
        if (!last && (Array.isArray(j) ? j.some(refused) : refused(j))) throw new Error('RPC refused');
        return j;
      } catch (e) {
        err = e;
        if (!last && order[i] === RPCS[0]) fallbackUntil = Date.now() + 60000;
      }
    }
    throw err;
  }
  function settle(j) {
    if (j && j.error) {
      const e = new Error(j.error.message || 'RPC error');
      e.code = j.error.code;
      e.data = j.error.data;
      throw e;
    }
    if (!j || !('result' in j)) throw new Error('RPC error');
    return j.result;
  }
  // Reads asked for in the same moment go out together as one JSON-RPC batch: one round trip instead of many. A
  // provider that won't batch gets them one by one from then on.
  const BATCHED = new Set(['eth_call', 'eth_getBalance', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_chainId']);
  let batching = true;
  let queue = [];
  const single = (it) => post(it.req).then(settle).then(it.resolve, it.reject);
  async function sendBatch(items) {
    if (items.length === 1) return single(items[0]);
    let out;
    try { out = await post(items.map((it) => it.req)); } catch (_) { out = null; }
    if (!Array.isArray(out)) {
      if (out) batching = false; // answered, but not as a batch
      items.forEach(single);
      return;
    }
    const byId = new Map(out.map((j) => [j && j.id, j]));
    items.forEach((it) => {
      const j = byId.get(it.req.id);
      if (!j) { single(it); return; }
      try { it.resolve(settle(j)); } catch (e) { it.reject(e); }
    });
  }
  // Plain reads (eth_call at 'latest', no sender, no value) asked for in the same moment go out as one call to
  // Multicall3, which an RPC charges as a single eth_call however many it carries: at a busy drop a page's twenty-odd
  // reads cost one. Each read still settles on its own, a revert as a revert. A read that fails with no reason (it
  // may only have run short of gas in the bundle) is asked again alone; so is everything when the bundle itself fails
  // or the chain has no Multicall3.
  const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
  const MERGE_MAX = 40;
  let merging = true;
  const mergeable = (it) => {
    const [c, tag] = it.req.params;
    return merging && it.req.method === 'eth_call' && tag === 'latest' && !!c && !!c.to && !c.from && !c.value
      && c.to.toLowerCase() !== MULTICALL3 && /^0x(?:[0-9a-fA-F]{2})*$/.test(c.data || '0x');
  };
  const w32 = (n) => n.toString(16).padStart(64, '0');
  function aggregate3(items) { // aggregate3((address target, bool allowFailure, bytes callData)[])
    const tuples = items.map((it) => {
      const { to, data } = it.req.params[0];
      const d = (data || '0x').slice(2);
      return to.slice(2).toLowerCase().padStart(64, '0') + w32(1) + w32(0x60) + w32(d.length / 2) + d.padEnd(Math.ceil(d.length / 64) * 64, '0');
    });
    let off = items.length * 32;
    const heads = tuples.map((t) => { const o = w32(off); off += t.length / 2; return o; }).join('');
    return '0x82ad56cb' + w32(0x20) + w32(items.length) + heads + tuples.join('');
  }
  function unpack3(hex, n) { // (bool success, bytes returnData)[]
    const h = hex.slice(2);
    const at = (byte) => Number(BigInt('0x' + (h.slice(byte * 2, byte * 2 + 64) || '0')));
    const list = at(0);
    if (at(list) !== n) throw new Error('Multicall3 answered for a different number of reads');
    return Array.from({ length: n }, (_, j) => {
      const t = list + 32 + at(list + 32 + j * 32);
      const b = t + at(t + 32);
      return { ok: at(t) !== 0, data: '0x' + h.slice((b + 32) * 2, (b + 32 + at(b)) * 2) };
    });
  }
  function bundle(items) {
    const alone = () => items.forEach(single);
    return {
      req: { jsonrpc: '2.0', id: ++rpcId, method: 'eth_call', params: [{ to: MULTICALL3, data: aggregate3(items) }, 'latest'] },
      resolve(hex) {
        let out;
        try {
          if (hex === '0x') { merging = false; throw new Error('no Multicall3 on this chain'); }
          out = unpack3(hex, items.length);
        } catch (_) { alone(); return; }
        out.forEach((r, j) => {
          if (r.ok) { items[j].resolve(r.data); return; }
          if (r.data === '0x') { single(items[j]); return; }
          const e = new Error('execution reverted');
          e.code = 3;
          e.data = r.data;
          items[j].reject(e);
        });
      },
      reject: alone,
    };
  }
  function flush() {
    const items = queue;
    queue = [];
    const reads = items.filter(mergeable);
    const out = reads.length > 1 ? items.filter((it) => !reads.includes(it)) : items;
    if (reads.length > 1) {
      for (let i = 0; i < reads.length; i += MERGE_MAX) {
        const part = reads.slice(i, i + MERGE_MAX);
        out.push(part.length > 1 ? bundle(part) : part[0]);
      }
    }
    for (let i = 0; i < out.length; i += 20) sendBatch(out.slice(i, i + 20));
  }
  function rpc(method, params) {
    const req = { jsonrpc: '2.0', id: ++rpcId, method, params };
    if (!batching || !BATCHED.has(method)) return post(req).then(settle);
    return new Promise((resolve, reject) => {
      queue.push({ req, resolve, reject });
      if (queue.length === 1) setTimeout(flush, 0);
    });
  }

  // Wallets nest the real error differently (MetaMask wraps it in -32603 with the cause in .data).
  const errCodes = (e) => (e ? [e.code, e.data && e.data.code, e.cause && e.cause.code, e.error && e.error.code,
    e.data && e.data.originalError && e.data.originalError.code].filter((c) => c != null) : []);
  const errText = (e) => (e ? [e.data && e.data.message, e.message].filter(Boolean).join(' ') : '');
  const errData = (e) => e && (typeof e.data === 'string' ? e.data
    : e.data && (e.data.data || (e.data.originalError && e.data.originalError.data)));
  const isRevert = (e) => !!e && (errCodes(e).includes(3) || /revert/i.test(errText(e)) || !!revertReason(errData(e)));

  // Every log matching `filter` (address and topics) from `fromBlock` to now, oldest first, in 40,001-block windows.
  // Logs more than 64 blocks deep can't change, so this browser keeps them (per filter) and next time asks only for
  // newer blocks. Each call returns the whole list, so callers recount from scratch and never count a log twice.
  // What's kept carries the hash of its last block, so a chain that was reset or forked again starts over. A `name`
  // keeps one copy for a filter that changes (e.g. a growing list of addresses): a different filter starts it over.
  const SETTLED = 64;
  const logMemo = new Map();
  const slimLog = (l) => ({ address: (l.address || '').toLowerCase(), topics: l.topics, data: l.data, blockNumber: Number(BigInt(l.blockNumber)), transactionHash: l.transactionHash, logIndex: l.logIndex });
  async function logs(filter, fromBlock, name) {
    const start = Number(fromBlock || 0);
    const sig = toHex(keccak256(utf8(JSON.stringify([filter.address || null, filter.topics || null, start])))).slice(2, 26);
    const key = `ph-logs:${cfg.chainId || ''}:${name || sig}`;
    const empty = { to: start - 1, hash: null, sig, logs: [] };
    let kept = logMemo.get(key);
    if (kept && kept.sig !== sig) kept = null;
    let check = null;
    if (!kept) {
      try { kept = JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { kept = null; }
      if (!kept || typeof kept.to !== 'number' || !Array.isArray(kept.logs) || !kept.hash || kept.sig !== sig) kept = empty;
      else check = rpc('eth_getBlockByNumber', ['0x' + kept.to.toString(16), false]).catch(() => null);
    }
    const [latestHex, block] = await Promise.all([rpc('eth_blockNumber', []), check]);
    const latest = Number(BigInt(latestHex));
    if (check && (!block || block.hash !== kept.hash)) kept = empty;
    const fresh = [];
    for (let from = kept.to + 1; from <= latest; from += 40001) {
      const to = Math.min(latest, from + 40000);
      const got = await rpc('eth_getLogs', [{ ...filter, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
      (got || []).forEach((l) => { if (!l.removed) fresh.push(slimLog(l)); });
    }
    const safe = latest - SETTLED;
    if (safe > kept.to) {
      const at = await rpc('eth_getBlockByNumber', ['0x' + safe.toString(16), false]).catch(() => null);
      if (at && at.hash) {
        kept = { to: safe, hash: at.hash, sig, logs: kept.logs.concat(fresh.filter((l) => l.blockNumber <= safe)) };
        logMemo.set(key, kept);
        try { localStorage.setItem(key, JSON.stringify(kept)); } catch (_) { /* full or private: kept for this visit only */ }
      }
    }
    return kept.logs.concat(fresh.filter((l) => l.blockNumber > kept.to));
  }

  // The key format a piece template uses: 2 when it checks fake keys (keyProof(), contracts from v13), 1 when that
  // call reverts or nothing answers it; a network error throws, so nothing is decided on a blip.
  // Mainnet only ever runs contracts from v13, so it is always version 2 there, whatever a read says.
  async function keyScheme(piece) {
    if (cfg.chainId === 1) return 2;
    try { await read(piece, 'keyProof()(address)', []); return 2; }
    catch (e) { if (e && (e.code === 'NO_CODE' || isRevert(e))) return 1; throw e; }
  }

  async function read(to, sig, args) {
    const out = await rpc('eth_call', [{ to, data: encodeCall(sig, args) }, 'latest']);
    return decode(splitSig(sig).outputs, out);
  }

  // ---------- wallet ----------

  class UserError extends Error {}
  // An outcome the person chose (closing the chooser): no error shown for it.
  const quietError = (text) => Object.assign(new UserError(text), { quiet: true });
  const isPhone = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

  // On a phone with no wallet in the browser: open this page inside a wallet app's own browser, keeping who brought
  // this visitor (the ?broker= they arrived with) on the link.
  function openInWallet() {
    const url = new URL(location.href);
    if (!url.searchParams.get('broker')) {
      for (const k of ['ph-broker', 'ar-broker']) {
        try { const b = JSON.parse(sessionStorage.getItem(k)); if (typeof b === 'string' && ADDR.test(b)) { url.searchParams.set('broker', b); break; } } catch (_) { /* none */ }
      }
    }
    const href = url.toString();
    const bare = href.replace(/^https?:\/\//, '');
    const apps = [
      ['MetaMask', `https://metamask.app.link/dapp/${bare}`],
      ['Coinbase Wallet', `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(href)}`],
      ['Trust Wallet', `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(href)}`],
      ['Phantom', `https://phantom.app/ul/browse/${encodeURIComponent(href)}?ref=${encodeURIComponent(url.origin)}`],
    ];
    const d = dialogEl();
    d.textContent = '';
    const t = document.createElement('p'); t.id = 'wp-title'; t.className = 'wp-title'; t.textContent = 'Open in your wallet app';
    const p = document.createElement('p'); p.className = 'wp-account';
    p.textContent = `On a phone, ${cfg.siteName || 'Proof House'} works inside your wallet app's own browser. Pick your wallet to open this page there:`;
    const ul = document.createElement('ul'); ul.className = 'wp-list';
    apps.forEach(([name, link]) => {
      const li = document.createElement('li');
      const a = document.createElement('a'); a.className = 'wp-opt'; a.href = link; a.rel = 'noopener';
      const i = document.createElement('span'); i.className = 'wp-icon'; i.textContent = name.slice(0, 1);
      const n = document.createElement('span'); n.textContent = name;
      a.append(i, n); li.append(a); ul.append(li);
    });
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'wp-opt wp-small'; copy.textContent = 'Another wallet: copy the link';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(href); copy.textContent = 'Copied ✓ paste it in your wallet browser'; } catch (_) { copy.textContent = href; }
    });
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'wp-cancel'; cancel.textContent = 'Close';
    cancel.addEventListener('click', () => d.close());
    d.onclose = null;
    d.append(t, p, ul, copy, cancel);
    d.showModal();
  }

  let wallet = null; // the provider this page uses once chosen
  let walletInfo = null; // { id, name, icon }
  let account = null;
  const changeHandlers = [];

  // The wallet chosen last, so a reload reconnects to it quietly (a convenience kept in this browser).
  const WALLET_KEY = 'ph-wallet';
  function remembered() { try { return localStorage.getItem(WALLET_KEY); } catch (_) { return null; } }
  function remember(id) { try { if (id) localStorage.setItem(WALLET_KEY, id); else localStorage.removeItem(WALLET_KEY); } catch (_) { /* storage off */ } }

  // Every installed browser wallet announces itself (EIP-6963): { info: { uuid, name, icon, rdns }, provider }.
  const announced = [];
  window.addEventListener('eip6963:announceProvider', (e) => {
    const d = e.detail;
    if (!d || !d.info || !d.provider) return;
    if (!announced.some((p) => p.info.uuid === d.info.uuid || (d.info.rdns && p.info.rdns === d.info.rdns))) {
      announced.push(d);
      if (!account && remembered() === (d.info.rdns || d.info.uuid)) connect(false).catch(() => {});
    }
  });

  // The wallets on offer: every announced one, or, when none announce, the one a page injects as window.ethereum
  // (older wallets and some in-app browsers).
  function choices() {
    const list = announced.map((d) => ({ id: d.info.rdns || d.info.uuid, name: d.info.name || 'Wallet', icon: d.info.icon, provider: d.provider }));
    if (!list.length && window.ethereum) {
      const e = window.ethereum;
      const name = e.isRabby ? 'Rabby' : e.isTrust || e.isTrustWallet ? 'Trust Wallet' : e.isRainbow ? 'Rainbow' : e.isPhantom ? 'Phantom'
        : e.isBraveWallet ? 'Brave Wallet' : e.isCoinbaseWallet ? 'Coinbase Wallet' : e.isMetaMask ? 'MetaMask' : 'Browser wallet';
      list.push({ id: 'injected', name, icon: null, provider: e });
    }
    if (WC) list.push({ id: 'walletconnect', name: 'WalletConnect · for a wallet on your phone', icon: WC_ICON, provider: null, lazy: true });
    return list;
  }

  // ---------- WalletConnect: phone wallets by QR code. Its code (self-hosted, one pinned file) loads only once
  // someone picks it, or on a page load that reconnects someone who did; nobody else ever fetches it. ----------
  const WC = cfg.walletConnect && cfg.walletConnect.projectId && cfg.walletConnect.script ? cfg.walletConnect : null;
  const WC_ICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28"><rect width="28" height="28" fill="#3B99FC"/><path d="M7.5 11.5c3.6-3.4 9.4-3.4 13 0M10.5 14.5c1.9-1.8 5.1-1.8 7 0M13 17.5h2" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/></svg>');
  let wcProvider = null;
  let wcLoading = null;
  function loadWalletConnect() {
    if (!wcLoading) {
      wcLoading = new Promise((resolve, reject) => {
        if (window.PHWalletConnect) { resolve(); return; }
        const s = document.createElement('script');
        s.src = WC.script;
        s.async = true;
        s.onload = () => (window.PHWalletConnect ? resolve() : reject(new UserError('WalletConnect did not load. Reload the page and try again.')));
        s.onerror = () => reject(new UserError('Could not load WalletConnect just now. Check your connection and try again.'));
        document.head.append(s);
      }).catch((e) => { wcLoading = null; throw e; });
    }
    return wcLoading;
  }
  async function walletConnectProvider() {
    if (wcProvider) return wcProvider;
    await loadWalletConnect();
    wcProvider = await window.PHWalletConnect.EthereumProvider.init({
      projectId: WC.projectId,
      optionalChains: [cfg.chainId],
      rpcMap: { [cfg.chainId]: cfg.rpcUrl },
      showQrModal: true,
      qrModalOptions: { themeMode: 'light' },
      telemetryEnabled: false, // no usage events sent to WalletConnect
      metadata: {
        name: cfg.siteName === 'the ARTIFACTS site' ? 'ARTIFACTS' : 'Proof House',
        description: 'Curated, fully on-chain art.',
        url: location.origin,
        icons: [],
      },
    });
    return wcProvider;
  }
  const discover = () => choices().length > 0;


  // One set of listeners per provider, each ignoring events once that provider is no longer the one in use (some
  // providers have no removeListener).
  const handlers = new WeakMap();
  function handlersFor(p) {
    if (!handlers.has(p)) {
      handlers.set(p, {
        accountsChanged: (a) => { if (p !== wallet) return; account = a && a[0] ? a[0].toLowerCase() : null; changed(); },
        chainChanged: () => { if (p === wallet) changed(); },
        disconnect: (err) => {
          if (p !== wallet) return;
          if (err && err.code === 1013) { // MetaMask reconnecting: ask again rather than logging out
            p.request({ method: 'eth_accounts' }).then((a) => { account = a && a[0] ? a[0].toLowerCase() : null; changed(); }, () => {});
            return;
          }
          account = null;
          changed();
        },
      });
    }
    return handlers.get(p);
  }
  function attach(p) {
    if (!p || !p.on) return;
    const h = handlersFor(p);
    Object.keys(h).forEach((ev) => p.on(ev, h[ev]));
  }
  function detach(p) {
    if (!p || !p.removeListener) return;
    const h = handlersFor(p);
    Object.keys(h).forEach((ev) => p.removeListener(ev, h[ev]));
  }

  let gen = 0; // bumped by every connect the person asks for; a slower quiet reconnect then gives way
  async function use(pick, interactive) {
    const g = interactive ? ++gen : gen;
    let provider = pick.provider;
    if (pick.lazy) {
      provider = await walletConnectProvider();
      if (!provider.session) {
        if (!interactive) return null; // nothing to restore
        try {
          await provider.connect(); // its QR code; resolves once the phone wallet approves
        } catch (_) {
          throw quietError('WalletConnect closed before a wallet connected.');
        }
      }
    }
    const accounts = await provider.request({ method: interactive ? 'eth_requestAccounts' : 'eth_accounts' });
    if (!interactive && (g !== gen || (wallet && wallet !== provider))) return account;
    const a = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0].toLowerCase() : null;
    if (!a) {
      if (interactive) throw new UserError(`${pick.name} did not share an account. Unlock it and try again.`);
      return null;
    }
    if (wallet !== provider) { detach(wallet); attach(provider); }
    wallet = provider;
    walletInfo = { id: pick.id, name: pick.name, icon: pick.icon };
    account = a;
    remember(pick.id);
    changed();
    return account;
  }

  let connecting = null; // the connect in progress, so a second click joins it instead of starting another
  function connect(interactive) {
    if (!interactive) return doConnect(false);
    if (!connecting) {
      connecting = doConnect(true).finally(() => { connecting = null; renderConnect(); });
      renderConnect();
    }
    return connecting;
  }
  async function doConnect(interactive) {
    if (READ_ONLY) {
      if (interactive) throw new UserError(READ_ONLY_TEXT);
      return null;
    }
    let list = choices();
    if (wallet && walletInfo) {
      const same = list.find((x) => x.provider === wallet) || { ...walletInfo, provider: wallet };
      return use(same, interactive);
    }
    if (!interactive) {
      const id = remembered();
      const pick = id && list.find((x) => x.id === id);
      return pick ? use(pick, false) : null;
    }
    const installed = () => list.filter((x) => !x.lazy);
    if (!installed().length) {
      // a wallet that injects late: ask once more before saying there is none
      window.dispatchEvent(new Event('eip6963:requestProvider'));
      await sleep(350);
      list = choices();
    }
    if (!installed().length && isPhone()) {
      // a phone browser with no wallet in it: its wallet app's own browser, or WalletConnect
      if (!WC) { openInWallet(); throw quietError('Open this page in your wallet app to connect.'); }
      list = [{ id: 'open-in-app', name: 'Open this page in your wallet app', icon: null, open: true }, ...list];
    }
    if (!list.length) {
      throw new UserError('No wallet found. Install a browser wallet such as MetaMask, Rabby or Coinbase Wallet, then reload this page.');
    }
    const pick = list.length === 1 ? list[0] : await choose(list);
    if (!pick) throw quietError('No wallet chosen.');
    if (pick.open) { openInWallet(); throw quietError('Open this page in your wallet app to connect.'); }
    return use(pick, true);
  }

  // Forget the wallet on this page; wallets that support it also drop this site's permission.
  async function disconnect() {
    const p = wallet;
    detach(p);
    wallet = null;
    walletInfo = null;
    account = null;
    remember(null);
    changed();
    if (p && p === wcProvider) p.disconnect().catch(() => {}); // ends the session on the phone too
    else if (p) p.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }).catch(() => { /* not every wallet supports it */ });
  }

  // ---------- the wallet chooser ----------

  // A fresh dialog each time: a closing dialog's 'close' event arrives a moment later, and must not reach the next one.
  let dialog = null;
  function dialogEl() {
    if (dialog) { if (dialog.open) dialog.close(); dialog.remove(); }
    dialog = document.createElement('dialog');
    dialog.className = 'wp';
    dialog.setAttribute('aria-labelledby', 'wp-title');
    document.body.append(dialog);
    return dialog;
  }
  const iconOk = (src) => typeof src === 'string' && /^data:image\/(svg\+xml|png|jpeg|webp|gif)[;,]/i.test(src);
  function walletRow(w, onPick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wp-opt';
    if (iconOk(w.icon)) { const img = document.createElement('img'); img.src = w.icon; img.alt = ''; img.width = 28; img.height = 28; b.append(img); }
    else { const i = document.createElement('span'); i.className = 'wp-icon'; i.textContent = (w.name || '?').slice(0, 1).toUpperCase(); b.append(i); }
    const n = document.createElement('span'); n.textContent = w.name; b.append(n);
    b.addEventListener('click', () => onPick(w));
    return b;
  }
  // Resolves to the chosen wallet, or null when closed.
  function choose(list) {
    return new Promise((resolve) => {
      const d = dialogEl();
      d.textContent = '';
      const t = document.createElement('p'); t.id = 'wp-title'; t.className = 'wp-title'; t.textContent = 'Connect a wallet';
      const ul = document.createElement('ul'); ul.className = 'wp-list';
      let done = false;
      const finish = (w) => { if (done) return; done = true; if (d.open) d.close(); resolve(w); };
      list.forEach((w) => { const li = document.createElement('li'); li.append(walletRow(w, finish)); ul.append(li); });
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'wp-cancel'; cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => finish(null));
      d.append(t, ul, cancel);
      d.onclose = () => finish(null);
      d.showModal();
    });
  }
  // When connected: who and with what, and Disconnect or Switch wallet.
  function accountPanel() {
    const d = dialogEl();
    d.textContent = '';
    const t = document.createElement('p'); t.id = 'wp-title'; t.className = 'wp-title'; t.textContent = walletInfo ? `Connected with ${walletInfo.name}` : 'Connected';
    const a = document.createElement('p'); a.className = 'wp-account'; a.textContent = account;
    const acts = document.createElement('div'); acts.className = 'wp-acts';
    const mk = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'wp-opt wp-small'; b.textContent = label; b.addEventListener('click', fn); acts.append(b); };
    mk('Disconnect', async () => { d.close(); await disconnect(); });
    if (choices().length > 1) mk('Switch wallet', async () => { d.close(); await disconnect(); try { await connect(true); } catch (e) { showMessage(friendly(e), 'error'); } });
    mk('Close', () => d.close());
    d.onclose = null;
    d.append(t, a, acts);
    d.showModal();
  }

  function changed() {
    renderConnect();
    changeHandlers.forEach((f) => f());
  }

  // A wallet's chain id: browser wallets answer in hex ("0xaa36a7"), WalletConnect with a plain number (11155111).
  const asChainId = (v) => (typeof v === 'number' ? v : typeof v === 'string' ? (/^0x/i.test(v) ? parseInt(v, 16) : parseInt(v, 10)) : NaN);
  const onChainNow = async () => asChainId(await wallet.request({ method: 'eth_chainId' })) === cfg.chainId;
  async function ensureChain() {
    if (await onChainNow()) return;
    const switchTo = () => wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] });
    try {
      await switchTo();
    } catch (e) {
      if (errCodes(e).includes(4902) && cfg.addChain) {
        await wallet.request({ method: 'wallet_addEthereumChain', params: [cfg.addChain] });
        await switchTo().catch(() => {}); // some wallets add the network without switching to it
      } else if (errCodes(e).includes(4200)) {
        throw new UserError(`Switch your wallet to ${cfg.chainName} yourself, then try again: this wallet can't switch from here.`);
      } else throw e;
    }
    for (let i = 0; i < 12; i++) { // mobile wallets can take a moment to report the new network
      if (await onChainNow()) return;
      await sleep(250);
    }
    throw new UserError(`Switch your wallet to ${cfg.chainName}, then try again.`);
  }

  // Checked again right before every transaction: the network and account the purchase started on.
  async function guard(buyer) {
    const [chainHex, accounts] = await Promise.all([
      wallet.request({ method: 'eth_chainId' }),
      wallet.request({ method: 'eth_accounts' }),
    ]);
    const now = accounts && accounts[0] ? accounts[0].toLowerCase() : null;
    if (!now) throw new UserError('Your wallet is locked. Unlock it, then try again.');
    if (asChainId(chainHex) !== cfg.chainId || now !== buyer) {
      throw new UserError('Your wallet switched network or account, so this stopped before sending anything.');
    }
  }

  async function send(buyer, to, sig, args, value) {
    return sendData(buyer, to, encodeCall(sig, args), value);
  }

  // The same, with calldata the caller encoded itself (for dynamic types such as strings).
  async function sendData(buyer, to, data, value) {
    if (READ_ONLY) throw new UserError(READ_ONLY_TEXT);
    await guard(buyer);
    const tx = { from: buyer, data, chainId: CHAIN_HEX };
    if (to) tx.to = to; // none: deploys a contract (the curator page's Chainlink probe)
    if (value) tx.value = '0x' + value.toString(16);
    const hash = await wallet.request({ method: 'eth_sendTransaction', params: [tx] });
    if (typeof hash !== 'string' || !TXHASH.test(hash)) {
      throw new UserError('Your wallet did not return a normal transaction hash, so this page cannot follow the purchase. Check your wallet for the result.');
    }
    return hash.toLowerCase();
  }

  // A personal_sign of a fixed text (the viewing-key message). Returns the 65-byte signature as hex.
  async function signMessage(signer, text) {
    if (READ_ONLY) throw new UserError(READ_ONLY_TEXT);
    await guard(signer);
    const hexText = '0x' + Array.from(utf8(text), (b) => b.toString(16).padStart(2, '0')).join('');
    const raw = await wallet.request({ method: 'personal_sign', params: [hexText, signer] });
    if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(raw)) {
      throw new UserError('Your wallet returned a signature this page cannot use. Viewing keys need an ordinary wallet account.');
    }
    const sig = canonical(raw);
    // The key is derived from this signature, so it must be the account's own, and the same every time: recover the
    // signer in this page (sealcrypto.js) and refuse anything else. The signature is never sent anywhere, not even to
    // the RPC: anyone holding it could remake the viewing keys.
    const prefixed = utf8(`\x19Ethereum Signed Message:\n${utf8(text).length}${text}`);
    const digest = toHex(keccak256(prefixed));
    const Seal = window.ProofHouseSeal;
    const recovered = Seal && Seal.recoverAddress ? (Seal.recoverAddress(digest, sig) || '').toLowerCase() : null;
    if (recovered !== null && recovered !== signer.toLowerCase()) {
      throw new UserError("This wallet signs in a way a viewing key can't be made from here (a smart-contract or shared-key wallet). Use an ordinary account, or make a viewing key as agents.md describes.");
    }
    return sig;
  }
  // One form per signature: v as 27 or 28, and the low s (EIP-2), so a wallet that returns the other valid form still
  // derives the same key.
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  function canonical(raw) {
    const r = raw.slice(2, 66);
    let s = BigInt('0x' + raw.slice(66, 130));
    let v = parseInt(raw.slice(130, 132), 16);
    if (v < 27) v += 27;
    if (s > N / 2n) { s = N - s; v = v === 27 ? 28 : 27; }
    return '0x' + r + s.toString(16).padStart(64, '0') + v.toString(16);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Returns the receipt, or null after the timeout. `stop` may end the wait early with a message.
  async function waitFor(hash, stop) {
    const start = Date.now();
    let seen = null; // { from, nonce } once the transaction shows up
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
      if (n % 6 === 0) { // about every 15 seconds: is it still there?
        const tx = await rpc('eth_getTransactionByHash', [hash]).catch(() => undefined);
        if (tx && tx.from) seen = { from: tx.from, nonce: Number(BigInt(tx.nonce)) };
        else if (tx === null && seen) {
          const next = Number(BigInt(await rpc('eth_getTransactionCount', [seen.from, 'latest']).catch(() => '0x0')));
          if (next > seen.nonce) throw new UserError("This transaction was replaced in your wallet (sped up or cancelled), so this page can't follow it. Check your wallet's activity, then reload this page.");
        } else if (tx === null && !seen && Date.now() - start > 180000) {
          throw new UserError("Your wallet sent this in a way this page can't follow. Check your wallet's activity, then reload this page.");
        }
      }
      await sleep(2500);
    }
    return null;
  }

  // The 4-byte error a contract refused with ('' if none): pages map their own contract's errors by it, since
  // friendly() words the common ones itself.
  function errorSelector(e) {
    const d = errData(e);
    return typeof d === 'string' && /^0x[0-9a-fA-F]{8}/.test(d) ? d.slice(0, 10).toLowerCase() : '';
  }

  function friendly(e) {
    if (e instanceof UserError) return e.message;
    const codes = errCodes(e);
    const text = errText(e) || String(e);
    if (e && e.quiet) return e.message;
    if (codes.some((c) => c === 4001 || c === 5000 || c === 'ACTION_REJECTED') || /user (rejected|denied|cancel)|rejected by (the )?user|request rejected|user cancel/i.test(text)) {
      return 'You cancelled in your wallet.';
    }
    if (codes.includes(4100)) return "Your wallet is locked or hasn't connected this site. Unlock it and connect again.";
    if (codes.includes(4200)) return `Your wallet can't do that here. Switch it to ${cfg.chainName} and try again.`;
    if (codes.includes(4900) || codes.includes(4901)) return `Your wallet has lost its connection to the network. Reconnect it, or switch to ${cfg.chainName}.`;
    if (codes.includes(-32002)) return 'Your wallet already has a request waiting. Open it to continue.';
    if (/insufficient funds/i.test(text)) return 'Not enough ETH in this wallet to cover the price and gas.';
    if (isRevert(e)) {
      const reason = revertReason(errData(e)) || [e.data && e.data.message, e.message]
        .map((t) => ((t || '').match(/revert(?:ed)?:?\s*([^.]+)/i) || [])[1]).find(Boolean);
      return `The contract refused${reason ? `: ${reason.trim()}` : ''}.`;
    }
    const detail = (e && e.data && e.data.message) || (e && e.message);
    if (detail && !/^internal json-rpc error\.?$/i.test(detail)) return detail;
    if (detail) return 'Your wallet reported an error. Try again, or check your wallet.';
    try { return typeof e === 'object' ? JSON.stringify(e).slice(0, 160) : String(e); } catch (_) { return 'Something went wrong. Try again.'; }
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

  // ---------- connect buttons (every page) ----------

  // Pages that show their own status line set this; elsewhere outcomes appear as a corner notice.
  let showMessage = (text, tone) => { if (tone === 'error' || tone === 'ok') toast(text, tone); };
  const connectButtons = Array.from(document.querySelectorAll('[data-connect]'));
  function renderConnect() {
    connectButtons.forEach((b) => {
      b.textContent = account ? short(account) : connecting ? 'Connecting…' : 'Connect';
      b.title = account ? `Connected${walletInfo ? ` with ${walletInfo.name}` : ''}: ${account}` : 'Connect a wallet';
    });
  }
  connectButtons.forEach((b) => b.addEventListener('click', async () => {
    if (account) { accountPanel(); return; }
    try {
      await connect(true);
    } catch (e) {
      if (e && e.quiet) { renderConnect(); return; }
      const text = friendly(e);
      b.textContent = discover() ? 'Not connected' : 'No wallet';
      b.title = text;
      showMessage(text, 'error');
      setTimeout(renderConnect, 3000);
    }
  }));
  // Ask the installed wallets to announce themselves, now that everything they may trigger is set up.
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  connect(false).catch(() => {});

  // Read-only on screen: a bar under the header; [data-ro-hide] controls are hidden (styles.css), and each
  // [data-ro-note] control is hidden with its note shown in its place; [data-ro-text] swaps a label.
  if (READ_ONLY) {
    document.documentElement.setAttribute('data-read-only', '');
    const bar = document.createElement('p');
    bar.className = 'read-only-bar';
    bar.setAttribute('role', 'note');
    bar.textContent = 'Read-only for now · Look around freely: nothing can be bought, bid on, listed, brokered or submitted yet';
    const head = document.querySelector('header');
    if (head) head.after(bar); else document.body.prepend(bar);
    document.querySelectorAll('[data-ro-note]').forEach((el) => {
      const note = document.createElement('p');
      note.className = 'ro-note';
      note.textContent = el.dataset.roNote;
      el.before(note);
    });
    document.querySelectorAll('[data-ro-text]').forEach((el) => { el.textContent = el.dataset.roText; });
  }

  // EIP-55: the capital letters of an address are a checksum of it.
  function toChecksum(a) {
    const lower = a.slice(2).toLowerCase();
    const h = toHex(keccak256(utf8(lower))).slice(2);
    return '0x' + Array.from(lower, (ch, i) => (parseInt(h[i], 16) >= 8 ? ch.toUpperCase() : ch)).join('');
  }

  // ---------- the house's own dialogs and notices, in place of the browser's confirm and alert ----------

  const explorerUrl = (kind, id) => (cfg.explorer && /^https:\/\//.test(cfg.explorer) ? `${cfg.explorer}/${kind}/${id}` : null);
  const make = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  // Resolves true when confirmed. o: { title, body, points: [...], confirm, cancel, danger, check }. A danger dialog is
  // for what can't be undone: its button stays off until the box is ticked, and the cancel button has the focus.
  function ask(o) {
    return new Promise((resolve) => {
      const d = make('dialog', `wp ask${o.danger ? ' ask-danger' : ''}`);
      d.setAttribute('aria-labelledby', 'ask-title');
      const t = make('p', 'wp-title', o.title); t.id = 'ask-title';
      d.append(t);
      if (o.body) d.append(make('p', 'ask-body', o.body));
      if (o.points && o.points.length) { const ul = make('ul', 'ask-points'); o.points.forEach((x) => ul.append(make('li', null, x))); d.append(ul); }
      const no = make('button', 'ask-no', o.cancel || 'Cancel'); no.type = 'button';
      const yes = make('button', 'ask-yes', o.confirm || 'Continue'); yes.type = 'button';
      if (o.danger) {
        const lab = make('label', 'ask-check');
        const box = make('input'); box.type = 'checkbox';
        lab.append(box, make('span', null, o.check || 'I understand this cannot be undone.'));
        yes.disabled = true;
        box.addEventListener('change', () => { yes.disabled = !box.checked; });
        d.append(lab);
      }
      const acts = make('div', 'ask-acts'); acts.append(no, yes); d.append(acts);
      let done = false;
      const finish = (v) => { if (done) return; done = true; if (d.open) d.close(); d.remove(); resolve(v); };
      yes.addEventListener('click', () => finish(true));
      no.addEventListener('click', () => finish(false));
      d.addEventListener('close', () => finish(false));
      d.addEventListener('click', (ev) => { // a click on the backdrop, outside the box, cancels
        if (ev.target !== d) return;
        const r = d.getBoundingClientRect();
        if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) finish(false);
      });
      document.body.append(d);
      d.showModal();
      (o.danger ? no : yes).focus();
    });
  }

  // A notice in the corner for an outcome (tone 'ok' or 'error'), with its transaction when there is one. The same
  // text twice within half a minute shows once.
  let toastBox = null;
  let lastToast = { text: '', at: 0 };
  // `mirror`: the page already says this in its own status line, which screen readers hear, so the toast is for the
  // eyes only (not announced twice).
  function toast(text, tone, hash, mirror) {
    if (!text || (text === lastToast.text && Date.now() - lastToast.at < 30000)) return;
    lastToast = { text, at: Date.now() };
    if (!toastBox) { toastBox = make('div', 'toasts'); toastBox.setAttribute('role', 'status'); toastBox.setAttribute('aria-live', 'polite'); document.body.append(toastBox); }
    const t = make('div', `toast${tone ? ` toast-${tone}` : ''}`);
    const m = make('p', null, text);
    const href = hash && explorerUrl('tx', hash);
    if (href) { const a = make('a', null, 'View transaction'); a.href = href; a.target = '_blank'; a.rel = 'noopener'; m.append(' ', a); }
    const x = make('button', 'toast-x', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Dismiss');
    const go = () => { t.classList.add('out'); setTimeout(() => t.remove(), 200); };
    x.addEventListener('click', go);
    t.append(m, x);
    if (mirror) { t.setAttribute('aria-hidden', 'true'); t.querySelectorAll('a, button').forEach((el) => { el.tabIndex = -1; }); }
    toastBox.append(t);
    while (toastBox.children.length > 3) toastBox.firstChild.remove();
    setTimeout(go, tone === 'error' ? 12000 : 7000);
  }
  // What the pages pass on from their status lines: outcomes only (done, or refused), never a background read retrying.
  const QUIET = /^(Could not read|No contract answered|No Proof House contracts|No Broker Pass contract)/;
  function notify(text, tone, hash) {
    if ((tone === 'ok' || tone === 'error') && !QUIET.test(text || '')) toast(text, tone, hash, true);
  }

  // For the other pages (curator.js): the same wallet, reads and checks the piece page uses.
  // The header's Marketplace link: the ARTIFACTS market's address for this deployment (this Mac's copy while testing).
  const marketUrl = (((cfg.drops || {}).artifacts || {}).market) || '';
  if (marketUrl) document.querySelectorAll('[data-market-link]').forEach((a) => { a.href = marketUrl; });

  window.ProofHouseWallet = Object.freeze({
    cfg,
    readOnly: READ_ONLY,
    ZERO,
    ADDR,
    connect,
    disconnect,
    walletName: () => (walletInfo ? walletInfo.name : null),
    ensureChain,
    account: () => account,
    onChange: (f) => { changeHandlers.push(f); },
    setMessage: (f) => { showMessage = f; },
    rpc,
    logs,
    keyScheme,
    encodeCall,
    keccakHex: (text) => toHex(keccak256(utf8(text))),
    keccakBytesHex: (bytes) => toHex(keccak256(bytes)),
    sendData,
    signMessage,
    units,
    read,
    send,
    waitFor,
    friendly,
    errorSelector,
    short,
    toChecksum,
    explorer: explorerUrl,
    ask,
    toast,
    notify,
  });

})();
