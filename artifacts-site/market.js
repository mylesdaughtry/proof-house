// ARTIFACTS market: resale through each piece's own contract (keyed escrow). The buyer pays in with a viewing key;
// the seller's browser re-wraps the piece's key to it; the buyer's browser checks the key opens the piece, then
// releases. Keys are only ever unwrapped and re-wrapped in the browser. Nothing is custodied by the site.
(function () {
  'use strict';
  const W = window.ProofHouseWallet;
  const Seal = window.ProofHouseSeal;
  const C = window.ArtifactsChain;
  const page = document.querySelector('[data-market]');
  if (!W || !Seal || !C || !page) return;

  const $ = (sel) => page.querySelector(sel);
  const eth = (wei) => `${W.units(wei)} ETH`;
  const msg = $('[data-msg]');
  const ESCROW_SECONDS = 72 * 3600;
  const SELLER_WINDOW = 24 * 3600; // from v13: from paying, only the seller ends a sale (key or refund) for 24 hours
  // In the window's last hour this page won't send a key: a key in a pending transaction can be read, and the buyer
  // could cancel at the window's end ahead of it, seeing the art and taking their money back. A refund instead.
  const KEY_CUTOFF = 3600;
  const clockNow = () => Math.max(now, Math.floor(Date.now() / 1000)); // the later of the chain's and this computer's
  const tooLateForKey = (e) => keyed(e) && clockNow() >= e.paidAt + SELLER_WINDOW - KEY_CUTOFF;
  const TOO_LATE = 'Too late to send the key safely: the buyer may cancel soon, and a key waiting in a pending transaction can be read before it lands. Refund the buyer instead: they get their payment back, you keep the piece and can list it again.';
  const keyed = (e) => !/^0x0+$/.test(e.viewingKey || '0x0'); // a v13 escrow (keys checked, a seller's window)
  const when = (t) => new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const keyAt = (e) => e.keyPostedAt || e.paidAt; // the 72 hours count from the key (pieces before v13: from paying)

  function say(text, tone, hash) {

    W.notify(text, tone, hash);
    msg.textContent = text;
    msg.dataset.tone = tone || '';
    const href = hash && W.explorer('tx', hash);
    if (href) { msg.append(' '); const a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'View transaction'; msg.append(a); }
  }
  W.setMessage(say);

  // The agent who brought this visitor (?broker=0x…), remembered for the session.
  let broker = W.ZERO;
  try {
    const fromUrl = new URLSearchParams(location.search).get('broker');
    if (fromUrl && W.ADDR.test(fromUrl)) { broker = C.lc(fromUrl); sessionStorage.setItem('ar-broker', JSON.stringify(broker)); }
    else { const saved = JSON.parse(sessionStorage.getItem('ar-broker')); if (typeof saved === 'string' && W.ADDR.test(saved)) broker = C.lc(saved); }
  } catch (_) { /* storage off */ }

  let pieces = [];
  let stats = null;
  let now = 0;
  let busy = false;

  // ---------- viewing keys: one signature per visit, kept in memory only ----------
  // The key format the contracts use: version 2 when the piece template checks fake keys (contracts from v13), else 1.
  let keyScheme = null;
  async function scheme() {
    if (keyScheme === null) keyScheme = await W.keyScheme(C.A.piece);
    return keyScheme;
  }
  let viewing = null; // { owner, ring, steady }
  // fresh: a key is about to be registered (a purchase), so the wallet must first show it signs the same way every
  // time; otherwise the key it buys with could never be made again to open what the seller sends
  async function ringFor(me, fresh = false) {
    const v = await scheme();
    const message = Seal.viewingMessage(v, W.cfg.chainId);
    if (!viewing || viewing.owner !== me) {
      say('Sign in your wallet to unlock your viewing key. The signature stays on this page and is never sent.');
      const sig = await W.signMessage(me, message);
      viewing = { owner: me, ring: Seal.keyring(Seal.fromHex(sig)), steady: false };
    }
    if (fresh && v === 2 && !viewing.steady) {
      say('Sign once more: this checks your wallet makes the same viewing key every time, before you buy with it.');
      const again = Seal.keyring(Seal.fromHex(await W.signMessage(me, message)));
      if (Seal.hex(again.wallet.publicKey) !== Seal.hex(viewing.ring.wallet.publicKey)) {
        viewing = null;
        throw new Error('This wallet signed the same message two different ways, so a viewing key made from it could not be made '
          + 'again, and the key the seller sends could never be opened. Nothing was bought. Use a wallet that signs the same '
          + 'way every time (MetaMask, Rabby, Coinbase Wallet or a Ledger, for example).');
      }
      viewing.steady = true;
    }
    return viewing.ring;
  }
  // The key to buy a piece with: one of its own for this piece, so a fake-key proof can never reveal anything else.
  async function buyKeyFor(p, me) {
    const ring = await ringFor(me, true);
    return (await scheme()) === 2 ? ring.forPiece(W.cfg.chainId, p.address) : ring.v1();
  }
  // Every key this wallet may hold a piece with: its key for this piece (bought here), its wallet key (first claim).
  async function keysFor(p, me) {
    const ring = await ringFor(me);
    return [ring.forPiece(W.cfg.chainId, p.address), ring.wallet, (await scheme()) === 1 ? await ring.v1() : null];
  }
  async function keyFrom(p, me, wrapped) {
    const [[commitment], keys] = await Promise.all([W.read(p.address, 'commitment()(bytes32)', []), keysFor(p, me)]);
    const key = await Seal.openKey(wrapped, keys, p.id, commitment);
    if (!key) throw new Error("This key doesn't open the piece with this wallet's viewing keys. If you registered a key some other way (not by signing here), use that key, as the docs describe.");
    return key;
  }
  // The key a wallet held before it moved the piece away (a transfer clears the piece's copy): from the chain's
  // history, every wrapped key ever sent into this piece (posted with a sale, re-keyed, delivered) and, for an
  // edition, the curator's first-claim key, tried against this wallet's viewing keys and the piece's commitment.
  const KEY_EVENTS = [W.keccakHex('WrappedKeyPosted(address,address)'), W.keccakHex('EscrowKeyPosted()')];
  async function formerKey(p, me, commitment) {
    say('Looking for the key you held in the chain\'s history…');
    const found = [];
    if (!p.isSource) {
      const h = (await C.call(C.A.factory, W.encodeCall('wrappedKeyOf(uint256)', [p.id]))).slice(2);
      const b = C.bytesAt(h, C.num(h, 0));
      if (b.length) found.push(b);
    }
    const logs = await W.logs({ address: p.address, topics: [KEY_EVENTS] }, C.deployBlock || 0).catch(() => []);
    for (const l of logs.slice(-12)) {
      const tx = await W.rpc('eth_getTransactionByHash', [l.transactionHash]).catch(() => null);
      // any 65-byte version 2 key in its calldata (a direct call, a batch, or one made through a smart wallet)
      for (const m of String((tx && tx.input) || '').toLowerCase().matchAll(/0{62}41(02[0-9a-f]{128})/g)) found.push(Seal.fromHex(m[1]));
    }
    const keys = await keysFor(p, me);
    for (const w of found.reverse()) {
      const key = await Seal.openKey(w, keys, p.id, commitment).catch(() => null);
      if (key) return key;
    }
    throw new Error("No key this wallet held for this piece was found in the chain's history. If you registered a key some other way, re-key it with tools/source/viewing_key.js (rewrap), as the docs describe.");
  }
  async function heldKey(p, me) {
    const h = (await C.call(p.address, W.encodeCall('wrappedKey()', []))).slice(2);
    return keyFrom(p, me, C.bytesAt(h, C.num(h, 0)));
  }

  // ---------- drawing ----------
  // the button that started the current action says so, right where it was pressed
  let working = null;
  const btn = (attr, label, dark) => `<button class="btn sm${dark ? ' dark' : ''}" type="button" ${attr} ${busy ? 'disabled' : ''}${busy && attr === working ? ' aria-busy="true"' : ''}>${busy && attr === working ? 'Working…' : label}</button>`;
  const contract = (p) => { const href = W.explorer('address', p.address); return `<p class="contract">its own contract · ${href ? `<a href="${C.esc(href)}" target="_blank" rel="noopener">${W.short(p.address)}</a>` : W.short(p.address)}</p>`; };
  const card = (p, body) => `<article class="card" id="p-${p.address}" data-piece-id="${p.isSource ? 256 : p.id}">${C.windowFor(p)}<div class="body">${body}${contract(p)}</div></article>`;
  // A shared link (#piece-42, #piece-256 for THE SOURCE) scrolls to that piece once it is on the page.
  let jumped = false;
  function jump() {
    const m = /^#piece-(\d{1,3})$/.exec(location.hash);
    if (jumped || !m) return;
    const el = page.querySelector(`[data-piece-id="${Number(m[1])}"]`);
    if (!el) return;
    jumped = true;
    el.classList.add('target');
    el.scrollIntoView({ block: 'center' });
  }
  const label = (p) => (p.isSource ? 'THE SOURCE' : `ARTIFACTS #${C.pad3(p.id)}`);

  // the collection at a glance: floor, share listed, volume, holders
  function renderStats() {
    if (!stats) return;
    const set = (k, v, n) => { $(`[data-stat="${k}"]`).textContent = v; $(`[data-stat-note="${k}"]`).textContent = n; };
    const pct = stats.supply ? (100 * stats.listed) / stats.supply : 0;
    set('floor', stats.floor !== null ? eth(stats.floor) : 'none', stats.floor !== null ? 'lowest listing' : 'nothing listed yet');
    set('listed', `${pct && pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`, `${stats.listed} of ${stats.supply} piece${stats.supply === 1 ? '' : 's'}`);
    set('volume', eth(stats.primary + stats.resale), `${W.units(stats.primary)} primary · ${W.units(stats.resale)} resale`);
    set('holders', String(stats.holders), stats.holders === 1 ? 'wallet' : 'unique wallets');
  }

  function render() {
    renderStats();
    const me = W.account();
    const listed = pieces.filter(C.isListed);
    const forSale = listed.filter((p) => !(me && (p.owner === me || p.escrow.buyer === me)));
    $('[data-listed-meta]').textContent = `${listed.length} listed · ${pieces.length} piece contract${pieces.length === 1 ? '' : 's'} on-chain`;
    C.paint($('[data-listed]'), forSale.length ? forSale.map((p) => {
      const e = p.escrow;
      if (e.buyer !== W.ZERO) return card(p, `<p class="price">${eth(e.price)}</p><p class="state">In escrow: a buyer has paid.</p>`);
      // a seller without the piece's key could never send one: no Buy until they hold it (it arrives from the curator
      // or the previous owner)
      if (!p.hasKey) return card(p, `<p class="price">${eth(e.price)}</p><p class="state">seller ${W.short(e.seller)} · not buyable yet: the seller doesn't hold its key</p>`);
      return card(p, `<p class="price">${eth(e.price)}</p><p class="state">seller ${W.short(e.seller)}</p>${btn(`data-buy="${p.address}"`, `Buy · ${eth(e.price)}`, true)}`);
    }).join('') : '<p class="empty">Nothing is listed right now. Owners list from here once their piece is claimed.</p>');

    const mine = me ? pieces.filter((p) => p.owner === me || p.escrow.buyer === me || p.pending > 0n || owesKey(p, me)) : [];
    const sec = $('[data-yours]');
    sec.hidden = mine.length === 0;
    if (!sec.hidden) {
      $('[data-yours-meta]').textContent = W.short(me);
      C.paint($('[data-yours-grid]'), mine.map((p) => card(p, mineBody(p, me))).join(''));
      page.querySelectorAll('[data-price-for]').forEach((i) => { if (i.value) showNet(i); });
    }
  }

  // ---------- your pieces: a status line with the price, what it means for you, then the actions ----------
  const SELLER_BPS = 9250n; // a seller keeps 92.5% with no agent on the sale (90% with one); 7.5% is the artist's
  const editing = new Set(); // pieces whose listed price is being changed
  const head = (label, tone, price) => `<div class="own-head"><span class="chip${tone ? ` ${tone}` : ''}">${label}</span>${price ? `<span class="own-price">${price}</span>` : ''}</div>`;
  const note = (text, attr = '') => `<p class="net"${attr}>${text}</p>`;
  const netText = (wei) => (wei ? `You receive up to ${eth((wei * SELLER_BPS) / 10000n)} · 7.5% to the artist` : 'You receive up to 92.5% of your price · 7.5% to the artist');
  const acts = (...buttons) => `<div class="acts${buttons.length === 1 ? ' one' : ''}">${buttons.join('')}</div>`;
  const listForm = (p, value, reprice) => `<div class="listrow"><label class="eth-field"><input class="field" inputmode="decimal" placeholder="0.05" aria-label="Price in ETH" data-price-for="${p.address}"${value ? ` value="${value}"` : ''}><span>ETH</span></label>${btn(`data-list="${p.address}"${reprice ? ' data-reprice-list' : ''}`, reprice ? 'Relist' : 'List', true)}</div>`;

  // A piece this wallet moved to someone (a gift, a sale elsewhere) that hasn't had its key since: only it can re-key it.
  const owesKey = (p, me) => !!me && p.previousOwner === me && p.owner !== me && !p.hasKey;
  function mineBody(p, me) {
    const e = p.escrow;
    const parts = [];
    if (owesKey(p, me)) {
      parts.push(head(`Sent to ${W.short(p.owner)} · send its key`, 'alert')
        + note("Its new owner can't view it, list it or sell it without the key, and only you can send it now: this page finds the key you held, opens it with your viewing key and wraps it to theirs. They register a key on the piece first, from this page.")
        + acts(btn(`data-rekey="${p.address}"`, 'Send its key to the new owner', true)));
      return parts.join('');
    }
    if (p.pending > 0n) parts.push(head('To withdraw', 'live', eth(p.pending)) + note("From a sale, waiting in this piece's contract.") + acts(btn(`data-withdraw="${p.address}"`, `Withdraw ${eth(p.pending)}`, true)));
    if (e.buyer === me) {
      if (!e.keyPosted) {
        // the seller has 24 hours to send the key or refund; then the buyer may cancel (pieces before v13: any time)
        const from = keyed(e) ? e.paidAt + SELLER_WINDOW : 0;
        parts.push(head('Paid · waiting for the key', 'wait', eth(e.price))
          + note(now >= from ? 'The key hasn\'t come: you can cancel and take your ETH back.' : `The seller has until ${when(from)} to send the key or refund you. If it hasn't come by then, you can cancel and take your ETH back.`)
          + (now >= from ? acts(btn(`data-cancel="${p.address}"`, 'Cancel and refund')) : ''));
      }
      else {
        parts.push(head('Key arrived · action needed', 'wait', eth(e.price))
          + note(`Your browser checks it opens the piece, then you release the payment${e.deposit ? '; if it doesn\'t, you prove it and take back your ETH and the seller\'s deposit' : ''}. Check it by ${when(keyAt(e) + ESCROW_SECONDS)}: after that anyone can release it.`)
          + acts(btn(`data-confirm="${p.address}"`, 'Check the key and confirm', true)));
      }
    } else if (p.owner === me) {
      if (!C.isListed(p)) {
        if (!p.hasKey) {
          const from = p.previousOwner !== W.ZERO ? `its previous owner, ${W.short(p.previousOwner)}` : 'the curator';
          parts.push(head('Yours · waiting for its key', '') + (p.myKey
            ? note(`Your key for this piece is registered. Its key comes from ${from}, who sends it from this page; until then it can't be viewed or sold through escrow.`)
            : note(`Its key comes from ${from}, wrapped to a key you register on this piece. Register yours, then let them know.`) + acts(btn(`data-regkey="${p.address}"`, 'Register your key on this piece', true))));
        }
        else parts.push(head('Not listed', '') + listForm(p, '', false) + note(netText(0n), ` data-net-for="${p.address}"`));
      } else if (e.buyer === W.ZERO) {
        if (editing.has(p.address)) {
          parts.push(head('Listed', 'live', eth(e.price)) + listForm(p, W.units(e.price), true) + note(netText(e.price), ` data-net-for="${p.address}"`)
            + note('Two confirmations: off the market, then listed at the new price.') + acts(btn(`data-reprice-cancel="${p.address}"`, 'Keep this price')));
        } else {
          parts.push(head('Listed', 'live', eth(e.price)) + note(netText(e.price)) + acts(btn(`data-reprice="${p.address}"`, 'Change price'), btn(`data-delist="${p.address}"`, 'Unlist')));
        }
      } else if (!e.keyPosted && tooLateForKey(e)) {
        parts.push(head('Paid · refund the buyer', 'alert', eth(e.price))
          + note(`The time to send the key ended at ${when(e.paidAt + SELLER_WINDOW - KEY_CUTOFF)}. ${TOO_LATE}`)
          + acts(btn(`data-refund-buyer="${p.address}"`, 'Refund the buyer', true)));
      } else if (!e.keyPosted) {
        const v2 = keyed(e);
        parts.push(head('Paid · send the key', 'alert', eth(e.price))
          + note(`${W.short(e.buyer)} paid into escrow. Sending re-wraps the piece's key to their viewing key, in this browser${v2 ? `, with a deposit of ${eth(e.price / 10n)} that comes back with the payment. Or refund them and keep the piece. Send it by ${when(e.paidAt + SELLER_WINDOW - KEY_CUTOFF)}: after that this page only offers the refund, and from ${when(e.paidAt + SELLER_WINDOW)} the buyer may cancel` : ''}.`)
          + acts(btn(`data-sendkey="${p.address}"`, 'Send the key to the buyer', true), ...(v2 ? [btn(`data-refund-buyer="${p.address}"`, 'Refund the buyer')] : [])));
      } else {
        const due = keyAt(e) + ESCROW_SECONDS;
        parts.push(head('Key sent', 'wait', eth(e.price)) + note(`The buyer confirms, or anyone can release it after ${when(due)}.`) + (now >= due ? acts(btn(`data-release="${p.address}"`, 'Release the payment', true)) : ''));
      }
      if (p.revealed) parts.push(acts(btn(`data-png="${p.address}"`, 'Transparent PNG'), btn(`data-pngwhite="${p.address}"`, 'White PNG')));
      if (!(p.isSource && p.revealed) && p.hasKey) parts.push(`<button class="linkbtn" type="button" data-view="${p.address}" ${busy ? 'disabled' : ''}>View privately →</button>`);
    }
    return parts.join('') || note('nothing yet');
  }

  const RETRY = 'Could not read the chain just now. Retrying…';
  // One read at a time, so an older answer never paints over a newer one; a refresh asked for meanwhile runs once after.
  let reading = null;
  let again = false;
  function refresh() {
    if (reading) { again = true; return reading; }
    reading = (async () => { do { again = false; await readOnce(); } while (again); })().finally(() => { reading = null; });
    return reading;
  }
  async function readOnce() {
    try {
      ({ pieces, now, stats } = await C.readPieces());
      if (msg.textContent === RETRY) say('');
    } catch (e) { say(RETRY, 'error'); }
    render();
    jump();
  }

  // ---------- actions ----------
  // Sends from the wallet the action started with; if the wallet changed meanwhile, stop (a key or a viewing key
  // made for one wallet must never go out from another).
  let actor = null;
  async function run(what, to, data, value) {
    const me = actor;
    if (!me || (W.account() || '').toLowerCase() !== me.toLowerCase()) throw new Error('Your wallet changed during this step, so nothing was sent. Start again.');
    await W.rpc('eth_call', [{ from: me, to, data, value: '0x' + (value || 0n).toString(16) }, 'latest']); // a refusal shows before signing
    say(`Confirm in your wallet: ${what}.`);
    const hash = await W.sendData(me, to, data, value);
    say(`${what}: sent. Waiting for it to be mined…`, '', hash);
    const r = await W.waitFor(hash);
    if (!r) throw new Error('Still not mined after 15 minutes. Check the transaction in your wallet.');
    if (r.status !== '0x1') throw new Error(`The contract refused: ${what}.`);
    return hash;
  }
  async function act(work) {
    if (busy) return;
    busy = true;
    render();
    try {
      if (!W.account()) await W.connect(true);
      await W.ensureChain();
      actor = W.account();
      await work(actor);
    } catch (e) {
      say(W.friendly(e), 'error');
    } finally {
      busy = false;
      working = null;
      actor = null;
      await refresh();
    }
  }
  const bytesCall = (sig, bytes) => {
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return W.keccakHex(sig).slice(0, 10) + C.pad32(32) + C.pad32(bytes.length) + hex.padEnd(Math.ceil(bytes.length / 32) * 64, '0');
  };
  function parseEth(v) {
    const m = /^\s*(\d*)(?:\.(\d{0,18}))?\s*$/.exec(v || '');
    if (!m || (!m[1] && !m[2])) return null;
    const wei = BigInt(m[1] || '0') * 10n ** 18n + BigInt((m[2] || '').padEnd(18, '0') || '0');
    return wei > 0n ? wei : null;
  }

  // THE SOURCE, privately: open its sealed seed with the key you hold and draw it with the rules stored on-chain.
  const viewer = document.querySelector('[data-viewer]');
  let viewerUrl = null;
  let viewerSvg = null;
  let viewerName = '';
  viewer.querySelectorAll('[data-viewer-png]').forEach((b) => b.addEventListener('click', () => {
    const white = b.dataset.viewerPng === 'white';
    if (viewerSvg) C.artPng(viewerSvg, white).then((png) => C.saveFile(png, white ? viewerName.replace(/\.png$/, '-white.png') : viewerName), (e) => say(e.message, 'error'));
  }));
  // Your piece, privately: its key (wrapped to your viewing key) opens its seed, and the chain's rules draw it here.
  // THE SOURCE's seed is sealed with a keystream of K; an edition's with AES-GCM, bound to its id.
  async function viewPiece(p, me) {
    const key = await heldKey(p, me);
    let seed;
    if (p.isSource) {
      const [sealed] = await W.read(C.A.source, 'sealedSeed()(bytes32)', []);
      seed = Seal.hex(Seal.keystreamXor(Seal.fromHex(sealed), key));
    } else {
      const ct = (await C.call(C.A.factory, W.encodeCall('ciphertextOf(uint256)', [p.id]))).slice(2);
      seed = Seal.hex(await Seal.openSeed(C.bytesAt(ct, C.num(ct, 0)), key, p.id));
    }
    const h = (await C.call(C.A.source, W.encodeCall('rendererChunks()', []))).slice(2);
    const ptrs = Array.from({ length: C.num(h, C.num(h, 0)) }, (_, i) => '0x' + C.word(h, C.num(h, 0) + 32 + i * 32).slice(24));
    const codes = await Promise.all(ptrs.map((x) => W.rpc('eth_getCode', [x, 'latest'])));
    const bytes = codes.map((c) => Seal.fromHex(c).slice(1));
    const pageBytes = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0));
    bytes.reduce((at, b) => { pageBytes.set(b, at); return at + b.length; }, 0);
    let suffix = C.decodeString(await C.call(p.address, W.encodeCall('RENDER_SUFFIX()', [])));
    if (!p.isSource) {
      const edition = suffix.replace('"),true);', `"),false,${p.id});`); // the same rules: not the master, and its number (R8)
      if (edition === suffix) throw new Error('The renderer page on-chain ends differently than this page expects.');
      suffix = edition;
    }
    viewerName = p.isSource ? 'ARTIFACTS-THE-SOURCE.png' : `ARTIFACTS-${C.pad3(p.id)}.png`;
    viewer.querySelector('[data-viewer-title]').textContent = `◆ ${label(p)} · private view · drawn in this browser, sent nowhere`;
    const box = viewer.querySelector('[data-viewer-art]');
    box.replaceChildren(Object.assign(document.createElement('p'), { className: 'note', textContent: 'Drawing from its seed…' }));
    viewerModal.open();
    let svg;
    try {
      svg = await C.drawWithPage(new TextDecoder().decode(pageBytes) + seed + suffix);
    } catch (e) {
      viewerModal.close(); // never left on "Drawing…"
      throw e;
    }
    if (viewer.hidden) return; // closed while it drew
    viewerSvg = svg;
    viewer.querySelectorAll('[data-viewer-png]').forEach((b) => { b.hidden = false; });
    if (viewerUrl) URL.revokeObjectURL(viewerUrl);
    viewerUrl = URL.createObjectURL(new Blob([C.cropToArt(svg)], { type: 'image/svg+xml' }));
    const img = document.createElement('img');
    img.src = viewerUrl;
    img.alt = `${label(p)}, drawn privately in this browser`;
    box.replaceChildren(img);
    say('Only you are seeing this. It is drawn here and gone when you close it.', 'ok');
  }
  const viewerModal = C.modal(viewer, () => {
    viewer.querySelector('[data-viewer-art]').replaceChildren();
    if (viewerUrl) { URL.revokeObjectURL(viewerUrl); viewerUrl = null; }
    viewerSvg = null;
    viewer.querySelectorAll('[data-viewer-png]').forEach((b) => { b.hidden = true; });
  });

  const showNet = (i) => {
    const net = page.querySelector(`[data-net-for="${i.dataset.priceFor}"]`);
    if (net) net.textContent = netText(parseEth(i.value) || 0n);
  };
  page.addEventListener('input', (ev) => { const i = ev.target.closest('[data-price-for]'); if (i) showNet(i); });

  page.addEventListener('click', (ev) => {
    const t = ev.target.closest('button');
    if (!t || t.disabled) return;
    const d = t.dataset;
    // the attribute this button was drawn with, so the redraw can mark it as working
    const k = Object.keys(d).find((x) => d[x] && /^0x/.test(d[x]));
    working = k ? `data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${d[k]}"` : null;
    const p = pieces.find((x) => x.address === (d.buy || d.list || d.delist || d.sendkey || d.confirm || d.cancel || d.release || d.withdraw || d.view || d.png || d.pngwhite || d.reprice || d.repriceCancel || d.refundBuyer || d.regkey || d.rekey));
    if (!p) return;
    if (d.png || d.pngwhite) {
      const white = !!d.pngwhite;
      C.revealedSvg(p.address)
        .then((svg) => { if (!svg) throw new Error('This piece is still sealed.'); return C.artPng(svg, white); })
        .then((png) => C.saveFile(png, `${p.isSource ? 'ARTIFACTS-THE-SOURCE' : `ARTIFACTS-${C.pad3(p.id)}`}${white ? '-white' : ''}.png`), (e) => say(e.message, 'error'));
      return;
    }
    if (d.buy) act(async (me) => {
      const e = p.escrow;
      const yes = await W.ask({
        title: `Buy ${label(p)}`,
        body: `${eth(e.price)}, paid into the piece's own escrow, not to the seller.`,
        points: [
          'You sign once to unlock your viewing key, then confirm the payment.',
          'The seller has 24 hours to send the piece\'s key to your viewing key, or refund you. If it hasn\'t come by then, you can cancel and take your ETH back.',
          'Your browser checks the key opens the piece before you release the payment. If it doesn\'t, you prove it and take back your ETH and the seller\'s 10% deposit.',
        ],
        confirm: `Buy · ${eth(e.price)}`,
      });
      if (!yes) return;
      const vk = await buyKeyFor(p, me);
      // a piece that checks keys takes only a version 2 key; anything else would leave the buyer unable to prove a fake
      if ((await scheme()) === 2 && (vk.scheme !== 2 || !Seal.isViewingKeyV2(vk.publicKey))) throw new Error('This browser made a viewing key the piece cannot use. Nothing was sent. Reload the page and try again.');
      const hash = await run(`buy ${label(p)} for ${eth(e.price)}`, p.address, W.encodeCall('buy(bytes32,address)', [Seal.hex(vk.publicKey), broker]), e.price);
      say('Paid into escrow. The seller sends you the key next; it shows under Yours.', 'ok', hash);
    });
    // after a plain transfer: the new owner registers its key for this piece, then the previous owner re-keys it
    if (d.regkey) act(async (me) => {
      if ((await scheme()) !== 2) throw new Error('This older test piece takes keys another way (see the docs).');
      const ring = await ringFor(me, true); // a key someone will wrap to: the wallet must make it the same way every time
      const vk = ring.forPiece(W.cfg.chainId, p.address);
      const hash = await run(`register your key on ${label(p)}`, p.address, W.encodeCall('registerViewingKey(bytes32)', [Seal.hex(vk.publicKey)]));
      say(`Registered. ${p.previousOwner !== W.ZERO ? `Now ${W.short(p.previousOwner)}, its previous owner, can send you its key from this page.` : 'The curator can now send you its key.'}`, 'ok', hash);
    });
    if (d.rekey) act(async (me) => {
      if ((await scheme()) !== 2) throw new Error('This older test piece is re-keyed another way (see the docs).');
      const [[to], [commitment]] = await Promise.all([
        W.read(p.address, 'viewingKeyOf(address)(bytes32)', [p.owner]), W.read(p.address, 'commitment()(bytes32)', []),
      ]);
      if (/^0x0+$/.test(to)) throw new Error(`${W.short(p.owner)} hasn't registered a key on this piece yet. Ask them to open this page and register one, then send it.`);
      const key = await formerKey(p, me, commitment);
      const wrapped = Seal.wrapKeyV2(key, Seal.fromHex(to), p.id);
      const hash = await run(`send ${label(p)}'s key to its new owner`, p.address, bytesCall('rewrapFor(bytes)', wrapped));
      say(`Key sent: ${W.short(p.owner)} can view, list and sell ${label(p)} now.`, 'ok', hash);
    });
    if (d.reprice) { editing.add(p.address); render(); return; }
    if (d.repriceCancel) { editing.delete(p.address); render(); return; }
    // read the price before the page goes busy and redraws the card
    const listPrice = d.list ? parseEth(page.querySelector(`[data-price-for="${p.address}"]`).value) : null;
    const reprice = d.list ? 'repriceList' in d : false;
    if (d.list) act(async () => {
      const price = listPrice;
      if (!price) throw new Error('Enter a price in ETH, for example 0.05 or 1.');
      if (reprice) await run(`take ${label(p)} off the market`, p.address, W.encodeCall('delist()', []));
      const hash = await run(`list ${label(p)} at ${eth(price)}`, p.address, W.encodeCall('list(uint256)', [price]));
      editing.delete(p.address);
      say(`${label(p)} is listed at ${eth(price)}.`, 'ok', hash);
    });
    if (d.delist) act(async () => { const hash = await run(`take ${label(p)} off the market`, p.address, W.encodeCall('delist()', [])); say(`${label(p)} is off the market.`, 'ok', hash); });
    if (d.sendkey) act(async (me) => {
      const e = p.escrow;
      const v2 = (await scheme()) === 2;
      const deposit = v2 ? (await W.read(p.address, 'depositFor(uint256)(uint256)', [e.price]))[0] : 0n;
      if (tooLateForKey(e)) throw new Error(TOO_LATE);
      if (v2) {
        const late = clockNow() >= e.paidAt + SELLER_WINDOW - 2 * 3600;
        const yes = await W.ask({
          title: 'Send the key',
          body: `With it you lock a deposit of ${eth(deposit)} (10% of the price). It comes back with your payment when the sale completes.`,
          points: [
            'This page opens the key you hold, checks it against the piece, then wraps it to the buyer: it is always the real key.',
            'A key that doesn\'t open the piece can be proven fake by the buyer, who then receives your deposit with their payment.',
            ...(late ? [`Send it now or not at all: from ${when(e.paidAt + SELLER_WINDOW - KEY_CUTOFF)} this page only offers the refund, since the buyer may cancel from ${when(e.paidAt + SELLER_WINDOW)} and a key in a pending transaction can be read.`] : []),
          ],
          confirm: `Send the key · ${eth(deposit)} deposit`,
        });
        if (!yes) return;
      }
      if (tooLateForKey(e)) throw new Error(TOO_LATE); // the dialog may have stayed open a while
      const key = await heldKey(p, me);
      // the sale as it is now: a buyer who cancelled and bought again, or changed key, gets the key for that purchase
      const cur = C.decodeEscrow((await C.call(p.address, W.encodeCall('escrow()', []))).slice(2));
      if (cur.buyer !== e.buyer || cur.keyPosted || (v2 && cur.viewingKey.toLowerCase() !== e.viewingKey.toLowerCase())) {
        throw new Error('This sale changed while you were sending the key (the buyer cancelled or bought again). Nothing was sent: check the card and send it again.');
      }
      // to the viewing key the buyer bought with (from v13 the escrow keeps it)
      const to = v2 ? cur.viewingKey : (await W.read(p.address, 'viewingKeyOf(address)(bytes32)', [e.buyer]))[0];
      let data;
      if (v2) {
        // with the proof that this page made it (postEscrowKey checks it), for this buyer and the key they bought with
        const w = Seal.wrapKeyForSale(key, Seal.fromHex(to), p.id, { chainId: W.cfg.chainId, piece: p.address, buyer: cur.buyer, viewingKey: cur.viewingKey });
        const body = Array.from(w.wrapped, (b) => b.toString(16).padStart(2, '0')).join('');
        data = W.keccakHex('postEscrowKey(bytes,address,uint256)').slice(0, 10) + C.pad32(96) + w.r.slice(2).toLowerCase().padStart(64, '0')
          + BigInt(w.z).toString(16).padStart(64, '0') + C.pad32(w.wrapped.length) + body.padEnd(Math.ceil(w.wrapped.length / 32) * 64, '0');
      } else {
        data = bytesCall('postEscrowKey(bytes)', await Seal.wrapKey(key, Seal.fromHex(to), p.id));
      }
      const hash = await run(`send ${label(p)}'s key to the buyer`, p.address, data, deposit);
      say(`Key sent. The buyer confirms, or the payment releases 72 hours after the key${v2 ? ', with your deposit' : ''}.`, 'ok', hash);
    });
    if (d.refundBuyer) act(async () => {
      const yes = await W.ask({ title: 'Refund the buyer', body: `${eth(p.escrow.price)} goes back to ${W.short(p.escrow.buyer)}, and the sale ends. The piece stays yours; you can list it again.`, confirm: 'Refund' });
      if (!yes) return;
      const hash = await run(`refund the buyer of ${label(p)}`, p.address, W.encodeCall('refundBuyer()', []));
      say('Refunded. The piece is yours, unlisted.', 'ok', hash);
    });
    if (d.confirm) act(async (me) => {
      const [[commitment], keys] = await Promise.all([W.read(p.address, 'commitment()(bytes32)', []), keysFor(p, me)]); // a declined signature stops here
      const ok = !!(await Seal.openKey(p.escrow.key, keys, p.id, commitment));
      if (!ok) {
        const e = p.escrow;
        if ((await scheme()) !== 2) throw new Error("The key the seller sent does not open this piece. Don't release it. (A contract can't check a key, so your browser does.)");
        // the proof uses the viewing key this purchase was made with: this page buys with the piece's own key, so the
        // shared point a proof reveals opens nothing but this one wrong key
        const ring = await ringFor(me);
        const own = ring.forPiece(W.cfg.chainId, p.address);
        const want = e.viewingKey.toLowerCase();
        const mine = Seal.hex(own.publicKey).toLowerCase() === want ? own : (Seal.hex(ring.wallet.publicKey).toLowerCase() === want ? ring.wallet : null);
        if (!mine) throw new Error("This key doesn't open the piece, but this purchase was made with a viewing key this signature doesn't make, so this page can't prove it. Use the key you bought with (see the docs).");
        const back = e.price + e.deposit;
        const points = ['The proof reveals nothing secret: only what opens this one wrong key.', 'A key that opens can never be proven fake, so this only works because it really doesn\'t.'];
        // bought with the wallet's own key (another tool): the shared point could also open a key this seller sent that
        // same viewing key before. Say so; the buyer decides.
        if (mine === ring.wallet) points[0] = 'This purchase used your wallet\'s main viewing key, not a key for this piece. The proof could also expose a key this same seller sent you before. Buy with this page next time.';
        const yes = await W.ask({
          title: "This key doesn't open the piece",
          body: `Your browser checked it against the piece and it fails. Prove it on-chain: ${eth(back)} (your payment and the seller's deposit) comes back to you, and the seller keeps the piece.`,
          points,
          confirm: 'Prove it and take my ETH back',
        });
        if (!yes) return;
        const proof = Seal.proveFakeKey(e.key, mine, { chainId: W.cfg.chainId, piece: p.address, buyer: me });
        const data = W.keccakHex('proveFakeKey((uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256))').slice(0, 10)
          + proof.args.map((x) => BigInt(x).toString(16).padStart(64, '0')).join('');
        const hash = await run(`prove ${label(p)}'s key is fake`, p.address, data);
        say(`Proven fake: ${eth(back)} is yours to withdraw under Yours. The seller keeps the piece.`, 'ok', hash);
        return;
      }
      say('Key checked: it opens the piece. Now release the payment.');
      const hash = await run(`release the payment for ${label(p)}`, p.address, W.encodeCall('release()', []));
      say(`${label(p)} is yours, with its key.`, 'ok', hash);
    });
    if (d.cancel) act(async () => { const hash = await run(`cancel and take back ${eth(p.escrow.price)}`, p.address, W.encodeCall('cancel()', [])); say('Cancelled. Withdraw your ETH under Yours.', 'ok', hash); });
    if (d.release) act(async () => { const hash = await run(`release the payment for ${label(p)}`, p.address, W.encodeCall('release()', [])); say('Released.', 'ok', hash); });
    if (d.withdraw) act(async () => { const hash = await run(`withdraw ${eth(p.pending)}`, p.address, W.encodeCall('withdraw()', [])); say(`${eth(p.pending)} is in your wallet.`, 'ok', hash); });
    if (d.view) act(async (me) => viewPiece(p, me));
  });

  $('[data-house]').href = W.cfg.houseUrl || '#';
  if (!W.ADDR.test(C.A.factory || '')) { $('[data-listed]').innerHTML = '<p class="empty">The collection is not on-chain yet. It appears here at launch.</p>'; $('[data-listed-meta]').textContent = 'at launch'; return; }
  W.onChange(() => { viewing = null; if (!busy) refresh(); });
  refresh();
  setInterval(() => { if (!busy && document.visibilityState === 'visible') refresh(); }, 20000);
})();
