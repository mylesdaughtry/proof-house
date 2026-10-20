// Proof House home: the live drop's state at a glance, read from its contracts. The header says the phase in two
// words; two figures below say what matters in that phase (the auction's high bid and time left, or the editions'
// price and how many are left), with the countdown ticking on the chain's clock.
(function () {
  'use strict';
  const W = window.ProofHouseWallet;
  if (!W) return;
  const cfg = W.cfg;
  document.querySelectorAll('[data-chain]').forEach((el) => { el.textContent = cfg.chainName; });

  const c = ((cfg.drops || {}).artifacts || {}).contracts || {};
  const f = c.factory;
  const set = (sel, text) => document.querySelectorAll(sel).forEach((el) => { el.textContent = text; });
  if (!f || !W.ADDR.test(f) || !W.ADDR.test(c.source || '')) {
    // Before launch (no contracts here): the order of the sale, without figures.
    set('[data-home-phase]', 'Coming soon');
    set('[data-home-row]', 'Coming soon');
    set('[data-home-v1]', '1 of 1 · auction');
    return;
  }
  const eth = (wei) => `${W.units(wei)} ETH`;
  const EDITIONS = 255;
  let endsAt = 0; // auction end, chain seconds
  let skew = 0; // chain time minus this computer's time

  function left() {
    const s = Math.max(0, Math.floor(endsAt - (Date.now() / 1000 + skew)));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}h ${m}m` : `${m}m ${String(sec).padStart(2, '0')}s`;
  }

  async function read() {
    const [[open], [price], [sold], [aOpen, settled, reserve, endTime, , high], block] = await Promise.all([
      W.read(f, 'saleOpen()(bool)', []),
      W.read(f, 'price()(uint256)', []),
      W.read(f, 'sold()(uint256)', []),
      W.read(c.source, 'auctionState()(bool,bool,uint256,uint64,address,uint256)', []),
      W.rpc('eth_getBlockByNumber', ['latest', false]),
    ]);
    const now = Number(BigInt(block.timestamp));
    skew = now - Date.now() / 1000;
    const remaining = EDITIONS - Number(sold);
    let phase, k1, v1, k2, v2, row, live = false;
    endsAt = 0;
    if (!settled && !open) {
      // Sale order: THE SOURCE's auction first.
      if (aOpen && now < Number(endTime)) {
        live = true; endsAt = Number(endTime);
        phase = 'Auction live';
        k1 = high > 0n ? 'THE SOURCE · high bid' : 'THE SOURCE · reserve'; v1 = eth(high > 0n ? high : reserve);
        k2 = 'Ends in'; v2 = left();
        row = `Auction live · ${eth(high > 0n ? high : reserve)}`;
      } else if (aOpen) {
        phase = 'Auction closing';
        k1 = 'THE SOURCE · final bid'; v1 = high > 0n ? eth(high) : 'no bids';
        k2 = 'Then'; v2 = '255 editions';
        row = 'Auction closing';
      } else {
        phase = 'Opens soon';
        k1 = 'First'; v1 = 'THE SOURCE';
        k2 = 'Then'; v2 = '255 editions';
        row = 'Opens soon';
      }
    } else if (open && remaining > 0) {
      live = true;
      phase = 'Editions live';
      k1 = 'Edition price'; v1 = eth(price);
      k2 = 'Left'; v2 = `${remaining} of ${EDITIONS}`;
      row = `Editions live · ${remaining} left`;
    } else if (open) {
      phase = 'Sold out'; k1 = 'Editions'; v1 = 'sold out'; k2 = 'Resale'; v2 = 'on Artifacts'; row = 'Sold out';
    } else {
      phase = 'Editions next';
      k1 = 'THE SOURCE'; v1 = high > 0n ? `sold · ${eth(high)}` : 'sold';
      k2 = 'Next'; v2 = price > 0n ? `editions · ${eth(price)}` : '255 editions';
      row = 'Editions open soon';
    }
    const cta = phase === 'Auction live' ? 'Bid on THE SOURCE →' : phase === 'Sold out' ? 'Open the drop →' : 'Mint →';
    set('[data-home-phase]', phase); set('[data-home-row]', row); set('[data-home-cta]', cta);
    set('[data-home-k1]', k1); set('[data-home-v1]', v1); set('[data-home-k2]', k2); set('[data-home-v2]', v2);
    document.querySelectorAll('[data-home-live]').forEach((el) => el.classList.toggle('on', live));
  }

  // What's up for review: pending submissions (newest first), so holders and brokers find the Review page from here.
  // submissions(id) → (address submitter, bytes32 hash, string previewURI, uint8 status); a custom or named submission
  // keeps its title and artist in previewURI as data:application/json;base64.
  async function readReview() {
    const H = c.artHouse;
    const row = document.querySelector('[data-home-review]');
    if (!row || !W.ADDR.test(H || '')) return;
    const [n] = await W.read(H, 'submissionCount()(uint256)', []);
    const ids = Array.from({ length: Math.min(Number(n), 20) }, (_, k) => Number(n) - 1 - k);
    const rets = await Promise.all(ids.map((id) => W.rpc('eth_call', [{ to: H, data: W.encodeCall('submissions(uint256)', [id]) }, 'latest'])));
    const pending = rets.map((ret) => ret.slice(2)).filter((h) => BigInt('0x' + h.slice(192, 256)) === 0n);
    row.hidden = pending.length === 0;
    if (!pending.length) return;
    let who = `${pending.length} waiting`;
    try {
      const h = pending[0];
      const at = Number(BigInt('0x' + h.slice(128, 192))) * 2;
      const len = Number(BigInt('0x' + h.slice(at, at + 64)));
      const uri = new TextDecoder().decode(Uint8Array.from(h.slice(at + 64, at + 64 + len * 2).match(/../g) || [], (x) => parseInt(x, 16)));
      const prefix = 'data:application/json;base64,';
      if (uri.startsWith(prefix)) {
        const pkg = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(uri.slice(prefix.length)), (ch) => ch.charCodeAt(0))));
        // a Proof House details document only, text fields only, short
        const str = (v) => (typeof v === 'string' ? v.slice(0, 60) : '');
        if (pkg && pkg.proofHouseSubmission === 1 && str(pkg.title)) {
          who = `${str(pkg.title)}${str(pkg.artist) ? ` by ${str(pkg.artist)}` : ''}${pending.length > 1 ? ` and ${pending.length - 1} more` : ''}`;
        }
      }
    } catch (_) { /* the count is enough */ }
    set('[data-home-review-n]', String(pending.length));
    set('[data-home-review-who]', who);
  }

  const refresh = () => {
    readReview().catch(() => {});
    return read().catch(() => set('[data-home-phase]', cfg.chainName));
  };
  refresh();
  setInterval(() => { if (endsAt) set('[data-home-v2]', left()); }, 1000);
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 20000);
})();
