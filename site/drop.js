// Proof House: a drop page (drops/<slug>.html). Reads the drop's sale, its collection's public traits and its
// auction from the chain, and sends the buyer's transactions (mint, claim, bid) through the wallet layer in mint.js.
// Drop 001 is Artifacts: sealed editions drawn by Chainlink VRF, plus THE SOURCE's auction.
(function () {
  'use strict';
  const W = window.ProofHouseWallet;
  const page = document.querySelector('[data-drop-page]');
  if (!W || !page) return;

  const cfg = W.cfg;
  const slug = page.dataset.drop;
  const drop = (cfg.drops || {})[slug] || {};
  const A = drop.contracts || {};
  // Members of another collection may count as holders too (the contracts' member gate): its name and where to join.
  const MEMBERS = drop.members || { name: 'Cncptl Prspctv', url: 'https://cncptlprspctv.xyz/how' };
  const $ = (sel) => document.querySelector(sel);
  const lc = (a) => (a || '').toLowerCase();
  const pad3 = (n) => String(n).padStart(3, '0');
  const EDITIONS = 255;
  const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'; // same address on Ethereum and Sepolia
  const CLAIMS_PER_TX = 2; // editions per claimMany: each deploys a piece contract (see the claim button)
  const configured = ['factory', 'source', 'artHouse'].every((k) => W.ADDR.test(A[k] || '') && lc(A[k]) !== W.ZERO);

  const { strip } = window.ArtifactsPalettes; // public palette vocabulary (palettes.js)

  // ---------- ABI helpers for the dynamic returns mint.js does not decode ----------

  const word = (h, byte) => h.slice(byte * 2, byte * 2 + 64);
  const num = (h, byte) => Number(BigInt('0x' + (word(h, byte) || '0')));
  const hexToUtf8 = (hex) => new TextDecoder().decode(Uint8Array.from(hex.match(/../g) || [], (x) => parseInt(x, 16)));
  const pad32 = (n) => BigInt(n).toString(16).padStart(64, '0');

  async function call(to, data) {
    return W.rpc('eth_call', [{ to, data }, 'latest']);
  }

  function decodeUintArray(ret) {
    const h = (ret || '0x').slice(2);
    if (h.length < 128) return [];
    const at = num(h, 0);
    const n = num(h, at);
    return Array.from({ length: n }, (_, i) => num(h, at + 32 + i * 32));
  }

  function decodeBytes(ret) {
    const h = (ret || '0x').slice(2);
    if (h.length < 128) return new Uint8Array(0);
    const at = num(h, 0);
    const len = num(h, at);
    return Uint8Array.from(h.slice((at + 32) * 2, (at + 32 + len) * 2).match(/../g) || [], (x) => parseInt(x, 16));
  }

  function decodeAddressArray(ret) {
    const h = (ret || '0x').slice(2);
    if (h.length < 128) return [];
    const at = num(h, 0);
    const n = num(h, at);
    return Array.from({ length: n }, (_, i) => '0x' + word(h, at + 32 + i * 32).slice(24));
  }

  function decodeBytesLength(ret) {
    const h = (ret || '0x').slice(2);
    if (h.length < 128) return 0;
    return num(h, num(h, 0));
  }

  function decodeString(ret) {
    const h = (ret || '0x').slice(2);
    const at = num(h, 0);
    const len = num(h, at);
    return hexToUtf8(h.slice((at + 32) * 2, (at + 32 + len) * 2));
  }

  // traitsOf(uint256) returns (Traits{string title; string palette; uint8 colourCount; string direction})
  function decodeTraits(ret) {
    const h = (ret || '0x').slice(2);
    if (h.length < 64 * 5) return null;
    const t = num(h, 0);
    const str = (rel) => { const at = t + rel; const len = num(h, at); return hexToUtf8(h.slice((at + 32) * 2, (at + 32 + len) * 2)); };
    return { title: str(num(h, t)), palette: str(num(h, t + 32)), k: num(h, t + 64), direction: str(num(h, t + 96)) };
  }

  // Multicall3.aggregate3((address,bool,bytes)[]) with allowFailure, so 255 reads cost a few requests.
  const AGG3 = W.keccakHex('aggregate3((address,bool,bytes)[])').slice(0, 10);
  async function multicall(calls) {
    const tuples = calls.map(({ target, data }) => {
      const d = data.slice(2);
      const len = d.length / 2;
      return target.slice(2).toLowerCase().padStart(64, '0') + pad32(1) + pad32(0x60) + pad32(len) + d.padEnd(Math.ceil(len / 32) * 64, '0');
    });
    let off = calls.length * 32;
    const offsets = tuples.map((t) => { const o = pad32(off); off += t.length / 2; return o; }).join('');
    const ret = await call(MULTICALL3, AGG3 + pad32(0x20) + pad32(calls.length) + offsets + tuples.join(''));
    const h = ret.slice(2);
    const at = num(h, 0);
    const n = num(h, at);
    const base = at + 32;
    return Array.from({ length: n }, (_, i) => {
      const t = base + num(h, base + i * 32);
      const ok = BigInt('0x' + word(h, t)) !== 0n;
      const b = t + num(h, t + 32);
      const len = num(h, b);
      return { ok, data: '0x' + h.slice((b + 32) * 2, (b + 32 + len) * 2) };
    });
  }

  // "0.05" -> wei, exact; null when it is not a plain positive decimal with at most 18 places.
  function parseEth(s) {
    const m = /^\s*(\d*)(?:\.(\d{0,18}))?\s*$/.exec(s || '');
    if (!m || (!m[1] && !m[2])) return null;
    const v = BigInt(m[1] || '0') * 10n ** 18n + BigInt((m[2] || '').padEnd(18, '0') || '0');
    return v > 0n ? v : null;
  }
  const eth = (wei) => `${W.units(wei)} ETH`;

  // ---------- messages ----------

  function say(el, text, tone, hash) {

    W.notify(text, tone, hash);
    el.textContent = text;
    el.dataset.tone = tone || '';
    const href = hash && W.explorer('tx', hash);
    if (href) {
      el.append(' ');
      const a = document.createElement('a');
      a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'View transaction';
      el.append(a);
    }
  }
  const msg = $('[data-msg]');
  const srcMsg = $('[data-src-msg]');
  const revealMsg = $('[data-reveal-msg]');
  W.setMessage((text, tone) => say(msg, text, tone));

  $('[data-network]').textContent = cfg.chainName;
  document.querySelectorAll('[data-chain]').forEach((el) => { el.textContent = cfg.chainName; });

  // ---------- broker from a broker link ----------

  let broker = W.ZERO;
  try {
    const fromUrl = new URLSearchParams(location.search).get('broker');
    if (fromUrl && W.ADDR.test(fromUrl)) { broker = lc(fromUrl); sessionStorage.setItem('ph-broker', JSON.stringify(broker)); }
    else {
      const saved = JSON.parse(sessionStorage.getItem('ph-broker'));
      if (typeof saved === 'string' && W.ADDR.test(saved)) broker = lc(saved);
    }
  } catch (_) { /* storage off: no remembered broker */ }

  // ---------- state ----------

  const S = { sale: null, traits: {}, mine: [], editions: {}, pending: [], minted: 0, source: null };
  let busy = false;
  let qty = 1; // editions in the next mint

  // A read an older contract may not have: null instead of an error.
  const opt = (p) => p.catch(() => null);

  // Everything the sale panel needs, asked for at once (one batched round trip).
  async function readSale() {
    const f = A.factory;
    const me = W.account();
    const [[[price], [open], [sold], [piecesSet], [locked], [vrf]], perWalletR, brokerR, brokerOldR, gateR, holdR, phaseR, planR, endedR] = await Promise.all([
      Promise.all([
        W.read(f, 'price()(uint256)', []), W.read(f, 'saleOpen()(bool)', []), W.read(f, 'sold()(uint256)', []),
        W.read(f, 'piecesSet()(uint256)', []), W.read(f, 'locked()(bool)', []), W.read(f, 'vrfConfigured()(bool)', []),
      ]),
      // The wallet limit (older factories have none: one edition per purchase, no cap).
      opt(W.read(f, 'MAX_PER_WALLET()(uint256)', [])),
      // Pass holders and curator-approved wallets both count; older ledgers only know the approved list.
      broker !== W.ZERO ? opt(W.read(A.artHouse, 'isEligibleBroker(address)(bool)', [broker])) : null,
      broker !== W.ZERO ? opt(W.read(A.artHouse, 'brokers(address)(bool)', [broker])) : null,
      // Holders first (older factories have none): the window, its minimum, and whether this wallet qualifies.
      // (members: newer factories only)
      opt(Promise.all([W.read(f, 'gateEndsAt()(uint256)', []), W.read(f, 'gateSeconds()(uint64)', []), W.read(f, 'gateMinBalance()(uint256)', []),
        W.read(f, 'gateMember()(address)', []).catch(() => [W.ZERO])])),
      me ? opt(Promise.all([W.read(f, 'holdsToken(address)(bool)', [me]), W.read(f, 'holdsSeat(address)(bool)', [me]),
        W.read(f, 'isMember(address)(bool)', [me]).catch(() => [false])])) : null,
      // Mint phases (older factories have none): the most a wallet may hold right now, and when that rises.
      opt(W.read(f, 'currentPhase()(uint256,uint256)', [])),
      opt(Promise.all([
        W.read(f, 'saleOpenedAt()(uint64)', []), W.read(f, 'phase1Seconds()(uint64)', []), W.read(f, 'phase1Cap()(uint8)', []),
        W.read(f, 'phase2Seconds()(uint64)', []), W.read(f, 'phase2Cap()(uint8)', []),
      ])),
      // Ended for good (newer factories: endSale, and claimMany beside it); older ones have neither.
      opt(W.read(f, 'saleEnded()(bool)', [])),
    ]);
    const perWallet = perWalletR ? Number(perWalletR[0]) : null;
    const brokerOk = !!((brokerR || brokerOldR || [false])[0]);
    let gate = null;
    if (gateR) {
      const [[ends], [secs], [min], [member]] = gateR;
      const imdOk = !!(holdR && holdR[0][0]);
      const memberOk = !!(holdR && holdR[2][0]);
      // a member mints as an IMD holder does (buy, buyMany); a seat holder with neither, with its seat
      gate = { endsAt: Number(ends), seconds: Number(secs), min, members: !/^0x0{40}$/i.test(member), imdOk, memberOk, tokenOk: imdOk || memberOk, seatOk: !!(holdR && holdR[1][0]) };
    }
    const phase = phaseR ? { cap: Number(phaseR[0]), endsAt: Number(phaseR[1]) } : null;
    // The schedule, for the timer: when the limit rises (phases count from the first opening) and when the holders
    // window ends. Older factories have no phases.
    const steps = [];
    let plan = null;
    if (planR) {
      const [[opened], [p1s], [p1c], [p2s], [p2c]] = planR;
      plan = { t0: Number(opened), p1s: Number(p1s), p1c: Number(p1c), p2s: Number(p2s), p2c: Number(p2c) };
      const t0 = plan.t0, a = t0 + plan.p1s, b = a + plan.p2s, max = perWallet || 5;
      if (t0 && plan.p1s) steps.push({ at: a, cap: plan.p2s ? plan.p2c : max });
      if (t0 && plan.p2s) steps.push({ at: b, cap: max });
    }
    if (gate && gate.endsAt) steps.push({ at: gate.endsAt, open: true });
    const ended = !!(endedR && endedR[0]);
    const canClaimMany = !!endedR;
    S.sale = { price, open, sold: Number(sold), piecesSet: Number(piecesSet), locked, vrf, brokerOk, perWallet, gate, phase, steps, plan, ended, canClaimMany };
  }

  // Once the factory is locked the traits can never change, so this browser keeps them and skips the read next visit.
  const TRAITS_KEY = `ph-traits:${lc(A.factory)}`;
  try {
    const kept = JSON.parse(localStorage.getItem(TRAITS_KEY) || 'null');
    if (kept && typeof kept === 'object') Object.assign(S.traits, kept);
  } catch (_) { /* none kept */ }
  async function readTraits() {
    if (!S.sale || S.sale.piecesSet === 0) return;
    const ids = Array.from({ length: EDITIONS }, (_, i) => i + 1).filter((id) => !S.traits[id] || !S.sale.locked);
    if (!ids.length) return;
    await Promise.all(Array.from({ length: Math.ceil(ids.length / 64) }, (_, k) => ids.slice(k * 64, k * 64 + 64)).map(async (batch) => {
      const res = await multicall(batch.map((id) => ({ target: A.factory, data: W.encodeCall('traitsOf(uint256)', [id]) })));
      res.forEach((r, j) => { const t = r.ok && decodeTraits(r.data); if (t && t.title) S.traits[batch[j]] = t; });
    }));
    if (S.sale.locked && Object.keys(S.traits).length === EDITIONS) {
      try { localStorage.setItem(TRAITS_KEY, JSON.stringify(S.traits)); } catch (_) { /* private mode */ }
    }
  }

  async function readMine() {
    const me = W.account();
    if (!me) { S.mine = []; S.minted = 0; return; }
    const [list, mintedR, [viewingKey]] = await Promise.all([
      call(A.factory, W.encodeCall('editionsOf(address)', [me])),
      S.sale && S.sale.perWallet ? opt(W.read(A.factory, 'mintedBy(address)(uint256)', [me])) : null,
      W.read(A.factory, 'viewingKeyOf(address)(bytes32)', [me]),
    ]);
    S.mine = decodeUintArray(list);
    S.minted = mintedR ? Number(mintedR[0]) : S.mine.length; // older factories: the drawn count
    S.viewingKey = viewingKey;
    if (S.codeFor !== me) {
      // a Safe or another smart-contract wallet can't give the signature a viewing key is made from (an EIP-7702
      // account still signs as an ordinary wallet)
      const code = await W.rpc('eth_getCode', [me, 'latest']).catch(() => '0x');
      S.contractWallet = !!code && code !== '0x' && !/^0xef0100/i.test(code);
      S.codeFor = me;
    }
    await Promise.all(S.mine.map(async (e) => {
      const [[piece], keyRet] = await Promise.all([
        W.read(A.factory, 'pieceContract(uint256)(address)', [e]),
        call(A.factory, W.encodeCall('wrappedKeyOf(uint256)', [e])),
      ]);
      const claimed = lc(piece) !== W.ZERO;
      const owner = claimed ? lc((await W.read(piece, 'ownerOf(uint256)(address)', [1]))[0]) : me;
      S.editions[e] = { piece: lc(piece), keyPosted: decodeBytesLength(keyRet) > 0, owner };
    }));
    await readSafetyNets(me); // after the editions, so what it adds (when each was drawn) stays on them
  }

  // The safety nets (factories from v13): an edition whose key is KEY_WAIT late can be claimed without it, and a draw
  // Chainlink never answers can be asked again (VRF_RETRY_BLOCKS) or drawn from a future block (FALLBACK_BLOCKS).
  const REREQUESTED = W.keccakHex('Rerequested(uint256,uint256,address)');
  async function readSafetyNets(me) {
    if (S.nets === undefined) {
      const [kw, rb, fb] = await Promise.all([
        opt(W.read(A.factory, 'KEY_WAIT()(uint256)', [])),
        opt(W.read(A.factory, 'VRF_RETRY_BLOCKS()(uint256)', [])),
        opt(W.read(A.factory, 'FALLBACK_BLOCKS()(uint256)', [])),
      ]);
      S.nets = kw && fb ? { keyWait: Number(kw[0]), retry: rb ? Number(rb[0]) : 0, fallback: Number(fb[0]) } : null;
    }
    S.stuck = [];
    if (!S.nets) return;
    const waitingKey = S.mine.filter((e) => { const st = S.editions[e] || {}; return !st.keyPosted && (!st.piece || st.piece === W.ZERO); });
    const ats = await Promise.all(waitingKey.map((e) => opt(W.read(A.factory, 'editionAssignedAt(uint256)(uint64)', [e]))));
    waitingKey.forEach((e, i) => { if (ats[i] && S.editions[e]) S.editions[e].assignedAt = Number(ats[i][0]); });
    if (S.minted <= S.mine.length || !drop.deployBlock) return;
    // this wallet's draws still unanswered: its purchases and re-requests, minus the ones re-requested away
    const topicMe = '0x' + me.slice(2).padStart(64, '0');
    const [bought, again, latest] = await Promise.all([
      W.logs({ address: A.factory, topics: [PURCHASED, topicMe] }, drop.deployBlock),
      W.logs({ address: A.factory, topics: [REREQUESTED, null, null, topicMe] }, drop.deployBlock),
      W.rpc('eth_blockNumber', []),
    ]);
    const ids = new Set(bought.map((l) => BigInt('0x' + l.data.slice(2, 66))));
    again.forEach((l) => { ids.delete(BigInt(l.topics[1])); ids.add(BigInt(l.topics[2])); });
    const list = Array.from(ids);
    const rows = await Promise.all(list.map((id) => Promise.all([
      W.read(A.factory, 'requestEdition(uint256)(uint256)', [id]),
      W.read(A.factory, 'requestBlock(uint256)(uint256)', [id]),
      W.read(A.factory, 'fallbackBlock(uint256)(uint256)', [id]),
      opt(W.read(A.factory, 'purchaseBlock(uint256)(uint256)', [id])), // the fallback counts from the purchase
    ])));
    S.blockNow = Number(BigInt(latest));
    S.stuck = list.map((id, i) => ({ id, edition: rows[i][0][0], at: Number(rows[i][1][0]), fb: Number(rows[i][2][0]), bought: rows[i][3] ? Number(rows[i][3][0]) : Number(rows[i][1][0]) }))
      .filter((r) => r.edition === 0n && r.at > 0).sort((a, b) => a.at - b.at);
  }

  async function readSource() {
    const s = A.source;
    const me = W.account();
    const [[open, settled, reserve, endTime, bidder, high], [locked], [piece], block, commitR, refundR, gateR, holdR] = await Promise.all([
      W.read(s, 'auctionState()(bool,bool,uint256,uint64,address,uint256)', []),
      W.read(s, 'locked()(bool)', []),
      W.read(s, 'pieceContract()(address)', []),
      W.rpc('eth_getBlockByNumber', ['latest', false]),
      // An encrypted SOURCE has a key commitment (the first Sepolia test contracts did not).
      opt(W.read(s, 'keyCommitment()(bytes32)', [])),
      me ? W.read(s, 'refunds(address)(uint256)', [me]) : null,
      // holders first, as for the editions
      opt(Promise.all([W.read(s, 'gateEndsAt()(uint256)', []), W.read(s, 'gateSeconds()(uint64)', []), W.read(s, 'gateMinBalance()(uint256)', []),
        W.read(s, 'gateMember()(address)', []).catch(() => [W.ZERO])])),
      me ? opt(Promise.all([W.read(s, 'holdsSeat(address)(bool)', [me]), W.read(s, 'holdsToken(address)(bool)', [me]),
        W.read(s, 'isMember(address)(bool)', [me]).catch(() => [false])])) : null,
    ]);
    // The auction ends by the chain's clock, not this computer's.
    const chainNow = block && block.timestamp ? Number(BigInt(block.timestamp)) : Math.floor(Date.now() / 1000);
    const sealed = !!(commitR && !/^0x0+$/.test(commitR[0]));
    let revealed = false;
    let owner = W.ZERO;
    let myViewingKey = false;
    let keyPosted = false;
    if (lc(piece) !== W.ZERO) {
      const mineToCheck = sealed && me;
      const [[rev], [own], vkR, wrapped] = await Promise.all([
        W.read(piece, 'revealed()(bool)', []), W.read(piece, 'ownerOf(uint256)(address)', [1]),
        mineToCheck ? W.read(piece, 'viewingKeyOf(address)(bytes32)', [me]) : null,
        mineToCheck ? call(piece, W.encodeCall('wrappedKey()', [])) : null,
      ]);
      revealed = rev;
      owner = own;
      if (mineToCheck && lc(owner) === me && !revealed) {
        myViewingKey = !/^0x0+$/.test(vkR[0]);
        keyPosted = decodeBytesLength(wrapped) > 0;
      }
    }
    const refund = refundR ? refundR[0] : 0n;
    const prevEnd = S.source && S.source.endTime;
    let gate = null;
    if (gateR) {
      const [[ends], [secs], [min], [member]] = gateR;
      gate = { endsAt: Number(ends), seconds: Number(secs), min, members: !/^0x0{40}$/i.test(member), ok: !!(holdR && (holdR[0][0] || holdR[1][0] || holdR[2][0])) };
    }
    S.source = { open, settled, reserve, endTime: Number(endTime), bidder: lc(bidder), high, locked, piece: lc(piece), revealed, owner: lc(owner), refund, chainNow, readAt: Date.now(), sealed, myViewingKey, keyPosted, gate };
    // A bid in the last 10 minutes moves the end; say so once.
    if (prevEnd && open && !settled && S.source.endTime > prevEnd) {
      say(srcMsg, `A late bid moved the end to ${new Date(S.source.endTime * 1000).toLocaleTimeString()}.`);
    }
  }

  // Bid history from the contract's Bid events, scanned in windows from the deployment block.
  const BID = W.keccakHex('Bid(address,address,uint256,uint64)');
  let bids = [];
  let bidsUnread = false; // the history could not be read (an RPC refused the log range): never shown as "no bids"
  const blockTimes = {};
  async function readBids() {
    if (!drop.deployBlock) return;
    const logs = await W.logs({ address: A.source, topics: [BID] }, drop.deployBlock);
    bids = logs.map((l) => ({ bidder: '0x' + l.topics[1].slice(26), amount: BigInt('0x' + l.data.slice(2, 66)), block: l.blockNumber, tx: l.transactionHash }));
    bidsUnread = false;
    await Promise.all(bids.slice(-12).filter((b) => !blockTimes[b.block]).map(async (b) => {
      const blk = await W.rpc('eth_getBlockByNumber', ['0x' + b.block.toString(16), false]);
      blockTimes[b.block] = Number(BigInt(blk.timestamp));
    }));
  }

  // One read at a time: a refresh asked for while one runs waits for it, then runs once more (the wallet or the
  // chain may have changed meanwhile), however many asked.
  let reading = null;
  let again = false;
  function refresh() {
    if (reading) { again = true; return reading; }
    reading = (async () => {
      do { again = false; await readOnce(); } while (again);
    })().finally(() => { reading = null; });
    return reading;
  }
  async function readOnce() {
    if (!configured) { renderUnconfigured(); return; }
    try {
      await Promise.all([readSale(), readSource()]);
      render(); // show the sale and the auction now; the archive and your editions follow
      await Promise.all([readTraits(), readMine(), readBids().catch(() => { bidsUnread = !bids.length; })]);
      clearReadError();
    } catch (e) {
      if (!busy) say(msg, e.code === 'NO_CODE' ? `No contract answered on ${cfg.chainName}. Check deployment.js.` : 'Could not read the chain just now. Retrying…', 'error');
    }
    render();
  }
  // A "could not read" note goes once a read works again.
  function clearReadError() {
    if (msg && /^(Could not read the chain|No contract answered)/.test(msg.textContent || '')) { msg.textContent = ''; msg.dataset.tone = ''; }
  }

  // ---------- render: mint ----------

  const mintBtn = $('[data-mint]');
  // ---------- holders first: a window, by the chain's clock, when only holders (seat, IMD, members) may buy ----------
  const chainNowS = () => (S.source ? S.source.chainNow + Math.floor((Date.now() - S.source.readAt) / 1000) : Math.floor(Date.now() / 1000));
  const gateLive = (g) => !!(g && g.endsAt && chainNowS() < g.endsAt);
  const gateWho = (g) => {
    const ways = ['an identity.md seat', ...(g.min > 0n ? [`${W.units(g.min)} IMD`] : []), ...(g.members ? [`${MEMBERS.name} membership (any points)`] : [])];
    return ways.length > 1 ? `${ways.slice(0, -1).join(', ')} or ${ways[ways.length - 1]}` : ways[0];
  };
  const gateUntil = (t) => new Date(t * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  // The next change to the sale's rules: the limit rising, or the holders window ending (both, if at once).
  function nextStep(s) {
    const now = chainNowS();
    const ahead = (s.steps || []).filter((x) => x.at > now).sort((x, y) => x.at - y.at);
    if (!ahead.length) return null;
    const same = ahead.filter((x) => x.at === ahead[0].at);
    const rise = same.find((x) => x.cap);
    return { at: ahead[0].at, label: same.some((x) => x.open) ? 'Public in' : `Limit rises to ${rise.cap} in` };
  }
  let shownStep = 0; // when the timer's step happens (0: no timer)
  const noViewingKey = () => !S.viewingKey || /^0x0+$/.test(S.viewingKey);

  // The mint phases start to finish: who may mint and up to how many, per stretch of time (seconds from the opening).
  function schedule(s) {
    const p = s.plan || { p1s: 0, p2s: 0 };
    const gs = s.gate ? s.gate.seconds : 0;
    const max = s.perWallet || 5;
    const capAt = (t) => (p.p1s && t < p.p1s ? p.p1c : p.p2s && t < p.p1s + p.p2s ? p.p2c : max);
    const cuts = [...new Set([0, p.p1s, p.p1s + p.p2s, gs])].filter((x, i) => i === 0 || x > 0).sort((x, y) => x - y);
    const out = [];
    cuts.forEach((from, i) => {
      const seg = { from, to: i + 1 < cuts.length ? cuts[i + 1] : null, cap: capAt(from), holders: from < gs };
      const last = out[out.length - 1];
      if (last && last.cap === seg.cap && last.holders === seg.holders) last.to = seg.to; else out.push(seg);
    });
    return out;
  }
  const span = (secs) => (secs % 3600 === 0 ? `${secs / 3600} hour${secs === 3600 ? '' : 's'}` : secs < 3600 ? `${Math.round(secs / 60)} min` : `${Math.floor(secs / 3600)}h ${Math.round((secs % 3600) / 60)}m`);
  const clockAt = (t) => new Date(t * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const timeAt = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const sameDay = (a, b) => new Date(a * 1000).toDateString() === new Date(b * 1000).toDateString();

  function renderSchedule(s) {
    const plan = schedule(s);
    const box = $('[data-sched]');
    box.hidden = plan.length < 2;
    if (box.hidden) return;
    const t0 = s.plan ? s.plan.t0 : 0;
    const now = chainNowS();
    // names: the first holders stretch is the Allowlist, any later one the Allowlist overflow, then Public
    const nameOf = (x, i) => (!x.holders ? 'Public' : plan.slice(0, i).some((y) => y.holders) ? 'Allowlist overflow' : 'Allowlist');
    setHtml($('[data-sched-list]'), plan.map((x, i) => {
      const start = t0 + x.from, end = x.to == null ? null : t0 + x.to;
      const state = !t0 ? '' : end != null && now >= end ? 'done' : now >= start ? 'now' : '';
      // a live countdown to what happens next (ticked every second below); clock times stay beside it, smaller
      const range = end == null ? `from ${clockAt(start)}` : `${clockAt(start)} to ${sameDay(start, end) ? timeAt(end) : clockAt(end)}`;
      const cd = (to, label) => `<b class="sched-cd" data-cd-to="${to}" data-cd-label="${label}">${label} ${fmtLeft(to - now)}</b>`;
      const when = !t0
        ? (end == null ? `after ${span(x.from)}` : `${i === 0 ? 'the first' : 'the next'} ${x.to - x.from === 3600 ? 'hour' : span(x.to - x.from)}`)
        : state === 'done' ? range
        : state === 'now' ? (end == null ? `<b class="sched-cd">open now</b> · since ${clockAt(start)}` : `${cd(end, 'ends in')} · until ${timeAt(end)}`)
        : `${cd(start, 'starts in')} · ${clockAt(start)}`;
      const tag = state === 'now' ? 'Now' : state === 'done' ? 'Done' : '';
      // each later phase says how many more it allows: "up to 3 per wallet (1 more)"
      const more = i > 0 && x.cap > plan[i - 1].cap ? ` (${x.cap - plan[i - 1].cap} more)` : '';
      return `<li class="sched-item${state ? ` is-${state}` : ''}"><span class="sched-n">${i + 1}</span><span class="sched-what"><b>${nameOf(x, i)}</b> · up to ${x.cap} per wallet${more}<span class="sched-when">${when}</span></span><span class="sched-tag">${tag}</span></li>`;
    }).join(''));
    const g = s.gate;
    $('[data-sched-note]').textContent = `${g && g.seconds ? `Allowlist: ${gateWho(g)} in the wallet. ` : ''}Limits count every edition a wallet, or a seat, has minted: "up to 3" means 3 in all.`;
  }
  const seatInput = $('[data-seat-input]');
  seatInput.addEventListener('input', () => renderMint());

  function renderMint() {
    const s = S.sale;
    if (!s) return;
    const remaining = s.ended ? 0 : EDITIONS - s.sold;
    $('[data-price]').textContent = s.price > 0n ? eth(s.price) : 'not set yet';
    $('[data-remaining]').textContent = s.ended ? `0 · ended at ${s.sold} of ${EDITIONS}` : `${remaining} / ${EDITIONS}`;
    const state = $('[data-sale-state]');
    const everOpened = s.plan ? s.plan.t0 > 0 : s.sold > 0;
    const status = s.ended ? 'Ended' : s.open ? (remaining ? 'Open' : 'Sold out') : everOpened ? 'Closed' : 'Not open yet';
    state.textContent = status;
    state.classList.toggle('on', s.open && remaining > 0);

    const steps = { pieces: s.piecesSet === EDITIONS, locked: s.locked, vrf: s.vrf, price: s.price > 0n, open: s.open };
    $('[data-ready]').querySelectorAll('li').forEach((li) => li.classList.toggle('done', !!steps[li.dataset.step]));
    $('[data-pieces-count]').textContent = `· ${s.piecesSet}/${EDITIONS}`;
    $('[data-ready]').hidden = s.open || s.ended;

    // How many this wallet may still mint: the current phase's limit (or the per-wallet limit) less what it has
    // bought, never more than is left.
    const ph = s.phase && s.open && s.phase.endsAt ? s.phase : null; // a phase with a limit below the maximum
    const limit = ph ? Math.min(ph.cap, s.perWallet || ph.cap) : s.perWallet;
    const me = W.account();
    const allowance = limit ? Math.max(0, Math.min(limit - (me ? S.minted : 0), remaining)) : (remaining ? 1 : 0);
    const nx = s.open && remaining > 0 ? nextStep(s) : null;
    shownStep = nx ? nx.at : 0;
    $('[data-next-row]').hidden = !nx;
    if (nx) { $('[data-next-label]').textContent = nx.label; $('[data-next]').textContent = fmtLeft(nx.at - chainNowS()); }
    $('[data-limit-row]').hidden = !limit;
    const forNow = ph ? ' for now' : '';
    if (limit) $('[data-limit]').textContent = me ? `${S.minted} minted, ${Math.max(0, limit - S.minted)} left${forNow}` : `up to ${limit}${forNow}`;
    const qtyBox = $('[data-qty]');
    qtyBox.hidden = !limit || !s.open || allowance === 0;
    qty = Math.max(1, Math.min(qty, allowance || 1));
    qtyBox.querySelectorAll('[data-q]').forEach((b) => {
      const n = Number(b.dataset.q);
      b.disabled = busy || n > allowance;
      b.setAttribute('aria-pressed', String(n === qty));
    });

    // Holders first: during the window a wallet mints with the IMD minimum or as a member, or with its seat's number.
    const g = s.gate;
    const gated = gateLive(g);
    renderSchedule(s);
    if (s.ended) $('[data-sched]').hidden = true;
    const seatPath = gated && !!me && !g.tokenOk && g.seatOk;
    $('[data-seat-row]').hidden = !(seatPath && s.open && allowance > 0);
    const seatOk = /^\d+$/.test(seatInput.value.trim());
    const shut = gated && !!me && !g.tokenOk && !g.seatOk;
    const note = $('[data-gate-note]');
    note.hidden = !(gated && s.open && remaining > 0);
    if (!note.hidden) {
      note.textContent = !me ? `Holders first until ${gateUntil(g.endsAt)}: connect a wallet holding ${gateWho(g)}. Everyone can mint after that.`
        : g.imdOk ? `You hold ${W.units(g.min)} IMD or more: you can mint now.`
        : g.memberOk ? `You're a ${MEMBERS.name} member: you can mint now.`
        : g.seatOk ? `You hold an identity.md seat: enter its number. Each seat mints ${ph ? `${ph.cap} for now and ` : ''}up to 5 editions in all, wherever it goes.`
        : `Holders first until ${gateUntil(g.endsAt)}. Hold ${gateWho(g)} to mint now; everyone can after that.`;
    }

    const can = s.open && allowance > 0 && !busy && !shut && !(seatPath && !seatOk);
    mintBtn.disabled = !can;
    const total = s.price * BigInt(qty);
    mintBtn.textContent = busy ? 'Working…'
      : s.ended ? `Sale ended · ${s.sold} editions in all`
      : !s.open ? 'Sale not open yet'
      : remaining === 0 ? 'Sold out'
      : allowance === 0 && ph ? `${limit} for now · more at ${gateUntil(ph.endsAt)}`
      : allowance === 0 ? `Wallet limit reached · ${limit} of ${limit}`
      : shut ? `Holders only until ${gateUntil(g.endsAt)}`
      : seatPath && !seatOk ? 'Enter your seat number'
      : qty === 1 ? `Mint 1 edition · ${eth(total)}` : `Mint ${qty} editions · ${eth(total)}`;

    $('[data-vk-note]').hidden = !(me && s.open && allowance > 0 && !shut && noViewingKey());

    const box = $('[data-broker]');
    box.hidden = !(broker !== W.ZERO && s.brokerOk);
    if (!box.hidden) $('[data-broker-addr]').textContent = W.short(broker);
  }

  // ---------- render: your editions ----------

  const SEAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10" rx="2.2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.3" r="1.5" fill="currentColor" stroke="none"/></svg>';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  // Redraw an element only when its markup changed, so focus survives the refreshes (every 20 s, 5 s near the end).
  function setHtml(el, html) {
    if (el.dataset.html === html) return;
    el.dataset.html = html;
    el.innerHTML = html;
  }

  // ---------- the viewing key: one step, and a bar that points to it from anywhere on the page ----------

  let vkNeeded = false;
  let vkInView = false;
  function vkBar(needed) {
    vkNeeded = needed;
    const bar = $('[data-vk-bar]');
    bar.hidden = !(vkNeeded && !vkInView);
    if (!bar.hidden) {
      const n = (S.mine || []).length;
      $('[data-vk-bar-text]').textContent = S.contractWallet
        ? 'Minted with a Safe? It needs a viewing key before its keys can be sent.'
        : n ? `Chainlink has drawn ${n === 1 ? 'your edition' : `your ${n} editions`}. Create your viewing key so ${n === 1 ? 'its key' : 'their keys'} can be sent to you.`
          : 'Your edition is being drawn. Create your viewing key so its key can be sent to you.';
    }
  }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => { vkInView = entries.some((en) => en.isIntersecting); vkBar(vkNeeded); }, { threshold: 0.6 })
      .observe($('[data-vk-callout]'));
  }
  function goToKey(ev) {
    ev.preventDefault();
    const box = $('[data-vk-callout]');
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    box.classList.remove('vk-flash');
    void box.offsetWidth; // restart the highlight
    box.classList.add('vk-flash');
    setTimeout(() => { const b = box.querySelector('[data-ed-vk], a'); if (b) b.focus({ preventScroll: true }); }, 500);
  }
  $('[data-vk-bar-go]').addEventListener('click', goToKey);
  document.addEventListener('click', (ev) => { if (ev.target.closest('[data-vk-jump]')) goToKey(ev); });

  function renderMine() {
    const me = W.account();
    const sec = $('[data-yours]');
    // Paid but not yet drawn: what this page sent, or (after a reload) what the chain says is bought but unassigned.
    const drawing = Math.max(S.pending.length, S.minted - S.mine.length);
    const total = S.mine.length + drawing;
    sec.hidden = !me || total === 0;
    if (sec.hidden) { vkBar(false); return; }
    $('[data-yours-addr]').textContent = W.short(me);
    $('[data-yours-count]').textContent = `${S.mine.length} drawn${drawing ? ` · ${drawing} drawing` : ''}`;
    // The three steps every edition goes through, with this wallet's editions counted at each; the first step that
    // has editions waiting is the one marked.
    const counts = { drawn: drawing, key: 0, view: 0, claimed: 0 };
    S.mine.forEach((e) => {
      const st = S.editions[e] || {};
      if (st.piece && st.piece !== W.ZERO) counts.claimed += 1;
      else if (st.keyPosted) counts.view += 1;
      else counts.key += 1;
    });
    // the four steps every edition goes through: drawn, this wallet's viewing key, its key, then view and claim
    const hasKey = !noViewingKey();
    const at = counts.drawn ? 'drawn' : (counts.key && !hasKey) ? 'vk' : counts.key ? 'key' : 'view';
    // no viewing key yet, with editions drawn or drawing: one clear step at the top of Yours, and a bar pointing to it
    const needKey = noViewingKey() && (counts.drawn + counts.key) > 0;
    $('[data-vk-callout]').hidden = !needKey;
    if (needKey) {
      const n = counts.key;
      $('[data-vk-callout-why]').textContent = n
        ? `Chainlink has drawn ${n === 1 ? 'your edition' : `your ${n} editions`}. ${n === 1 ? 'Its key' : 'Their keys'} can only be sent to a wallet with a viewing key, and keys go out in batches: make it now so you're in the next one.`
        : 'Chainlink is drawing your edition now. Make your viewing key meanwhile, so its key can be sent in the next batch.';
      const acts = S.contractWallet
        ? `<a class="btn btn-solid btn-sm" href="../safe.html?wallet=${esc(me)}">Make it on the Safe page →</a>`
        : `<button class="btn btn-solid btn-sm" type="button" data-ed-vk ${busy ? 'disabled' : ''}>Create your viewing key</button>`;
      if ($('[data-vk-callout-acts]').dataset.html !== acts) { $('[data-vk-callout-acts]').dataset.html = acts; $('[data-vk-callout-acts]').innerHTML = acts; }
      $('[data-vk-callout-how]').innerHTML = S.contractWallet
        ? 'This wallet is a smart-contract wallet (a Safe?), which can\'t give the one signature a viewing key is made from. The Safe page makes one for it instead.'
        : 'One signature (free) makes it in this browser, then one small transaction registers it. It covers every edition this wallet holds. <a href="../docs.html#keys">When do keys arrive?</a>';
    }
    vkBar(needKey);
    // a claimed edition is a review voice: point its holder at the Review page
    const ownClaimed = S.mine.some((e) => { const st = S.editions[e] || {}; return st.piece && st.piece !== W.ZERO && st.owner === me; });
    $('[data-yours-review]').hidden = !ownClaimed;
    const ready = S.mine.filter((e) => { const st = S.editions[e] || {}; return st.keyPosted && (!st.piece || st.piece === W.ZERO); });
    $('[data-claim-all]').hidden = ready.length < 2;
    if (ready.length >= 2) {
      $('[data-claim-all-btn]').textContent = `Claim all ${ready.length}`;
      $('[data-claim-all-btn]').disabled = busy;
      $('[data-claim-all-note]').textContent = S.sale && S.sale.canClaimMany
        ? 'One transaction deploys each one its own contract.'
        : 'One confirmation for each, one after another.';
    }
    const order = ['drawn', 'vk', 'key', 'view'];
    $('[data-flow]').querySelectorAll('[data-flow-step]').forEach((li) => {
      const step = li.dataset.flowStep;
      li.classList.toggle('is-now', step === at);
      // the viewing key is done once registered, whatever stage the editions are at
      li.classList.toggle('is-done', step === 'vk' ? hasKey : order.indexOf(step) < order.indexOf(at));
      li.querySelector('[data-flow-count]').textContent = step === 'drawn' ? (counts.drawn ? `${counts.drawn} drawing` : '')
        : step === 'vk' ? (hasKey ? 'done' : 'needed')
        : step === 'key' ? (counts.key ? (hasKey ? `${counts.key} waiting` : `${counts.key} on hold`) : '')
        : [counts.view ? `${counts.view} ready` : '', counts.claimed ? `${counts.claimed} claimed` : ''].filter(Boolean).join(', ');
    });
    const off = busy ? 'disabled' : '';
    // a draw Chainlink hasn't answered: ask again after ~25 hours, draw from a future block ~3 days after paying
    const drawAction = (r) => {
      if (!r || !S.nets) return '';
      const age = (S.blockNow || 0) - r.at;
      if (r.fb) {
        // a started draw's result stands: it finishes with its block's hash (kept ~27 hours), and only then starts again
        if (S.blockNow <= r.fb) return '<p class="hold-note wait">Drawing from a block just ahead… a minute or so.</p>';
        if (S.blockNow <= r.fb + 8191) return `<p class="hold-note">That block is in: finish the draw.</p><div class="hold-btns"><button class="btn btn-solid btn-sm" type="button" data-fb-finish="${r.id}" ${off}>Finish the draw</button></div>`;
        return `<p class="hold-note">That draw wasn't finished in time. Start it again.</p><div class="hold-btns"><button class="btn btn-solid btn-sm" type="button" data-fb-start="${r.id}" ${off}>Draw it now</button></div>`;
      }
      if ((S.blockNow || 0) - r.bought >= S.nets.fallback) return `<p class="hold-note">Chainlink hasn't answered in 3 days. Draw it from a block just ahead instead (two confirmations), or ask Chainlink again.</p><div class="hold-btns"><button class="btn btn-solid btn-sm" type="button" data-fb-start="${r.id}" ${off}>Draw it now</button><button class="btn btn-sm" type="button" data-rereq="${r.id}" ${off}>Ask Chainlink again</button></div>`;
      if (S.nets.retry && age >= S.nets.retry) return `<p class="hold-note">Chainlink hasn't answered in a day. Ask it again: your payment is safe, and you still get exactly one edition.</p><div class="hold-btns"><button class="btn btn-sm" type="button" data-rereq="${r.id}" ${off}>Ask Chainlink again</button></div>`;
      return '';
    };
    const cards = Array.from({ length: drawing }, (_, i) => {
      const act = drawAction((S.stuck || [])[i]);
      return `
      <div class="hold"><div class="aw">
        <div class="aw-tb"><span>ARTIFACTS <span class="aw-mu">#…</span></span><span class="aw-mu">DRAWING</span></div>
        <div class="aw-menu"><span>File</span><span>View</span><span>Run</span><span class="aw-sp"></span><span class="aw-mu">VRF</span></div>
        <div class="aw-seal">${SEAL}<span>DRAWING</span></div>
        <div class="aw-sb"><span>Chainlink VRF</span><span>about a minute</span></div>
      </div>${act ? `<div class="hold-act">${act}</div>` : ''}</div>`;
    });
    S.mine.forEach((e) => {
      const t = S.traits[e];
      const st = S.editions[e] || {};
      let action;
      const view = `<button class="btn btn-sm" type="button" data-ed-view="${e}" ${busy ? 'disabled' : ''}>View privately</button>`;
      if (st.piece && st.piece !== W.ZERO) {
        const href = W.explorer('address', st.piece);
        const link = href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${W.short(st.piece)}</a>` : W.short(st.piece);
        action = st.owner === me
          ? `<p class="hold-note ok">✓ Claimed · your contract ${link}</p><div class="hold-btns">${view}</div>`
          : `<p class="hold-note">Sold · now held by ${W.short(st.owner)} · contract ${link}</p>`;
      } else if (st.keyPosted) {
        action = `<p class="hold-note ok">Your key is here. View it now, and claim it to deploy its own contract.</p><div class="hold-btns"><button class="btn btn-solid btn-sm" type="button" data-claim="${e}" ${busy ? 'disabled' : ''} title="Deploys this edition's own contract, held by you">Claim</button>${view}</div>`;
      } else if (noViewingKey()) {
        action = '<p class="hold-note">Needs your viewing key: keys go out in batches, only to wallets that have one. <a href="#yours" data-vk-jump>Create it above ↑</a></p>';
      } else if (S.nets && st.assignedAt && chainNowS() >= st.assignedAt + S.nets.keyWait) {
        // the key is a month late: the token can be claimed now, and the key can still arrive into its contract
        action = `<p class="hold-note">Its key is over 30 days late. Claim the token now: the key can still arrive later, into its own contract.</p><div class="hold-btns"><button class="btn btn-sm" type="button" data-claim="${e}" ${busy ? 'disabled' : ''}>Claim without the key</button></div>`;
      } else {
        action = '<p class="hold-note wait">Waiting for the next key batch · <a href="../docs.html#keys">When?</a></p>';
      }
      cards.push(`
        <div class="hold"><div class="aw">
          <div class="aw-tb"><span>ARTIFACTS <span class="aw-mu">#${pad3(e)}</span></span><span class="aw-mu">SEALED</span></div>
          <div class="aw-menu"><span>File</span><span>View</span><span>Run</span><span class="aw-sp"></span><span class="aw-mu">${t ? esc(t.palette) : 'ENCRYPTED'}</span></div>
          <div class="aw-seal flat">${SEAL}<span>SEALED</span></div>
          <div class="aw-sb"><span>${t ? esc(t.direction) : 'YOURS'}</span><span>${t ? `<b>${esc(t.title)}</b> · ${esc(t.k)}C` : 'OWNER-ONLY'}</span></div>
        </div><div class="hold-act">${action}</div></div>`);
    });
    setHtml($('[data-holds]'), cards.join(''));
  }

  // ---------- render: archive ----------

  const grid = $('[data-grid]');
  const filters = Array.from(document.querySelectorAll('[data-filter]'));
  function buildGrid() {
    const items = ['<li class="cell master" title="THE SOURCE · the master"><a href="#source"><span class="n">◆</span></a></li>'];
    for (let i = 1; i <= EDITIONS; i++) items.push(`<li class="cell" data-id="${i}"><button type="button" class="cell-btn" data-open="${i}" aria-label="ARTIFACTS #${pad3(i)}"><span class="n">${pad3(i)}</span><span class="strip"></span></button></li>`);
    grid.innerHTML = items.join('');
  }
  buildGrid();
  // One tab stop for the whole archive, not 256: the arrow keys move between pieces, Home and End jump to the ends.
  (function rovingGrid() {
    const items = () => Array.from(grid.querySelectorAll('.cell > a, .cell > button'));
    items().forEach((el, i) => { el.tabIndex = i === 0 ? 0 : -1; });
    grid.addEventListener('keydown', (ev) => {
      const list = items();
      const at = list.indexOf(document.activeElement);
      if (at < 0) return;
      const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length || 1;
      const to = { ArrowRight: at + 1, ArrowLeft: at - 1, ArrowDown: at + cols, ArrowUp: at - cols, Home: 0, End: list.length - 1 }[ev.key];
      if (to === undefined) return;
      ev.preventDefault();
      list[Math.max(0, Math.min(list.length - 1, to))].focus();
    });
    // wherever focus lands in the grid (arrows, a click), the tab stop moves with it
    grid.addEventListener('focusin', (ev) => {
      const list = items();
      if (list.includes(ev.target)) list.forEach((el) => { el.tabIndex = el === ev.target ? 0 : -1; });
    });
  })();

  let archiveShown = '';
  function renderArchive() {
    const known = Object.keys(S.traits).length;
    // Nothing new since the last paint (traits and this wallet's editions): leave the 255 cells alone.
    const shown = `${Object.values(S.traits).map((t) => t.title + t.palette + t.k + t.direction).join()}|${S.mine.join(',')}`;
    if (shown === archiveShown) return;
    archiveShown = shown;
    const sets = { direction: new Set(), palette: new Set(), title: new Set() };
    const mine = new Set(S.mine);
    grid.querySelectorAll('.cell[data-id]').forEach((c) => {
      const id = Number(c.dataset.id);
      const t = S.traits[id];
      c.classList.toggle('mine', mine.has(id));
      if (!t) { c.title = `#${pad3(id)} · traits publish before the sale`; return; }
      c.dataset.direction = t.direction; c.dataset.palette = t.palette; c.dataset.title = t.title;
      c.title = `#${pad3(id)} · ${t.title} · ${t.palette} · ${esc(t.k)}C · ${t.direction}`;
      c.querySelector('.strip').style.background = strip(t.palette, t.k);
      sets.direction.add(t.direction); sets.palette.add(t.palette); sets.title.add(t.title);
    });
    filters.forEach((sel) => {
      const have = new Set(Array.from(sel.options).map((o) => o.value));
      Array.from(sets[sel.dataset.filter]).sort().forEach((v) => {
        if (!have.has(v)) { const o = document.createElement('option'); o.value = v; o.textContent = v; sel.append(o); }
      });
      sel.disabled = known === 0;
    });
    $('[data-archive-note]').textContent = known === 0
      ? 'The curator publishes every piece\'s public traits before the sale opens. Until then the archive is sealed numbers.'
      : known < EDITIONS ? `${known} of ${EDITIONS} pieces' traits published so far.` : '';
    applyFilter();
  }

  function applyFilter() {
    const want = Object.fromEntries(filters.map((s) => [s.dataset.filter, s.value]));
    let n = 0;
    grid.querySelectorAll('.cell').forEach((c) => {
      if (c.classList.contains('master')) { n++; return; }
      const ok = Object.entries(want).every(([k, v]) => !v || c.dataset[k] === v);
      c.classList.toggle('dim', !ok);
      if (ok) n++;
    });
    $('[data-filter-count]').textContent = `${n} / 256`;
  }
  filters.forEach((s) => s.addEventListener('change', applyFilter));

  // ---------- one piece: its traits, where it is, its owner and its own contract ----------

  const panel = document.querySelector('[data-piece-panel]');
  async function openPiece(id) {
    const t = S.traits[id];
    const me = W.account();
    panel.querySelector('[data-pp-title]').textContent = `ARTIFACTS #${pad3(id)}`;
    const art = `<div class="aw"><div class="aw-tb"><span>ARTIFACTS <span class="aw-mu">#${pad3(id)}</span></span><span class="aw-mu">SEALED</span></div>`
      + `<div class="aw-menu"><span>File</span><span>View</span><span>Run</span><span class="aw-sp"></span><span class="aw-mu">${t ? esc(`${t.palette} · ${esc(t.k)}C`) : 'ENCRYPTED'}</span></div>`
      + `<div class="aw-seal flat">${SEAL}<span>SEALED</span></div>${t ? `<div class="pp-strip" style="background:${strip(t.palette, t.k)}"></div>` : ''}`
      + `<div class="aw-sb"><span>${t ? esc(t.title) : 'OWNER-ONLY'}</span><span>${t ? esc(t.direction) : ''}</span></div></div>`;
    panel.querySelector('[data-pp-art]').innerHTML = art;
    const facts = panel.querySelector('[data-pp-facts]');
    const row = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
    const traits = t ? row('Title', esc(t.title)) + row('Palette', esc(t.palette)) + row('Colours', t.k) + row('Direction', esc(t.direction)) : row('Traits', 'published before the sale');
    facts.innerHTML = traits + row('State', 'reading the chain…');
    panel.querySelector('[data-pp-acts]').innerHTML = '';
    if (!panel.open) panel.showModal();
    // the read-only preview has no contracts to ask
    if (!W.ADDR.test(A.factory || '')) { facts.innerHTML = traits + row('State', 'sealed in the archive'); return; }
    try {
      const [[buyer], [piece]] = await Promise.all([
        W.read(A.factory, 'editionBuyer(uint256)(address)', [id]),
        W.read(A.factory, 'pieceContract(uint256)(address)', [id]),
      ]);
      let state, owner = null, contract = '';
      if (lc(piece) !== W.ZERO) {
        [owner] = await W.read(piece, 'ownerOf(uint256)(address)', [1]);
        owner = lc(owner);
        const href = W.explorer('address', piece);
        state = 'in its own contract';
        contract = row('Its own contract', href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${W.short(piece)}</a>` : W.short(piece));
      } else if (lc(buyer) !== W.ZERO) {
        owner = lc(buyer);
        state = 'drawn · not yet claimed';
      } else {
        state = 'not yet drawn · sealed in the archive';
      }
      const yours = !!(me && owner && owner === me);
      facts.innerHTML = traits + row('State', state) + (owner ? row('Owner', yours ? 'you' : W.short(owner)) : '') + contract;
      const acts = [];
      if (lc(piece) !== W.ZERO && drop.market) acts.push(`<a class="btn btn-sm" href="${esc(drop.market)}" target="_blank" rel="noopener">${yours ? 'Sell it on the Artifacts marketplace ↗' : 'Artifacts marketplace ↗'}</a>`);
      if (yours && lc(piece) === W.ZERO) acts.push('<a class="btn btn-sm" href="#yours" data-pp-close>Claim it under Yours ↓</a>');
      if (state.startsWith('not yet drawn') && S.sale && S.sale.open) acts.push('<a class="btn btn-solid btn-sm" href="#mint" data-pp-close>Mint an edition ↑</a><p class="mint-note">Editions are drawn at random at mint: nobody picks which.</p>');
      panel.querySelector('[data-pp-acts]').innerHTML = acts.join('');
    } catch (_) {
      facts.innerHTML = traits + row('State', 'could not read the chain just now');
    }
  }
  grid.addEventListener('click', (ev) => { const b = ev.target.closest('[data-open]'); if (b) openPiece(Number(b.dataset.open)); });
  panel.addEventListener('click', (ev) => { if (ev.target === panel || ev.target.closest('[data-pp-close]')) panel.close(); });

  // ---------- render: THE SOURCE ----------

  // ---------- phases: THE SOURCE's auction first, then the editions ----------

  const MASTER_CARD = `<div class="aw"><div class="aw-tb"><span>ARTIFACTS ◆ <span class="aw-mu">MASTER</span></span><span class="aw-mu">SEALED</span></div><div class="aw-menu"><span>File</span><span>View</span><span>Reveal</span><span class="aw-sp"></span><span class="aw-mu">ENCRYPTED</span></div><div class="aw-seal" role="img" aria-label="THE SOURCE, sealed">${SEAL}<span>SEALED</span></div><div class="aw-sb"><span>THE SOURCE</span><span><b>FIDELITY</b> · MAX · 1/1</span></div></div>`;
  const EDITION_CARD = `<div class="aw"><div class="aw-tb"><span>ARTIFACTS <span class="aw-mu">#???</span></span><span class="aw-mu">SEALED</span></div><div class="aw-menu"><span>File</span><span>View</span><span>Run</span><span class="aw-sp"></span><span class="aw-mu">ENCRYPTED</span></div><div class="aw-seal" role="img" aria-label="A sealed edition">${SEAL}<span>SEALED</span></div><div class="aw-sb"><span>OWNER-ONLY</span><span><b>ENCRYPTED</b> · ON-CHAIN</span></div></div>`;
  let heroCard = '';
  let revealedArt = null; // the revealed SOURCE, just the art, for the hero

  function phaseOf(src, sale) {
    if (!src) return 'auction';
    if (src.settled || (sale && sale.open)) return 'editions';
    return 'auction';
  }

  // Seconds left by the chain's clock, carried forward between reads.
  const secondsLeft = (src) => src.endTime - (src.chainNow + Math.floor((Date.now() - src.readAt) / 1000));
  function fmtLeft(t) {
    if (t <= 0) return 'ended';
    const d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    if (d) return `${d}d ${h}h ${m}m`;
    if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
    return `${m}m ${String(sec).padStart(2, '0')}s`;
  }
  const opensAt = drop.schedule && drop.schedule.auctionOpens ? new Date(drop.schedule.auctionOpens) : null;

  let shownArt = false;
  function renderSource() {
    const src = S.source;
    if (!src) return;
    const me = W.account();
    const phase = phaseOf(src, S.sale);
    const left = src.open && !src.settled ? secondsLeft(src) : 0;
    const live = src.open && !src.settled && left > 0;
    const ended = src.open && !src.settled && left <= 0;

    // phase boxes: a box folds away only when its own phase is over, so an auction still open alongside open
    // editions keeps its bid form
    document.querySelectorAll('[data-phase]').forEach((li) => {
      const p = li.dataset.phase;
      const isActive = p === phase || (p === 'auction' && src.open && !src.settled);
      li.classList.toggle('active', isActive);
      li.classList.toggle('done', p === 'auction' && phase === 'editions' && !isActive);
      li.classList.toggle('upcoming', p === 'editions' && phase === 'auction');
    });
    // the archive's master tile shows the art too, once it is public
    const tile = grid.querySelector('.cell.master a');
    const showTile = !!(src.revealed && revealedArt);
    if (tile && tile.dataset.art !== String(showTile)) {
      tile.dataset.art = String(showTile);
      tile.innerHTML = showTile ? `<img src="${revealedArt}" alt="THE SOURCE, revealed">` : '<span class="n">◆</span>';
      tile.parentElement.classList.toggle('revealed', showTile);
      tile.parentElement.title = showTile ? 'THE SOURCE · revealed · public forever' : 'THE SOURCE · the master';
    }
    const card = src.revealed && revealedArt
      ? `<figure class="hero-art"><img src="${revealedArt}" alt="THE SOURCE, revealed: drawn from its seed by the rules on-chain"><figcaption>THE SOURCE · revealed · public forever</figcaption></figure>`
      : phase === 'auction' ? MASTER_CARD : EDITION_CARD;
    if (card !== heroCard) { heroCard = card; $('[data-hero-card]').innerHTML = card; }

    // drop status line
    const sale = S.sale || {};
    $('[data-drop-status]').textContent = phase === 'auction'
      ? (live ? `THE SOURCE auction live on ${cfg.chainName}` : ended ? 'THE SOURCE auction closing' : `THE SOURCE auction ${opensAt ? `opens ${opensAt.toLocaleDateString()}` : 'opens soon'}`)
      : (sale.open ? (EDITIONS - sale.sold ? `Editions live on ${cfg.chainName}` : 'Sold out') : 'Editions open soon');

    // phase 1 box
    const state = $('[data-auction-state]');
    state.textContent = src.settled ? 'Sold' : live ? 'Live' : ended ? 'Ended' : 'Opens soon';
    state.classList.toggle('on', live);
    $('[data-high-label]').textContent = src.high > 0n ? 'High bid' : 'Reserve';
    $('[data-src-high]').textContent = src.high > 0n ? `${eth(src.high)} · ${src.bidder === me ? 'you' : W.short(src.bidder)}` : src.reserve > 0n ? eth(src.reserve) : 'set when it opens';
    $('[data-countdown-label]').textContent = src.open ? 'Ends in' : 'Opens';
    $('[data-countdown]').textContent = src.open ? (src.settled ? 'closed' : fmtLeft(left)) : opensAt ? opensAt.toLocaleString() : 'soon';
    $('[data-bid-count]').textContent = String(bids.length);
    const form = $('[data-bid-form]');
    form.hidden = !live;
    const hint = $('[data-bid-hint]');
    const sg = src.gate;
    const srcGated = live && gateLive(sg);
    const srcGate = $('[data-src-gate]');
    srcGate.hidden = !srcGated;
    if (srcGated) {
      // a window that outlasts the auction (late bids included) makes it holders only, start to finish
      const whole = sg.endsAt >= src.endTime;
      srcGate.textContent = whole
        ? (!me ? `Holders only: bidding needs ${gateWho(sg)}, for the whole auction.`
          : sg.ok ? 'Holders only, the whole auction: you qualify, you can bid.'
          : `Holders only, the whole auction. Hold ${gateWho(sg)} to bid.`)
        : (!me ? `Holders first until ${gateUntil(sg.endsAt)}: bidding needs ${gateWho(sg)}. Everyone can bid after that.`
          : sg.ok ? `Holders first until ${gateUntil(sg.endsAt)}: you qualify, you can bid.`
          : `Holders first until ${gateUntil(sg.endsAt)}. Hold ${gateWho(sg)} to bid now; everyone can after that.`);
    }
    if (live) {
      const min = minimumBid(src);
      // shown rounded up to 4 decimals, so it stays short and is always enough
      const step = 10n ** 14n;
      $('[data-bid-input]').placeholder = `${W.units(((min + step - 1n) / step) * step)} or more`;
      $('[data-bid-btn]').disabled = busy || (srcGated && !!me && !sg.ok);
      hint.textContent = src.bidder === me ? "You're the high bidder." : `Lowest bid that counts: ${eth(min)}.`;
    } else {
      hint.textContent = !src.open && !src.locked ? 'The curator stores THE SOURCE on-chain before the auction opens.' : '';
    }
    const acts = [];
    if (ended) acts.push(`<button class="btn btn-solid btn-sm" type="button" data-settle ${busy ? 'disabled' : ''}>Close the auction</button><p class="mint-note src-close-note">Anyone can close it: one transaction gives THE SOURCE its own contract, held by the winner, and pays out the sale.</p>`);
    if (src.refund > 0n) acts.push(`<button class="btn btn-sm" type="button" data-refund ${busy ? 'disabled' : ''}>Outbid: take back ${eth(src.refund)}</button>`);
    setHtml($('[data-src-actions]'), acts.join(''));
    $('[data-auction-summary]').textContent = src.settled ? `Sold for ${eth(src.high)} to ${src.owner === me ? 'you' : W.short(src.owner)}.` : '';
    // The winner's next step, right where they look after the auction: viewing key, then the key, then the view.
    const next = $('[data-auction-next]');
    let nextHtml = '';
    if (src.settled && src.piece !== W.ZERO && src.owner === me && src.sealed && !src.revealed) {
      const off = busy ? 'disabled' : '';
      if (!src.myViewingKey) nextHtml = `<p><b>THE SOURCE is yours.</b> Next: create your viewing key, so its key can be sent to you. One signature, then one transaction.</p><button class="btn btn-solid btn-sm" type="button" data-src-vk ${off}>Create your viewing key</button>`;
      else if (!src.keyPosted) nextHtml = '<p><b>Viewing key ready.</b> The curator sends THE SOURCE\'s key to it next; this updates by itself.</p>';
      else nextHtml = `<p><b>Its key is yours.</b> See it privately, drawn in this browser. Revealing it to everyone is below, in THE SOURCE.</p><button class="btn btn-solid btn-sm" type="button" data-src-view ${off}>View privately</button>`;
    }
    if (next.dataset.html !== nextHtml) { next.dataset.html = nextHtml; next.innerHTML = nextHtml; }
    next.hidden = !nextHtml;
    $('[data-edition-summary]').textContent = phase === 'auction' ? 'Opens once THE SOURCE\'s auction has closed.' : '';
    if (phase === 'auction') { const st = $('[data-sale-state]'); st.textContent = 'Next'; st.classList.remove('on'); }

    // THE SOURCE section
    $('[data-src-state]').textContent = src.revealed ? 'revealed · public forever' : src.settled ? 'sold · sealed until its owner reveals it' : live ? 'sealed · at auction' : 'sealed · auction first';
    $('[data-src-image]').textContent = !src.locked ? 'not stored yet' : src.revealed ? 'its seed, now public, and the rules that draw it' : 'its seed, encrypted · locked forever';
    $('[data-src-owner]').textContent = src.piece !== W.ZERO ? (src.owner === me ? 'you' : W.short(src.owner)) : 'goes to the winning bid';
    // The owner's path: a viewing key, the curator's key delivery, then view privately or reveal to everyone.
    const reveal = [];
    let note = '';
    const dis = busy ? 'disabled' : '';
    if (src.piece !== W.ZERO && !src.revealed && src.owner === me) {
      if (!src.sealed) {
        reveal.push(`<button class="btn btn-solid btn-sm" type="button" data-reveal ${dis}>Reveal forever</button>`);
      } else if (!src.myViewingKey) {
        reveal.push(`<button class="btn btn-solid btn-sm" type="button" data-src-vk ${dis}>Create your viewing key</button>`);
        note = "THE SOURCE is yours. Sign once to make your private viewing key; only its public half goes on-chain. The curator then sends THE SOURCE's key to it.";
      } else if (!src.keyPosted) {
        note = "Your viewing key is registered. Waiting for the curator to send THE SOURCE's key to it.";
      } else {
        reveal.push(showingPrivate
          ? `<button class="btn btn-solid btn-sm" type="button" data-src-private-close>Close the private view</button>`
          : `<button class="btn btn-solid btn-sm" type="button" data-src-view ${dis}>View privately</button>`);
        reveal.push(`<button class="btn btn-sm" type="button" data-reveal ${dis}>Reveal to everyone</button>`);
        note = 'Its key is yours. Viewing opens its seed and draws it here, in this browser, sending nothing anywhere. Revealing publishes the key on-chain: from then on, everyone can see it, forever.';
      }
    }
    setHtml($('[data-reveal-actions]'), reveal.join(''));
    $('[data-reveal-note]').textContent = note;
    renderBids(me);

    if (src.revealed && !shownArt) { shownArt = true; showRevealed(src.piece).catch(() => { shownArt = false; }); }
  }

  function renderBids(me) {
    const ol = $('[data-bids]');
    if (!bids.length) {
      const src = S.source || {};
      ol.innerHTML = `<li class="bids-empty">${bidsUnread ? (src.settled ? 'The bid history could not be read just now. The result above is read from the contract.' : 'The bid history could not be read just now. It will appear on the next refresh.') : 'No bids yet.'}</li>`;
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const ago = (t) => { if (!t) return ''; const d = now - t; return d < 60 ? 'just now' : d < 3600 ? `${Math.floor(d / 60)} min ago` : d < 86400 ? `${Math.floor(d / 3600)} h ago` : new Date(t * 1000).toLocaleDateString(); };
    ol.innerHTML = bids.slice(-12).reverse().map((b, i) => {
      const href = W.explorer('tx', b.tx);
      const who = lc(b.bidder) === me ? 'you' : W.short(b.bidder);
      return `<li class="${i === 0 ? 'top' : ''}"><span>${eth(b.amount)}</span><span>${esc(who)}</span><span>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${ago(blockTimes[b.block]) || 'view'}</a>` : ago(blockTimes[b.block])}</span></li>`;
    }).join('');
  }

  // The countdown ticks every second between reads.
  setInterval(() => {
    const src = S.source;
    if (!src || !src.open || src.settled) return;
    const left = secondsLeft(src);
    $('[data-countdown]').textContent = fmtLeft(left);
    if (left <= 0 && !$('[data-settle]') && !busy) refresh();
  }, 1000);

  // The mint phases' countdowns tick every second too.
  setInterval(() => {
    document.querySelectorAll('[data-cd-to]').forEach((e) => {
      const left = Number(e.dataset.cdTo) - chainNowS();
      e.textContent = left > 0 ? `${e.dataset.cdLabel} ${fmtLeft(left)}` : 'now';
    });
  }, 1000);

  // So does the editions timer; at its step the rules change, so read again (and once more after the next block).
  setInterval(() => {
    if (!shownStep || !S.sale || !S.sale.open) return;
    const left = shownStep - chainNowS();
    if (left > 0) { $('[data-next]').textContent = fmtLeft(left); return; }
    shownStep = 0;
    // every open page reaches this second together: spread their reads over five seconds
    const spread = Math.random() * 5000;
    setTimeout(() => { if (!busy) refresh(); }, spread);
    setTimeout(() => { if (!busy) refresh(); }, 15000 + spread);
  }, 1000);

  // The 5% raise rounds up, exactly as the contract checks it.
  function minimumBid(s) {
    if (s.high === 0n) return s.reserve;
    const raised = (s.high * 10500n + 9999n) / 10000n;
    return raised > s.reserve ? raised : s.reserve;
  }

  // ---------- THE SOURCE, privately: the owner's viewing key unwraps K, and this browser decrypts the chain's bytes ----------

  const Seal = window.ProofHouseSeal;
  document.querySelectorAll('[data-market-link]').forEach((a) => { a.href = drop.market || '#'; });
  let viewing = null; // { owner, key }: this page's memory only, never stored

  // The key format the contracts use: version 2 when the piece template checks fake keys (contracts from v13), else 1.
  let keyScheme = null;
  async function scheme() {
    if (keyScheme === null) keyScheme = await W.keyScheme(A.piece);
    return keyScheme;
  }

  const UNSTEADY_WALLET = 'This wallet signed the same message two different ways, so a viewing key made from it could not be '
    + 'made again, and what is sent to it could never be opened. Nothing was registered. Use a wallet that signs the same way '
    + 'every time (MetaMask, Rabby, Coinbase Wallet or a Ledger, for example).';

  // One signature gives the wallet's viewing keys. Returns { publicKey: the one to register here, open(wrapped, id,
  // commitment, piece): K checked against the commitment, or null }.
  async function viewingKeyFor(me, el = revealMsg, prompt = 'Sign in your wallet to unlock your viewing key. The signature stays on this page and is never sent.') {
    if (viewing && viewing.owner === me) return viewing.key;
    if (!Seal) throw new Error('This browser cannot make viewing keys.');
    say(el, prompt);
    const v = await scheme();
    const message = Seal.viewingMessage(v, cfg.chainId);
    const sig = await W.signMessage(me, message);
    const ring = Seal.keyring(Seal.fromHex(sig));
    const mine = v === 2 ? ring.wallet : await ring.v1();
    // Before a key is first registered: the wallet must make the same key every time, or what is sent to it could
    // never be opened again. Some wallets (MPC, threshold) sign differently each time; they are refused here.
    if (v === 2 && (!S.viewingKey || /^0x0+$/.test(S.viewingKey))) {
      say(el, 'Sign once more: this checks your wallet makes the same viewing key every time, before it is registered.');
      const again = Seal.keyring(Seal.fromHex(await W.signMessage(me, message)));
      if (Seal.hex(again.wallet.publicKey) !== Seal.hex(mine.publicKey)) throw new Error(UNSTEADY_WALLET);
    }
    // a key registered another way (an agent's own, say) can't be remade from this signature: say so plainly
    if (S.viewingKey && !/^0x0+$/.test(S.viewingKey) && Seal.hex(mine.publicKey).toLowerCase() !== S.viewingKey.toLowerCase()) {
      throw new Error("This wallet's viewing key was registered some other way (not by signing here), so this signature can't open what was sent to it. Use the key you registered, as agents.md describes.");
    }
    const key = {
      publicKey: mine.publicKey,
      // the wallet's key, and the key for that piece if it was bought on the market
      open: (wrapped, id, commitment, piece) => Seal.openKey(wrapped, [mine, piece ? ring.forPiece(cfg.chainId, piece) : null], id, commitment),
    };
    viewing = { owner: me, key };
    return viewing.key;
  }
  W.onChange(() => { viewing = null; closePrivate(); });

  async function sourceKey(me) {
    const vk = await viewingKeyFor(me);
    const piece = S.source.piece;
    const [wrappedRet, [commitment]] = await Promise.all([call(piece, W.encodeCall('wrappedKey()', [])), W.read(piece, 'commitment()(bytes32)', [])]);
    const key = await vk.open(decodeBytes(wrappedRet), 256, commitment, piece);
    if (!key) throw new Error("The key you hold does not open THE SOURCE with this wallet's viewing key. If it came from the curator, ask them to check it.");
    return key;
  }

  // THE SOURCE is drawn by the chain's own renderer page (the rules) from its seed, in a hidden sandboxed frame: scripts
  // run, but the frame cannot reach this page, the wallet or the network. It hands back the SVG it drew by postMessage,
  // and this page shows just the art: the window frame and its dots, cropped from the 1080 px sheet around them.
  // The renderer runs with scripts but nothing else: no network, no other origin, no storage (a CSP in its own head).
  const NO_NETWORK = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:">';
  const lockDown = (html) => (/^\s*<!doctype[^>]*>/i.test(html) ? html.replace(/^(\s*<!doctype[^>]*>)/i, `$1${NO_NETWORK}`) : NO_NETWORK + html);
  function drawWithPage(html) {
    return new Promise((resolve, reject) => {
      const f = document.createElement('iframe');
      f.sandbox = 'allow-scripts';
      f.title = 'renderer';
      f.style.cssText = 'position:absolute;left:-9999px;top:0;width:10px;height:10px;border:0';
      const timer = setTimeout(() => { window.removeEventListener('message', done); f.remove(); reject(new Error('The renderer did not answer.')); }, 60000);
      function done(ev) {
        if (ev.source !== f.contentWindow || !ev.data || typeof ev.data.artifacts !== 'string') return;
        window.removeEventListener('message', done); clearTimeout(timer); f.remove(); resolve(ev.data.artifacts);
      }
      window.addEventListener('message', done);
      f.srcdoc = lockDown(html);
      document.body.append(f);
    });
  }
  // The window's outer border sits at (200, 220), 680 × 640 (R8): one unit around it keeps its stroke.
  const cropToArt = (svg) => svg
    .replace(/viewBox="0 0 1080 1080" width="1080" height="1080"/, 'viewBox="199 219 682 642" width="682" height="642"')
    .replace('<rect width="1080" height="1080" fill="#ffffff"/>', '<rect x="199" y="219" width="682" height="642" fill="#ffffff"/>');
  const svgUrl = (text) => URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));

  // Just the art as a PNG at 3×: on a transparent background (the white sheet is the SVG's one background rect), or on
  // white, as the sheet it is drawn on.
  async function artPng(svg, white = false, scale = 3) {
    const art = svg
      .replace(/viewBox="0 0 1080 1080" width="1080" height="1080"/, `viewBox="199 219 682 642" width="${682 * scale}" height="${642 * scale}"`)
      .replace('<rect width="1080" height="1080" fill="#ffffff"/>', '');
    const url = svgUrl(art);
    try {
      const img = new Image();
      await new Promise((ok, bad) => { img.onload = ok; img.onerror = () => bad(new Error('The image could not be drawn.')); img.src = url; });
      const c = document.createElement('canvas');
      c.width = 682 * scale;
      c.height = 642 * scale;
      const ctx = c.getContext('2d');
      if (white) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height); }
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return await new Promise((ok) => c.toBlob(ok, 'image/png'));
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  function saveFile(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  async function rendererPage(piece) {
    const pointers = decodeAddressArray(await call(A.source, W.encodeCall('rendererChunks()', [])));
    const codes = await Promise.all(pointers.map((p) => W.rpc('eth_getCode', [p, 'latest'])));
    const parts = codes.map((code) => Seal.fromHex(code).slice(1)); // SSTORE2: skip the leading STOP byte
    const suffix = decodeString(await call(piece, W.encodeCall('RENDER_SUFFIX()', [])));
    return { parts, suffix };
  }

  let drawn = null; // { art, full } blob URLs of what is shown
  async function showArt(html, mode) {
    const img = $('[data-src-img]');
    const full = $('[data-src-full]');
    if (drawn) { URL.revokeObjectURL(drawn.art); URL.revokeObjectURL(drawn.full); drawn = null; }
    img.hidden = true;
    full.hidden = true;
    document.querySelectorAll('[data-src-png]').forEach((b) => { b.hidden = true; });
    $('[data-src-drawing]').hidden = false;
    $('[data-src-caption]').textContent = mode === 'private'
      ? 'Private view: drawn from its seed in this browser, sent nowhere'
      : 'Drawn from its seed by the ARTIFACTS rules stored on-chain';
    $('[data-src-private-close]').hidden = mode !== 'private';
    $('[data-src-figure]').hidden = false;
    $('[data-src-window]').hidden = false;
    $('#source .source-grid').classList.add('wide');
    const svg = await drawWithPage(html);
    drawn = { art: svgUrl(cropToArt(svg)), full: svgUrl(svg), svg };
    img.src = drawn.art;
    img.hidden = false;
    full.href = drawn.full;
    full.hidden = false;
    document.querySelectorAll('[data-src-png]').forEach((b) => { b.hidden = false; });
    $('[data-src-drawing]').hidden = true;
    return svg;
  }

  // ---------- your editions, privately: the same viewing key opens each edition's key, then its sealed seed ----------

  const yoursMsg = $('[data-yours-msg]');
  const edViewer = $('[data-ed-viewer]');
  let edDrawn = null; // { e, svg, url }: this page's memory only

  async function viewEdition(me, e) {
    const st = S.editions[e] || {};
    const claimed = st.piece && st.piece !== W.ZERO;
    const vk = await viewingKeyFor(me, yoursMsg);
    say(yoursMsg, `Opening edition #${pad3(e)} in this browser…`);
    const [wrappedRet, [commitment], sealedRet] = await Promise.all([
      // before the claim the key waits on the factory; after it, on the edition's own contract
      claimed ? call(st.piece, W.encodeCall('wrappedKey()', [])) : call(A.factory, W.encodeCall('wrappedKeyOf(uint256)', [e])),
      W.read(A.factory, 'commitmentOf(uint256)(bytes32)', [e]),
      call(A.factory, W.encodeCall('ciphertextOf(uint256)', [e])),
    ]);
    const wrapped = decodeBytes(wrappedRet);
    if (!wrapped.length) throw new Error(`Edition #${pad3(e)}'s key has not been sent to you yet.`);
    const key = await vk.open(wrapped, e, commitment, claimed ? st.piece : null);
    if (!key) throw new Error(`Your viewing key does not open edition #${pad3(e)}'s key. If you registered a new viewing key after it was sent, ask the curator to send it again.`);
    const seed = Seal.hex(await Seal.openSeed(decodeBytes(sealedRet), key, e));
    const { parts, suffix } = await rendererPage(A.piece);
    const edition = suffix.replace('"),true);', `"),false,${e});`); // the same rules: not the master, and its number (R8)
    if (edition === suffix) throw new Error('The renderer page on-chain ends differently than this page expects.');
    closeEdition();
    $('[data-ev-title]').textContent = `ARTIFACTS #${pad3(e)} · private view`;
    $('[data-ev-drawing]').hidden = false;
    edViewer.showModal();
    const svg = await drawWithPage(new TextDecoder().decode(new Uint8Array(parts.reduce((a, p) => [...a, ...p], []))) + seed + edition);
    edDrawn = { e, svg, url: svgUrl(cropToArt(svg)) };
    const img = $('[data-ev-img]');
    img.src = edDrawn.url;
    img.alt = `ARTIFACTS #${pad3(e)}, drawn from its seed`;
    img.hidden = false;
    $('[data-ev-drawing]').hidden = true;
    document.querySelectorAll('[data-ev-png]').forEach((b) => { b.hidden = false; });
    say(yoursMsg, `Only you are seeing edition #${pad3(e)}. It is drawn here and gone when you close it.`, 'ok');
  }

  function closeEdition() {
    if (edViewer.open) edViewer.close();
    if (edDrawn) URL.revokeObjectURL(edDrawn.url);
    edDrawn = null;
    $('[data-ev-img]').hidden = true;
    $('[data-ev-img]').removeAttribute('src');
    document.querySelectorAll('[data-ev-png]').forEach((b) => { b.hidden = true; });
  }
  edViewer.addEventListener('click', (ev) => {
    if (ev.target === edViewer || ev.target.closest('[data-ev-close]')) closeEdition();
    const evPng = ev.target.closest('[data-ev-png]');
    if (evPng && edDrawn) {
      const white = evPng.dataset.evPng === 'white';
      const name = `ARTIFACTS-${pad3(edDrawn.e)}${white ? '-white' : ''}.png`;
      artPng(edDrawn.svg, white).then((png) => saveFile(png, name), (err) => say(yoursMsg, err.message, 'error'));
    }
  });
  edViewer.addEventListener('close', () => { if (edDrawn) closeEdition(); });
  W.onChange(() => closeEdition());

  let showingPrivate = false;
  async function viewPrivately(me) {
    const key = await sourceKey(me);
    say(revealMsg, 'Opening THE SOURCE in this browser…');
    const [sealedSeed] = await W.read(A.source, 'sealedSeed()(bytes32)', []);
    const seed = Seal.hex(Seal.keystreamXor(Seal.fromHex(sealedSeed), key)); // seed XOR keccak256(K ‖ 0)
    const { parts, suffix } = await rendererPage(S.source.piece);
    const page = new TextDecoder().decode(new Uint8Array(parts.reduce((a, p) => [...a, ...p], [])));
    showingPrivate = true;
    renderSource();
    $('[data-src-figure]').scrollIntoView({ behavior: 'smooth', block: 'start' });
    await showArt(page + seed + suffix, 'private');
    say(revealMsg, 'Only you are seeing this. It is drawn here and gone when you close it or leave the page.', 'ok');
  }

  function closePrivate() {
    if (!showingPrivate) return;
    showingPrivate = false;
    $('[data-src-img]').removeAttribute('src');
    if (drawn) { URL.revokeObjectURL(drawn.art); URL.revokeObjectURL(drawn.full); drawn = null; }
    $('[data-src-figure]').hidden = true;
    $('[data-src-window]').hidden = true;
    $('#source .source-grid').classList.remove('wide');
    if (S.source && S.source.revealed) shownArt = false;
    if (S.source) renderSource();
  }

  // Once revealed, THE SOURCE is read from its tokenURI, the way a marketplace reads it: its animation_url is the
  // renderer page with the seed. (Older test contracts returned a finished image instead.)
  async function showRevealed(piece) {
    const uri = decodeString(await call(piece, W.encodeCall('tokenURI(uint256)', [1])));
    const meta = await (await fetch(uri)).json();
    if (meta.animation_url && /^data:text\/html;base64,/.test(meta.animation_url)) {
      const bin = atob(meta.animation_url.split(',')[1]);
      const svg = await showArt(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))), 'revealed');
      // Revealed: the hero shows it too, just the art.
      if (!revealedArt) revealedArt = svgUrl(cropToArt(svg));
      renderSource();
    }
  }

  function render() {
    renderMint();
    renderMine();
    renderArchive();
    renderSource();
  }

  // ---------- proof: the contracts, linked to the explorer, and where their source and audit live ----------

  (function renderProof() {
    const rows = [
      ['ArtifactsFactory', A.factory, 'the 255 editions: sale, draw, claim'],
      ['ArtifactsSource', A.source, 'THE SOURCE: its sealed seed, the renderer, auction and key'],
      ['ArtifactsPiece', A.piece, 'the template every piece contract copies'],
      ['ArtHouse', A.artHouse, 'the Proof House ledger and splits'],
    ].filter((r) => W.ADDR.test(r[1] || ''));
    const dl = $('[data-proof]');
    rows.forEach(([name, addr, role]) => {
      const div = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = `${name} · ${role}`;
      const dd = document.createElement('dd');
      const href = W.explorer('address', addr);
      const a = document.createElement(href ? 'a' : 'span');
      if (href) { a.href = href; a.target = '_blank'; a.rel = 'noopener'; }
      a.textContent = W.short(addr);
      a.title = addr;
      dd.append(a);
      div.append(dt, dd);
      dl.append(div);
    });
    const p = drop.proof || {};
    [['Source code', p.source, p.sourceLabel], ['Launch', p.launch, p.launchLabel]].forEach(([label, href, text]) => {
      if (!href || !/^https:\/\//.test(href)) return;
      const div = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      const a = document.createElement('a');
      a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = text || href;
      dd.append(a);
      div.append(dt, dd);
      dl.append(div);
    });
  })();

  function renderUnconfigured() {
    mintBtn.disabled = true;
    mintBtn.textContent = 'Not deployed yet';
    $('[data-drop-status]').textContent = 'Coming soon';
    $('[data-network]').closest('div').hidden = true; // the network is named at launch
    if (!W.readOnly) say(msg, "This drop's contracts are not set in deployment.js yet.");
  }

  // ---------- transactions ----------

  async function withWallet(el, work) {
    if (busy) return;
    busy = true;
    render();
    try {
      if (!W.account()) await W.connect(true);
      await W.ensureChain();
      await work(W.account());
    } catch (e) {
      say(el, W.friendly(e), 'error');
    } finally {
      busy = false;
      await refresh();
    }
  }

  // Simulates the call first, so a refusal shows its reason before the wallet asks for anything.
  async function preflight(from, to, sig, args, value) {
    await W.rpc('eth_call', [{ from, to, data: W.encodeCall(sig, args), value: '0x' + (value || 0n).toString(16) }, 'latest']);
  }

  async function sendAndWait(el, me, to, sig, args, value, label) {
    await preflight(me, to, sig, args, value);
    say(el, `Confirm in your wallet: ${label}.`);
    const hash = await W.send(me, to, sig, args, value);
    say(el, `${label}: sent. Waiting for it to be mined…`, '', hash);
    const r = await W.waitFor(hash);
    if (!r) throw new Error('Still not mined after 15 minutes. Check the transaction in your wallet.');
    if (r.status !== '0x1') throw new Error(`The contract refused: ${label}.`);
    return { hash, receipt: r };
  }

  const PURCHASED = W.keccakHex('Purchased(address,address,uint256,uint256)');
  $('[data-qty-opts]').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-q]');
    if (!b || b.disabled) return;
    qty = Number(b.dataset.q);
    renderMint();
  });

  mintBtn.addEventListener('click', () => withWallet(msg, async (me) => {
    await readSale();
    await readMine();
    const s = S.sale;
    if (!s.open) throw new Error('The sale is closed.');
    const n = s.perWallet ? qty : 1;
    if (s.perWallet && S.minted + n > s.perWallet) throw new Error(`Each wallet can mint ${s.perWallet}; this one has ${s.perWallet - S.minted} left.`);
    // Pay exactly price × quantity, read just now; the contract refuses any other amount.
    const value = s.price * BigInt(n);
    let label = n === 1 ? `mint 1 edition for ${eth(value)}` : `mint ${n} editions for ${eth(value)}`;
    let seatId = null;
    if (gateLive(s.gate)) {
      if (!s.gate.tokenOk && !s.gate.seatOk) throw new Error(`Holders only until ${gateUntil(s.gate.endsAt)}: this wallet needs ${gateWho(s.gate)}.`);
      if (!s.gate.tokenOk) {
        seatId = seatInput.value.trim();
        if (!/^\d+$/.test(seatId)) throw new Error('Enter the number of your identity.md seat.');
      }
    }
    // A wallet's first mint also makes and registers its viewing key, so it is on the list for the next key batch.
    // Signing is free and comes first; registering comes after the mint. Declining either never stops the mint.
    let vk = null;
    if (noViewingKey() && Seal) {
      try {
        vk = await viewingKeyFor(me, msg, 'Step 1 of 3: sign once in your wallet to make your viewing key. It is free, and the signature never leaves this page.');
      } catch (_) { vk = null; }
      if (vk) label = `step 2 of 3, ${label}`;
    }
    const { hash, receipt } = seatId !== null
      ? await sendAndWait(msg, me, A.factory, 'buyWithSeat(uint256,uint256,address)', [seatId, n, broker], value, label)
      : s.perWallet
        ? await sendAndWait(msg, me, A.factory, 'buyMany(uint256,address)', [n, broker], value, label)
        : await sendAndWait(msg, me, A.factory, 'buy(address)', [broker], value, label);
    // One Purchased event per edition, each with its own VRF request.
    const ids = (receipt.logs || [])
      .filter((l) => lc(l.address) === lc(A.factory) && l.topics && l.topics[0] === PURCHASED)
      .map((l) => BigInt('0x' + l.data.slice(2, 66)));
    qty = 1;
    let keyNote = '';
    if (vk) {
      try {
        await sendAndWait(msg, me, A.factory, 'registerViewingKey(bytes32)', [Seal.hex(vk.publicKey)], 0n, 'step 3 of 3, register your viewing key');
        keyNote = ' Your viewing key is registered: your key comes in the next batch.';
      } catch (_) {
        keyNote = ' Your viewing key is not registered yet: press Create your viewing key under Yours, or you miss the next key batch.';
      }
    } else if (noViewingKey()) {
      keyNote = ' Next: create your viewing key under Yours, so your key comes in the next batch.';
    }
    if (!ids.length) { say(msg, `Minted. Your editions are being drawn.${keyNote}`, 'ok', hash); await refresh(); return; }
    S.pending.push(...ids);
    say(msg, `Minted ${ids.length === 1 ? 'an edition' : `${ids.length} editions`}. Chainlink VRF is drawing ${ids.length === 1 ? 'it' : 'each one'}, usually within a minute…${keyNote}`, 'ok', hash);
    await refresh();
    watchDraws(ids, hash);
  }));

  async function watchDraws(ids, hash) {
    const drawn = [];
    let waiting = ids.slice();
    for (let i = 0; i < 120 && waiting.length; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      for (const id of waiting.slice()) {
        try {
          const [edition] = await W.read(A.factory, 'requestEdition(uint256)(uint256)', [id]);
          if (edition > 0n) {
            drawn.push(edition);
            waiting = waiting.filter((x) => x !== id);
            S.pending = S.pending.filter((x) => x !== id);
          }
        } catch (_) { /* keep waiting */ }
      }
      if (drawn.length) {
        const list = drawn.map((e) => `#${pad3(e)}`).join(', ');
        say(msg, `${drawn.length === 1 ? `Edition ${list} is` : `Editions ${list} are`} yours.${waiting.length ? ` ${waiting.length} still drawing…` : ''}`, 'ok', hash);
        await refresh();
      }
    }
    if (waiting.length) say(msg, `${waiting.length === 1 ? 'An edition has' : `${waiting.length} editions have`} not been drawn yet. ${waiting.length === 1 ? 'It' : 'They'} will appear under Yours once Chainlink answers.`, '', hash);
  }

  document.addEventListener('click', (ev) => {
    const claim = ev.target.closest('[data-claim]');
    if (claim) {
      const e = Number(claim.dataset.claim);
      withWallet(yoursMsg, async (me) => {
        await sendAndWait(yoursMsg, me, A.factory, 'claim(uint256)', [e], 0n, `claim edition #${pad3(e)}`);
        say(yoursMsg, `Edition #${pad3(e)} claimed: its own contract is deployed and holds your token.`, 'ok');
      });
    }
    const rereq = ev.target.closest('[data-rereq]');
    if (rereq) {
      const id = BigInt(rereq.dataset.rereq);
      withWallet(yoursMsg, async (me) => {
        await sendAndWait(yoursMsg, me, A.factory, 'rerequestRandomness(uint256)', [id], 0n, 'ask Chainlink for your draw again');
        say(yoursMsg, 'Asked again. Your edition appears here once Chainlink answers.', 'ok');
      });
    }
    const fbStart = ev.target.closest('[data-fb-start]');
    const fbFinish = ev.target.closest('[data-fb-finish]');
    if (fbStart || fbFinish) {
      const id = BigInt((fbStart || fbFinish).dataset.fbStart || (fbStart || fbFinish).dataset.fbFinish);
      const blockPast = async (target) => {
        for (let i = 0; i < 40; i++) { // a few blocks: about a minute
          if (BigInt(await W.rpc('eth_blockNumber', [])) > target) return;
          say(yoursMsg, 'Waiting for that block to be made…');
          await new Promise((r) => setTimeout(r, 6000));
        }
      };
      withWallet(yoursMsg, async (me) => {
        if (fbStart) {
          // one fallback draw at a time: if another buyer's is under way, finish it first (anyone may), then start yours
          const [busyId] = await W.read(A.factory, 'fallbackInFlight()(uint256)', []).catch(() => [0n]);
          if (busyId && busyId !== id) {
            const [[t], [ed]] = await Promise.all([W.read(A.factory, 'fallbackBlock(uint256)(uint256)', [busyId]), W.read(A.factory, 'requestEdition(uint256)(uint256)', [busyId])]);
            if (t > 0n && ed === 0n) {
              await blockPast(t);
              try { await sendAndWait(yoursMsg, me, A.factory, 'finishFallbackDraw(uint256)', [busyId], 0n, "finish another buyer's draw first (anyone may)"); } catch (_) { /* finished meanwhile, or no longer in the way */ }
            }
          }
          await sendAndWait(yoursMsg, me, A.factory, 'startFallbackDraw(uint256)', [id], 0n, 'step 1 of 2, pick a block just ahead');
        }
        const [[target]] = await Promise.all([W.read(A.factory, 'fallbackBlock(uint256)(uint256)', [id])]);
        await blockPast(target);
        await sendAndWait(yoursMsg, me, A.factory, 'finishFallbackDraw(uint256)', [id], 0n, fbStart ? 'step 2 of 2, draw your edition' : 'draw your edition');
        say(yoursMsg, 'Drawn. Your edition is here.', 'ok');
      });
    }
    if (ev.target.closest('[data-claim-all-btn]')) {
      withWallet(yoursMsg, async (me) => {
        await readMine();
        const ready = S.mine.filter((e) => { const st = S.editions[e] || {}; return st.keyPosted && (!st.piece || st.piece === W.ZERO); });
        if (!ready.length) throw new Error('There is nothing ready to claim.');
        const list = ready.map((e) => `#${pad3(e)}`).join(', ');
        if (S.sale && S.sale.canClaimMany) {
          // Each claim deploys a full piece contract (about 5.5M gas) and a transaction may use at most 16,777,216
          // (EIP-7825), so two per transaction leaves room for the wallet's margin.
          const word = (n) => BigInt(n).toString(16).padStart(64, '0');
          for (let i = 0; i < ready.length; i += CLAIMS_PER_TX) {
            const part = ready.slice(i, i + CLAIMS_PER_TX);
            const some = part.map((e) => `#${pad3(e)}`).join(', ');
            const step = ready.length > CLAIMS_PER_TX ? ` (transaction ${i / CLAIMS_PER_TX + 1} of ${Math.ceil(ready.length / CLAIMS_PER_TX)})` : '';
            // claimMany(uint256[]): selector, offset, length, then each edition
            const data = W.keccakHex('claimMany(uint256[])').slice(0, 10) + word(32) + word(part.length) + part.map(word).join('');
            await W.rpc('eth_call', [{ from: me, to: A.factory, data }, 'latest']);
            say(yoursMsg, `Confirm in your wallet: claim ${some}${step}.`);
            const hash = await W.sendData(me, A.factory, data, 0n);
            say(yoursMsg, `Claiming ${some}: sent. Waiting for it to be mined…`, '', hash);
            const r = await W.waitFor(hash);
            if (!r || r.status !== '0x1') throw new Error(`The claim of ${some} did not go through.`);
          }
          say(yoursMsg, `Claimed ${list}: each has its own contract now, holding your token.`, 'ok');
        } else {
          for (const e of ready) await sendAndWait(yoursMsg, me, A.factory, 'claim(uint256)', [e], 0n, `claim edition #${pad3(e)}`);
          say(yoursMsg, `Claimed ${list}: each has its own contract now, holding your token.`, 'ok');
        }
      });
    }
    if (ev.target.closest('[data-ed-vk]')) {
      withWallet(yoursMsg, async (me) => {
        const vk = await viewingKeyFor(me, yoursMsg);
        await sendAndWait(yoursMsg, me, A.factory, 'registerViewingKey(bytes32)', [Seal.hex(vk.publicKey)], 0n, 'register your viewing key');
        say(yoursMsg, "Viewing key registered. Your editions' keys come in the next batch (the first at sell-out or 24 hours after the editions open, then daily); then you can view and claim them here.", 'ok');
      });
    }
    const edView = ev.target.closest('[data-ed-view]');
    if (edView) withWallet(yoursMsg, async (me) => { await viewEdition(me, Number(edView.dataset.edView)); });
    if (ev.target.closest('[data-settle]')) {
      withWallet(srcMsg, async (me) => {
        // The winner closing it also makes and registers their viewing key on THE SOURCE's new contract, so its key
        // can be sent at once. Signing is free and comes first; declining it never stops the close.
        const winner = S.source && S.source.bidder === lc(me);
        let vk = null;
        if (winner && Seal) {
          try { vk = await viewingKeyFor(me, srcMsg, 'Step 1 of 3: sign once in your wallet to make your viewing key for THE SOURCE. It is free, and the signature never leaves this page.'); }
          catch (_) { vk = null; }
        }
        await sendAndWait(srcMsg, me, A.source, 'settle()', [], 0n, vk ? 'step 2 of 3, close the auction' : 'close the auction');
        if (!winner) { say(srcMsg, 'Closed. THE SOURCE has its own contract now, held by the winner. The editions are next.', 'ok'); return; }
        let note = ' Next: create your viewing key below, so its key can be sent to you.';
        if (vk) {
          try {
            const [piece] = await W.read(A.source, 'pieceContract()(address)', []);
            await sendAndWait(srcMsg, me, piece, 'registerViewingKey(bytes32)', [Seal.hex(vk.publicKey)], 0n, 'step 3 of 3, register your viewing key');
            note = " Your viewing key is registered: THE SOURCE's key comes to it within 24 hours.";
          } catch (_) { /* the button stays below */ }
        }
        say(srcMsg, `Closed. THE SOURCE is yours, in its own contract.${note}`, 'ok');
      });
    }
    if (ev.target.closest('[data-refund]')) {
      withWallet(srcMsg, async (me) => {
        await sendAndWait(srcMsg, me, A.source, 'withdrawRefund()', [], 0n, 'withdraw your outbid bid');
        say(srcMsg, 'Your outbid ETH is back in your wallet.', 'ok');
      });
    }
    if (ev.target.closest('[data-src-vk]')) {
      withWallet(revealMsg, async (me) => {
        const vk = await viewingKeyFor(me);
        await sendAndWait(revealMsg, me, S.source.piece, 'registerViewingKey(bytes32)', [Seal.hex(vk.publicKey)], 0n, 'register your viewing key');
        say(revealMsg, "Viewing key registered. The curator sends THE SOURCE's key to it next.", 'ok');
      });
    }
    if (ev.target.closest('[data-src-view]')) {
      withWallet(revealMsg, async (me) => { await viewPrivately(me); });
    }
    if (ev.target.closest('[data-src-private-close]')) { closePrivate(); say(revealMsg, ''); }
    const srcPng = ev.target.closest('[data-src-png]');
    if (srcPng && drawn) {
      const white = srcPng.dataset.srcPng === 'white';
      artPng(drawn.svg, white).then((png) => saveFile(png, `ARTIFACTS-THE-SOURCE${white ? '-white' : ''}.png`), (e) => say(revealMsg, e.message, 'error'));
    }
    if (ev.target.closest('[data-reveal]')) {
      W.ask({
        title: 'Reveal THE SOURCE, forever',
        body: "This publishes THE SOURCE's key on-chain. From then on everyone sees it: on this page, on marketplaces, everywhere.",
        points: ['It cannot be undone, by you, the curator or anyone.', 'You still own it. Only its privacy ends.', 'Every edition stays sealed; this reveals THE SOURCE alone.'],
        confirm: 'Reveal forever',
        cancel: 'Keep it sealed',
        danger: true,
        check: 'I understand THE SOURCE becomes public forever.',
      }).then((yes) => { if (yes) withWallet(revealMsg, async (me) => {
        if (!S.source.sealed) {
          await sendAndWait(revealMsg, me, S.source.piece, 'setRevealed()', [], 0n, 'reveal THE SOURCE');
        } else {
          const key = await sourceKey(me);
          await sendAndWait(revealMsg, me, S.source.piece, 'reveal(bytes32)', [Seal.hex(key)], 0n, 'reveal THE SOURCE');
        }
        closePrivate();
        say(revealMsg, 'THE SOURCE is revealed, forever.', 'ok');
      }); });
    }
  });

  $('[data-bid-form]').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const amount = parseEth($('[data-bid-input]').value);
    withWallet(srcMsg, async (me) => {
      if (!amount) throw new Error('Enter your bid in ETH, for example 0.5.');
      await readSource();
      if (gateLive(S.source.gate) && !S.source.gate.ok) {
        const whole = S.source.gate.endsAt >= S.source.endTime;
        throw new Error(whole ? `Holders only: this auction needs ${gateWho(S.source.gate)} in the bidding wallet.` : `Holders only until ${gateUntil(S.source.gate.endsAt)}: this wallet needs ${gateWho(S.source.gate)}.`);
      }
      const min = minimumBid(S.source);
      if (amount < min) throw new Error(`The lowest bid that counts now is ${eth(min)}.`);
      await sendAndWait(srcMsg, me, A.source, 'bid(address)', [broker], amount, `bid ${eth(amount)} on THE SOURCE`);
      say(srcMsg, `You are the high bidder at ${eth(amount)}.`, 'ok');
    });
  });

  W.onChange(() => {
    S.mine = []; S.editions = {}; S.minted = 0; S.viewingKey = undefined; S.pending = []; S.stuck = [];
    if (!busy) refresh();
  });
  refresh();
  let lastRefresh = Date.now();
  setInterval(() => {
    if (busy || document.visibilityState !== 'visible') return;
    const src = S.source;
    const closing = src && src.open && !src.settled && secondsLeft(src) < 15 * 60;
    if (Date.now() - lastRefresh >= (closing ? 5000 : 20000)) { lastRefresh = Date.now(); refresh(); }
  }, 1000);
})();
