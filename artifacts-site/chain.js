// ARTIFACTS site: reading the collection from the chain, shared by the market and the explorer.
// Finds every piece contract (claimed editions from the factory's Claimed events, THE SOURCE from its auction
// contract), reads each one's owner, escrow, traits and key state in a few batched calls, and draws the OS window.
(function () {
  'use strict';
  const W = window.ProofHouseWallet;
  if (!W) return;
  const cfg = W.cfg;
  const A = (((cfg.drops || {}).artifacts || {}).contracts) || {};
  const deployBlock = ((cfg.drops || {}).artifacts || {}).deployBlock || null;
  const lc = (a) => (a || '').toLowerCase();
  const pad3 = (n) => String(n).padStart(3, '0');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';

  // ---------- ABI helpers ----------
  const word = (h, byte) => h.slice(byte * 2, byte * 2 + 64);
  const num = (h, byte) => Number(BigInt('0x' + (word(h, byte) || '0')));
  const big = (h, byte) => BigInt('0x' + (word(h, byte) || '0'));
  const addr = (h, byte) => '0x' + word(h, byte).slice(24);
  const pad32 = (n) => BigInt(n).toString(16).padStart(64, '0');
  const hexToUtf8 = (hex) => new TextDecoder().decode(Uint8Array.from(hex.match(/../g) || [], (x) => parseInt(x, 16)));
  const call = (to, data) => W.rpc('eth_call', [{ to, data }, 'latest']);
  const bytesAt = (h, at) => Uint8Array.from(h.slice((at + 32) * 2, (at + 32 + num(h, at)) * 2).match(/../g) || [], (x) => parseInt(x, 16));
  const decodeString = (ret) => { const h = ret.slice(2); return hexToUtf8(h.slice((num(h, 0) + 32) * 2, (num(h, 0) + 32 + num(h, num(h, 0))) * 2)); };

  const AGG3 = W.keccakHex('aggregate3((address,bool,bytes)[])').slice(0, 10);
  // in parts of 150 calls, all sent at once (the wallet library sends them as one batch)
  async function multicall(calls) {
    const parts = [];
    for (let i = 0; i < calls.length; i += 150) parts.push(calls.slice(i, i + 150));
    return (await Promise.all(parts.map(aggregate))).flat();
  }
  async function aggregate(part) {
    const out = [];
    const tuples = part.map(({ target, data }) => {
      const d = data.slice(2); const len = d.length / 2;
      return target.slice(2).toLowerCase().padStart(64, '0') + pad32(1) + pad32(0x60) + pad32(len) + d.padEnd(Math.ceil(len / 32) * 64, '0');
    });
    let off = part.length * 32;
    const offsets = tuples.map((t) => { const o = pad32(off); off += t.length / 2; return o; }).join('');
    const h = (await call(MULTICALL3, AGG3 + pad32(0x20) + pad32(part.length) + offsets + tuples.join(''))).slice(2);
    const at = num(h, 0); const n = num(h, at); const base = at + 32;
    for (let j = 0; j < n; j++) {
      const t = base + num(h, base + j * 32);
      const b = t + num(h, t + 32);
      out.push({ ok: big(h, t) !== 0n, h: h.slice((b + 32) * 2, (b + 32 + num(h, b)) * 2) });
    }
    return out;
  }

  // escrow() → (uint256 price, address seller, address buyer, uint64 paidAt, bool keyPosted, bytes key, address broker,
  // uint64 keyPostedAt, bytes32 viewingKey, uint256 deposit). Pieces before v13 return the first seven only: their key's
  // bytes start at 0xe0, where the newer fields would be, so those are read only from the ten-field head (key at 0x140).
  const decodeEscrow = (h) => {
    const ten = num(h, 160) === 0x140;
    return {
      price: big(h, 0), seller: lc(addr(h, 32)), buyer: lc(addr(h, 64)), paidAt: num(h, 96), keyPosted: big(h, 128) !== 0n, key: bytesAt(h, num(h, 160)), broker: lc(addr(h, 192)),
      keyPostedAt: ten ? num(h, 224) : 0, viewingKey: ten ? '0x' + word(h, 256) : '0x' + '0'.repeat(64), deposit: ten ? big(h, 288) : 0n,
    };
  };
  function decodeTraits(h) {
    if (!h || h.length < 64 * 5) return null;
    const t = num(h, 0);
    const str = (rel) => { const at = t + rel; return hexToUtf8(h.slice((at + 32) * 2, (at + 32 + num(h, at)) * 2)); };
    const out = { title: str(num(h, t)), palette: str(num(h, t + 32)), k: num(h, t + 64), direction: str(num(h, t + 96)) };
    return out.title ? out : null;
  }

  // ---------- the pieces ----------
  const CLAIMED = W.keccakHex('Claimed(uint256,address,address)');
  const ASSIGNED = W.keccakHex('EditionAssigned(uint256,address,uint256)');
  const PURCHASED = W.keccakHex('Purchased(address,address,uint256,uint256)');
  const RELEASED = W.keccakHex('EscrowReleased(address,address,uint256,uint256,address,uint256)');
  // Every piece contract and the collection's history, for the stats: who was drawn which edition, which are
  // claimed, and every sale's price. Recounted in full from the logs each time (settled logs come from this browser's
  // copy), and one scan at a time, so overlapping refreshes never count a sale twice.
  let finding = null;
  function findPieces() {
    if (!finding) finding = scanPieces().finally(() => { finding = null; });
    return finding;
  }
  async function scanPieces() {
    const known = new Set();
    const history = { buyers: new Map(), claimed: new Set(), primary: 0n, resale: 0n };
    const [[source], factoryLogs] = await Promise.all([
      W.read(A.source, 'pieceContract()(address)', []),
      deployBlock ? W.logs({ address: A.factory, topics: [[CLAIMED, ASSIGNED, PURCHASED]] }, deployBlock) : [],
    ]);
    if (lc(source) !== W.ZERO) known.add(lc(source));
    factoryLogs.forEach((l) => {
      const t = l.topics[0];
      if (t === CLAIMED) { known.add(lc('0x' + l.data.slice(26, 66))); history.claimed.add(Number(BigInt(l.topics[1]))); }
      else if (t === ASSIGNED) history.buyers.set(Number(BigInt(l.topics[1])), lc('0x' + l.topics[2].slice(26)));
      else if (t === PURCHASED) history.primary += BigInt('0x' + l.data.slice(66, 130));
    });
    // resales, from every piece contract (one saved copy, started over when a new piece appears)
    const addresses = Array.from(known).sort();
    const released = deployBlock && addresses.length ? await W.logs({ address: addresses, topics: [RELEASED] }, deployBlock, 'artifacts-resales') : [];
    released.forEach((l) => { if (known.has(lc(l.address))) history.resale += BigInt('0x' + l.data.slice(2, 66)); });
    return { list: Array.from(known), history };
  }

  const SIGS = ['ownerOf(uint256)', 'escrow()', 'pieceId()', 'isSource()', 'traits()', 'revealed()', 'wrappedKey()', 'pendingWithdrawals(address)',
    'previousOwner()', 'viewingKeyOf(address)'];
  async function readPieces() {
    const { list, history } = await findPieces();
    const me = W.account() || W.ZERO;
    const calls = [];
    list.forEach((p) => SIGS.forEach((s) => calls.push({ target: p, data: W.encodeCall(s, s === 'ownerOf(uint256)' ? [1] : /\(address\)$/.test(s) ? [me] : []) })));
    const [res, block, auctionR] = await Promise.all([
      calls.length ? multicall(calls) : [],
      W.rpc('eth_getBlockByNumber', ['latest', false]),
      // THE SOURCE's sale: its winning bid, once the auction is closed
      Promise.all([W.read(A.source, 'settled()(bool)', []), W.read(A.source, 'highBid()(uint256)', [])]).catch(() => null), // no auction yet
    ]);
    const pieces = list.map((address, i) => {
      const r = res.slice(i * SIGS.length, (i + 1) * SIGS.length);
      if (!r[0].ok || !r[1].ok) return null;
      return {
        address, owner: lc(addr(r[0].h, 0)), escrow: decodeEscrow(r[1].h), id: num(r[2].h, 0), isSource: big(r[3].h, 0) !== 0n,
        traits: decodeTraits(r[4].h), revealed: big(r[5].h, 0) !== 0n, hasKey: r[6].ok && num(r[6].h, num(r[6].h, 0)) > 0, pending: big(r[7].h, 0),
        // who may re-key it after a plain transfer, and this wallet's viewing key on it (zero: none registered)
        previousOwner: r[8].ok ? lc(addr(r[8].h, 0)) : W.ZERO, myKey: r[9].ok && big(r[9].h, 0) !== 0n,
      };
    }).filter(Boolean).sort((a, b) => a.id - b.id);
    const auction = auctionR && auctionR[0][0] ? BigInt(auctionR[1][0]) : 0n;
    return { pieces, now: Number(BigInt(block.timestamp)), stats: stats(pieces, auction, history) };
  }

  // Floor, share listed, all-time volume and holders. Supply is every piece that exists: each edition drawn so far and
  // THE SOURCE once sold. A piece's holder is its token's owner once claimed, its buyer until then.
  function stats(pieces, auction, history) {
    const open = pieces.filter((p) => isListed(p) && p.escrow.buyer === W.ZERO);
    const floor = open.length ? open.reduce((m, p) => (p.escrow.price < m ? p.escrow.price : m), open[0].escrow.price) : null;
    const holders = new Set(pieces.map((p) => p.owner));
    history.buyers.forEach((buyer, edition) => { if (!history.claimed.has(edition)) holders.add(buyer); });
    holders.delete(W.ZERO);
    const supply = history.buyers.size + (auction > 0n ? 1 : 0);
    return { floor, listed: open.length, supply, holders: holders.size, primary: history.primary + auction, resale: history.resale };
  }
  const isListed = (p) => p.escrow.seller !== W.ZERO && p.escrow.seller === p.owner;

  // ---------- drawing ----------
  const SEAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10" rx="2.2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.3" r="1.5" fill="currentColor" stroke="none"/></svg>';
  const strip = (window.ArtifactsPalettes || { strip: () => '' }).strip;

  // The OS window for a piece: id 256 is THE SOURCE. A revealed SOURCE gets a slot its on-chain page is drawn into.
  function windowFor({ id, traits, revealed, address }) {
    const t = traits || {};
    const master = id === 256;
    const shown = master && revealed;
    const name = master ? 'ARTIFACTS ◆ <span class="mu">MASTER</span>' : `ARTIFACTS <span class="mu">#${pad3(id)}</span>`;
    // the same card as the drop page: palette in the menu; direction, then title and colours, in the status bar
    const menu = master ? (shown ? 'PUBLIC' : 'ENCRYPTED') : esc(t.palette || 'ENCRYPTED');
    const face = shown && address
      ? `<div class="art" data-art-for="${address}"></div>`
      : `<div class="seal${master ? '' : ' flat'}">${SEAL}<div class="s">${shown ? 'REVEALED' : 'SEALED'}</div></div>`;
    // Revealed, THE SOURCE is its own window: show just the art, no second frame around it.
    if (shown && address) return `<div class="art bare" data-art-for="${address}"><p class="note">Drawing from its seed…</p></div>`;
    const band = !master && t.palette ? `<div class="strip" style="background:${strip(t.palette, t.k)}"></div>` : '';
    const left = master ? 'THE SOURCE' : esc(t.direction || 'OWNER-ONLY');
    const right = master ? '<b>FIDELITY</b> · MAX · 1/1' : t.title ? `<b>${esc(t.title)}</b> · ${t.k}C` : '<b>ENCRYPTED</b>';
    return `<div class="win"><div class="tb"><span>${name}</span><span class="mu">${shown ? 'REVEALED' : 'SEALED'}</span></div>`
      + `<div class="menu"><span>File</span><span>View</span><span>${master ? 'Reveal' : 'Run'}</span><span class="sp"></span><span class="mu">${menu}</span></div>`
      + `${face}${band}<div class="sb"><span>${left}</span><span>${right}</span></div></div>`;
  }

  // A revealed SOURCE is drawn by its own token's page (animation_url: the rules on-chain plus its seed) in a hidden
  // sandboxed frame, which hands back the SVG it drew; the site shows just the art, cropped to its window frame.
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
  // Just the art as a PNG at 3×: on a transparent background (the white sheet is the SVG's one background rect), or on
  // white, as the sheet it is drawn on.
  async function artPng(svg, white = false, scale = 3) {
    const art = svg
      .replace(/viewBox="0 0 1080 1080" width="1080" height="1080"/, `viewBox="199 219 682 642" width="${682 * scale}" height="${642 * scale}"`)
      .replace('<rect width="1080" height="1080" fill="#ffffff"/>', '');
    const url = URL.createObjectURL(new Blob([art], { type: 'image/svg+xml' }));
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

  // A revealed piece's full SVG, drawn once from its tokenURI's page; null while it is sealed.
  const artSvgs = {};
  function revealedSvg(a) {
    if (!artSvgs[a]) {
      artSvgs[a] = (async () => {
        const meta = await (await fetch(decodeString(await call(a, W.encodeCall('tokenURI(uint256)', [1]))))).json();
        if (!/^data:text\/html;base64,/.test(meta.animation_url || '')) return null;
        const page = new TextDecoder().decode(Uint8Array.from(atob(meta.animation_url.split(',')[1]), (c) => c.charCodeAt(0)));
        return drawWithPage(page);
      })();
      artSvgs[a].catch(() => { delete artSvgs[a]; });
    }
    return artSvgs[a];
  }
  const artUrls = {};
  async function drawArt(slot) {
    const a = slot.dataset.artFor;
    try {
      if (!artUrls[a]) {
        const svg = await revealedSvg(a);
        if (!svg) return;
        artUrls[a] = URL.createObjectURL(new Blob([cropToArt(svg)], { type: 'image/svg+xml' }));
      }
      const img = document.createElement('img');
      img.src = artUrls[a];
      img.alt = 'THE SOURCE, drawn from its seed by the rules on-chain';
      slot.replaceChildren(img);
    } catch (_) { /* the seal stays */ }
  }
  // Redraw an element only when its markup changed, so drawn art and typed inputs survive refreshes.
  function paint(el, html) {
    if (el.dataset.html === html) return;
    // what someone has typed (a listing price) survives the redraw, e.g. when a button turns busy
    const typed = {};
    el.querySelectorAll('input[data-price-for]').forEach((i) => { if (i.value) typed[i.dataset.priceFor] = i.value; });
    el.dataset.html = html;
    el.innerHTML = html;
    el.querySelectorAll('input[data-price-for]').forEach((i) => { if (typed[i.dataset.priceFor]) i.value = typed[i.dataset.priceFor]; });
    el.querySelectorAll('[data-art-for]').forEach(drawArt);
  }

  // A modal window that behaves like one: the page behind can't be reached, focus moves in and stays in (Tab wraps),
  // Esc or the scrim closes it, and focus goes back to what opened it. `onClose` tidies up after.
  function modal(scrim, onClose) {
    const box = scrim.querySelector('[role="dialog"]');
    box.setAttribute('aria-modal', 'true');
    let back = null;
    const focusables = () => Array.from(box.querySelectorAll('button:not([disabled]):not([hidden]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter((el) => el.offsetParent !== null);
    const behind = () => Array.from(document.body.children).filter((el) => el !== scrim && el.tagName !== 'SCRIPT' && !el.classList.contains('toasts'));
    function close() {
      if (scrim.hidden) return;
      scrim.hidden = true;
      behind().forEach((el) => { el.inert = false; });
      if (onClose) onClose();
      if (back && document.contains(back)) back.focus();
    }
    function open() {
      if (scrim.hidden) back = document.activeElement;
      scrim.hidden = false;
      behind().forEach((el) => { el.inert = true; });
      const first = box.querySelector('[data-close-first]') || focusables()[0];
      if (first) first.focus();
    }
    scrim.addEventListener('click', (ev) => { if (ev.target === scrim || ev.target.closest('[data-modal-close]')) close(); });
    scrim.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); close(); return; }
      if (ev.key !== 'Tab') return;
      const list = focusables();
      if (!list.length) return;
      const i = list.indexOf(document.activeElement);
      if (ev.shiftKey && i <= 0) { ev.preventDefault(); list[list.length - 1].focus(); }
      else if (!ev.shiftKey && i === list.length - 1) { ev.preventDefault(); list[0].focus(); }
    });
    return { open, close };
  }

  window.ArtifactsChain = Object.freeze({
    modal,
    A, lc, pad3, esc, word, num, big, addr, pad32, call, bytesAt, decodeString, multicall, decodeTraits, decodeEscrow, deployBlock,
    readPieces, isListed, windowFor, paint, drawArt, revealedSvg, drawWithPage, cropToArt, artPng, saveFile,
  });
})();
