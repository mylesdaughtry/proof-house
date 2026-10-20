// ARTIFACTS explore: all 256 pieces by trait, read from the chain. Each cell opens the piece: its public traits,
// where it is in its life (not yet drawn, drawn, claimed into its own contract, listed), and its own contract.
(function () {
  'use strict';
  const W = window.ProofHouseWallet;
  const C = window.ArtifactsChain;
  const page = document.querySelector('[data-explore]');
  if (!W || !C || !page) return;
  const $ = (sel) => page.querySelector(sel);
  const strip = (window.ArtifactsPalettes || { strip: () => '' }).strip;
  const eth = (wei) => `${W.units(wei)} ETH`;
  const EDITIONS = 255;

  const S = { traits: {}, drawn: {}, claimed: {}, pieces: {}, source: null, ready: false };
  const grid = $('[data-grid]');
  const filters = Array.from(page.querySelectorAll('[data-filter]'));
  const modal = document.querySelector('[data-detail]');

  // ---------- reading ----------
  async function read() {
    const ids = Array.from({ length: EDITIONS }, (_, i) => i + 1);
    const calls = [];
    ids.forEach((id) => {
      calls.push({ target: C.A.factory, data: W.encodeCall('traitsOf(uint256)', [id]) });
      calls.push({ target: C.A.factory, data: W.encodeCall('editionBuyer(uint256)', [id]) });
      calls.push({ target: C.A.factory, data: W.encodeCall('pieceContract(uint256)', [id]) });
    });
    const [res, { pieces }, auction] = await Promise.all([
      C.multicall(calls),
      C.readPieces(),
      W.read(C.A.source, 'auctionState()(bool,bool,uint256,uint64,address,uint256)', []),
    ]);
    ids.forEach((id, i) => {
      const [t, b, p] = res.slice(i * 3, i * 3 + 3);
      const tr = t.ok && C.decodeTraits(t.h);
      if (tr) S.traits[id] = tr;
      S.drawn[id] = b.ok ? C.lc(C.addr(b.h, 0)) : W.ZERO;
      S.claimed[id] = p.ok ? C.lc(C.addr(p.h, 0)) : W.ZERO;
    });
    S.pieces = {};
    pieces.forEach((p) => { S.pieces[p.id] = p; });
    const [open, settled, , endTime, bidder, high] = auction;
    S.source = { open, settled, endTime: Number(endTime), bidder: C.lc(bidder), high };
    S.ready = true;
  }

  // ---------- the grid ----------
  function build() {
    const cells = ['<button class="cell master" type="button" data-id="256" title="THE SOURCE"><span class="k">◆</span></button>'];
    for (let id = 1; id <= EDITIONS; id++) cells.push(`<button class="cell" type="button" data-id="${id}"><span class="k">${C.pad3(id)}</span><span class="bar"></span></button>`);
    grid.innerHTML = cells.join('');
    // one tab stop for the whole grid: the arrow keys move between pieces, Home and End jump to the ends
    const items = () => Array.from(grid.querySelectorAll('.cell')).filter((c) => !c.hidden && c.offsetParent !== null);
    Array.from(grid.querySelectorAll('.cell')).forEach((c, i) => { c.tabIndex = i === 0 ? 0 : -1; });
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
    grid.addEventListener('focusin', (ev) => {
      if (!ev.target.classList.contains('cell')) return;
      grid.querySelectorAll('.cell').forEach((c) => { c.tabIndex = c === ev.target ? 0 : -1; });
    });
  }

  function stateOf(id) {
    const p = S.pieces[id];
    if (p && C.isListed(p)) return 'listed';
    if (id === 256) return S.source && S.source.settled ? 'claimed' : 'auction';
    if (S.claimed[id] && S.claimed[id] !== W.ZERO) return 'claimed';
    if (S.drawn[id] && S.drawn[id] !== W.ZERO) return 'drawn';
    return 'sealed';
  }

  function paint() {
    const sets = { direction: new Set(), palette: new Set(), title: new Set() };
    grid.querySelectorAll('.cell[data-id]').forEach((c) => {
      const id = Number(c.dataset.id);
      c.classList.toggle('listed', stateOf(id) === 'listed');
      if (id === 256) {
        // once THE SOURCE is revealed its tile shows the art, drawn from its on-chain page
        const src = S.pieces[256];
        if (src && src.revealed && !c.querySelector('[data-art-for]')) {
          c.classList.add('revealed');
          c.title = 'THE SOURCE · revealed · public forever';
          c.innerHTML = `<span class="art" data-art-for="${src.address}"></span>`;
          C.drawArt(c.querySelector('[data-art-for]'));
        }
        return;
      }
      const t = S.traits[id];
      if (!t) return;
      c.dataset.direction = t.direction; c.dataset.palette = t.palette; c.dataset.title = t.title;
      c.title = `#${C.pad3(id)} · ${t.title} · ${t.palette} · ${t.k}C · ${t.direction}`;
      c.querySelector('.bar').style.background = strip(t.palette, t.k);
      sets.direction.add(t.direction); sets.palette.add(t.palette); sets.title.add(t.title);
    });
    filters.filter((f) => sets[f.dataset.filter]).forEach((sel) => {
      const have = new Set(Array.from(sel.options).map((o) => o.value));
      Array.from(sets[sel.dataset.filter]).sort().forEach((v) => { if (!have.has(v)) { const o = document.createElement('option'); o.value = v; o.textContent = v; sel.append(o); } });
    });
    applyFilter();
  }

  function applyFilter() {
    const want = Object.fromEntries(filters.map((f) => [f.dataset.filter, f.value]));
    let shown = 0;
    grid.querySelectorAll('.cell[data-id]').forEach((c) => {
      const id = Number(c.dataset.id);
      const ok = ['direction', 'palette', 'title'].every((k) => !want[k] || (id !== 256 && c.dataset[k] === want[k]))
        && (!want.state || stateOf(id) === want.state);
      c.classList.toggle('dim', !ok);
      if (ok) shown++;
    });
    $('[data-count]').textContent = `${shown} / 256`;
  }
  filters.forEach((f) => f.addEventListener('change', applyFilter));

  // ---------- one piece ----------
  const STATE_TEXT = {
    sealed: 'not yet drawn · sealed in the archive',
    drawn: 'drawn to a collector · not yet claimed',
    claimed: 'in its own contract',
    listed: 'for sale',
    auction: 'at auction on Proof House',
  };
  function open(id) {
    const p = S.pieces[id];
    const t = id === 256 ? null : S.traits[id];
    const st = stateOf(id);
    const rows = [];
    const kv = (k, v) => rows.push(`<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`);
    if (t) { kv('title', C.esc(t.title)); kv('palette', C.esc(t.palette)); kv('colours', t.k); kv('direction', C.esc(t.direction)); }
    else kv('piece', 'THE SOURCE · 1/1 · the master');
    kv('state', STATE_TEXT[st] + (id === 256 && p && p.revealed ? ' · revealed, public forever' : ''));
    if (p) {
      kv('owner', W.short(p.owner));
      const href = W.explorer('address', p.address);
      kv('its own contract', href ? `<a href="${C.esc(href)}" target="_blank" rel="noopener">${W.short(p.address)}</a>` : W.short(p.address));
    }
    let cta = '';
    if (st === 'listed' && p.escrow.buyer === W.ZERO) cta = `<a class="btn dark" href="index.html#piece-${id}" data-ro-hide>Buy · ${eth(p.escrow.price)} →</a>`;
    else if (st === 'listed') cta = '<p class="note">In escrow: a buyer has paid.</p>';
    else if (st === 'auction') cta = `<a class="btn dark" href="${C.esc(W.cfg.houseUrl || '#')}" target="_blank" rel="noopener">Bid on Proof House ↗</a>`;
    else if (st === 'sealed') cta = `<a class="btn" href="${C.esc(W.cfg.houseUrl || '#')}" target="_blank" rel="noopener">Mint on Proof House ↗</a><p class="note">Editions are drawn at random at mint: nobody picks which.</p>`;
    modal.querySelector('[data-detail-title]').textContent = id === 256 ? '◆ THE SOURCE' : `ARTIFACTS #${C.pad3(id)}`;
    const body = modal.querySelector('[data-detail-body]');
    body.innerHTML = `<div>${C.windowFor({ id, traits: t, revealed: p && p.revealed, address: p && p.address })}</div><div>${rows.join('')}<div class="cta" style="margin-top:16px">${cta}</div></div>`;
    body.querySelectorAll('[data-art-for]').forEach(C.drawArt);
    detail.open();
  }
  grid.addEventListener('click', (ev) => { const c = ev.target.closest('.cell'); if (c) open(Number(c.dataset.id)); });
  const detail = C.modal(modal);

  async function refresh() {
    try { await read(); paint(); $('[data-note]').textContent = ''; }
    catch (_) { $('[data-note]').textContent = 'Could not read the chain just now. Retrying…'; }
  }
  build();
  if (!W.ADDR.test(C.A.factory || '')) { $('[data-note]').textContent = 'The collection is not on-chain yet. It appears here at launch.'; return; }
  refresh();
  setInterval(() => { if (document.visibilityState === 'visible' && modal.hidden) refresh(); }, 30000);
})();
