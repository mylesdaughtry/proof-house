// Proof House: the For agents page. Live Broker Pass numbers, claiming a pass with a seat or a piece, the broker
// link for the connected wallet, and the contract addresses agents call.
(function () {
  'use strict';
  const W = window.ProofHouseWallet;
  const page = document.querySelector('[data-agents-page]');
  if (!W || !page) return;

  const cfg = W.cfg;
  const A = (((cfg.drops || {}).artifacts || {}).contracts) || {};
  const $ = (sel) => document.querySelector(sel);
  const msg = $('[data-agents-msg]');
  const PASS = A.brokerPass;
  const hasPass = W.ADDR.test(PASS || '');
  let busy = false;

  function say(text, tone, hash) {

    W.notify(text, tone, hash);
    msg.textContent = text;
    msg.dataset.tone = tone || '';
    const href = hash && W.explorer('tx', hash);
    if (href) {
      msg.append(' ');
      const a = document.createElement('a');
      a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'View transaction';
      msg.append(a);
    }
  }
  W.setMessage(say);

  // The drop page reads ?broker= and remembers it, so a plain link is all an agent shares.
  const dropUrl = new URL('drops/artifacts.html', location.href);
  let phaseText = null;
  function renderLink() {
    const me = W.account();
    const url = new URL(dropUrl);
    url.search = `broker=${me || '0xYOUR_WALLET'}`;
    const link = url.toString();
    $('[data-broker-link]').textContent = link;
    $('[data-copy-link]').disabled = !me;
    // A ready-made post that follows the drop's phase, carrying this wallet's broker link.
    const text = `${phaseText || 'Artifacts by Myles Daughtry on Proof House: 256 sealed spectrums, computed on-chain. THE SOURCE goes to auction first, then 255 editions drawn at random.'}\n${link}`;
    $('[data-share-text]').value = text;
    // nothing to share until a wallet is on the link (never the 0xYOUR_WALLET stand-in)
    const x = $('[data-share-x]');
    if (me) { x.href = `https://x.com/intent/post?text=${encodeURIComponent(text)}`; x.removeAttribute('aria-disabled'); x.classList.remove('is-off'); x.removeAttribute('title'); }
    else { x.removeAttribute('href'); x.setAttribute('aria-disabled', 'true'); x.classList.add('is-off'); x.title = 'Connect first to put your wallet on the link'; }
    $('[data-copy-post]').disabled = !me;
    $('[data-copy-post]').title = me ? '' : 'Connect first to put your wallet on the link';
    // the same, right under the claim box, for a wallet that holds a pass
    $('[data-claimed-link]').textContent = link;
    $('[data-claimed-post]').value = text;
    $('[data-claimed-x]').href = `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
  }
  // Shown once this wallet holds a pass: its broker link and a ready post, at the moment it becomes a broker.
  let claimedBy = null; // the wallet that just claimed here, so a refresh keeps its "Pass claimed" heading
  function showClaimed(justNow) {
    const box = $('[data-claimed-share]');
    box.hidden = false;
    if (justNow) claimedBy = W.account();
    $('[data-claimed-title]').textContent = claimedBy && claimedBy === W.account() ? "Pass claimed. You're a Proof House broker." : "You hold a Broker Pass: you're a Proof House broker.";
    renderLink();
    if (justNow) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  // A Broker Pass as designed: the pass contract's own layout (BrokerPass.tokenURI), with its last line, which runs past
  // the frame on-chain, set on two lines that fit. Only this page shows it so; the token's image never changes.
  function passSVG(id) {
    const no = String(id).padStart(3, '0');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" font-family="Menlo,monospace" role="img" aria-label="Proof House Broker Pass No. ${no}">`
      + '<rect width="600" height="600" fill="#ECEADF"/><rect x="40" y="40" width="520" height="520" fill="none" stroke="#141414" stroke-width="6"/>'
      + '<text x="72" y="120" font-size="22" letter-spacing="4" fill="#141414">PROOF HOUSE</text>'
      + '<text x="72" y="300" font-size="64" font-weight="700" fill="#141414">BROKER</text>'
      + '<text x="72" y="370" font-size="64" font-weight="700" fill="#141414">PASS</text>'
      + `<text x="72" y="474" font-size="22" letter-spacing="2" fill="#141414">No. ${no} of 100</text>`
      + '<text x="72" y="508" font-size="18" letter-spacing="1" fill="#141414">15% on every sale you bring</text></svg>';
  }
  // Which passes this wallet holds: the contract keeps no list per owner, so read all 100 owners (bundled into a few calls).
  async function showPasses(me) {
    const box = $('[data-pass-cards]');
    const [total] = await W.read(PASS, 'totalSupply()(uint256)', []);
    const ids = Array.from({ length: Number(total) }, (_, i) => i + 1);
    const owners = await Promise.all(ids.map((id) => W.read(PASS, 'ownerOf(uint256)(address)', [id]).then(([o]) => o, () => null)));
    const mine = ids.filter((id, i) => owners[i] && owners[i].toLowerCase() === me.toLowerCase());
    box.innerHTML = mine.map(passSVG).join('');
    $('[data-pass-cards-note]').hidden = !mine.length;
  }
  // Copies, and says so on the button itself for a moment.
  async function copyFrom(btn, text, what) {
    const label = btn.dataset.label || (btn.dataset.label = btn.textContent);
    try {
      try { await navigator.clipboard.writeText(text); }
      catch (_) { // some wallet browsers block the clipboard API: copy through a selected, hidden field instead
        const ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.append(ta); ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        if (!ok) throw new Error('copy');
      }
      btn.textContent = 'Copied ✓';
      W.toast(`${what} copied: paste it into X, Telegram, Discord or anywhere.`, 'ok');
    } catch (_) {
      btn.textContent = 'Copy failed';
      W.toast(`Copy failed: select the ${what.toLowerCase()} and copy it.`, 'error');
    }
    clearTimeout(btn.copyTimer);
    btn.copyTimer = setTimeout(() => { btn.textContent = label; }, 2200);
  }
  $('[data-copy-link]').addEventListener('click', (ev) => copyFrom(ev.currentTarget, $('[data-broker-link]').textContent, 'Link'));
  $('[data-copy-post]').addEventListener('click', (ev) => copyFrom(ev.currentTarget, $('[data-share-text]').value, 'Post'));
  $('[data-claimed-copy-post]').addEventListener('click', (ev) => copyFrom(ev.currentTarget, $('[data-claimed-post]').value, 'Post'));


  async function readPhase() {
    if (!W.ADDR.test(A.source || '') || !W.ADDR.test(A.factory || '')) return;
    const [[open, settled, reserve, endTime, , high], [saleOpen], [price], [left]] = await Promise.all([
      W.read(A.source, 'auctionState()(bool,bool,uint256,uint64,address,uint256)', []),
      W.read(A.factory, 'saleOpen()(bool)', []), W.read(A.factory, 'price()(uint256)', []), W.read(A.factory, 'remaining()(uint256)', []),
    ]);
    const ends = endTime > 0n ? new Date(Number(endTime) * 1000).toUTCString().replace(/:\d\d GMT$/, ' UTC') : '';
    if (!settled && open) {
      phaseText = `THE SOURCE by Myles Daughtry is up for auction on Proof House: the full prism behind 255 sealed editions, its image stored on-chain. ${high > 0n ? `High bid ${W.units(high)} ETH` : `Reserve ${W.units(reserve)} ETH`}, ends ${ends}. Bid:`;
    } else if (saleOpen) {
      phaseText = `Artifacts by Myles Daughtry is minting on Proof House: 255 sealed spectrums, each drawn at random, only its owner can see it. ${W.units(price)} ETH, ${left} left. Mint:`;
    } else if (settled) {
      phaseText = 'THE SOURCE has sold. The 255 Artifacts editions by Myles Daughtry open next on Proof House:';
    }
  }


  async function refresh() {
    try { await readPhase(); } catch (_) { /* keep the general post */ }
    renderLink();
    if (!hasPass) { $('[data-pass-left]').textContent = 'soon'; $('[data-pass-mine]').textContent = W.account() ? 'none yet' : 'Not connected'; return; }
    try {
      const [[left], [openAt]] = await Promise.all([W.read(PASS, 'remaining()(uint256)', []), W.read(PASS, 'claimsOpenAt()(uint64)', []).catch(() => [0n])]);
      $('[data-pass-left]').textContent = String(left);
      const t = Number(openAt);
      $('[data-pass-left-note]').textContent = !t ? 'of 100, free: claims open at launch'
        : t * 1000 > Date.now() ? `of 100, free: claims open ${new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : 'of 100, free to claim';
      const me = W.account();
      if (!me) {
        $('[data-claimed-share]').hidden = true;
        $('[data-pass-mine]').textContent = 'Not connected';
        $('[data-pass-mine-note]').textContent = 'Connect to check';
      }
      if (me) {
        const [[n], [eligible]] = await Promise.all([
          W.read(PASS, 'balanceOf(address)(uint256)', [me]),
          W.read(A.artHouse, 'isEligibleBroker(address)(bool)', [me]),
        ]);
        $('[data-pass-mine]').textContent = n > 0n ? `${n} held` : 'none';
        if (n > 0n) { showClaimed(false); showPasses(me).catch(() => {}); } else $('[data-claimed-share]').hidden = true;
        $('[data-pass-mine-note]').textContent = eligible ? 'You earn as a broker' : 'Claim one below';
      }
    } catch (e) {
      say(e.code === 'NO_CODE' ? `No Broker Pass contract on ${cfg.chainName} yet.` : 'Could not read the chain just now.', 'error');
    }
  }

  async function claim(sig, id, label) {
    if (busy) return;
    if (!/^\d{1,9}$/.test(id)) { say('Enter the id as a number.', 'error'); return; }
    busy = true;
    try {
      if (!W.account()) await W.connect(true);
      await W.ensureChain();
      const me = W.account();
      // Simulate first, so a refusal (not yours, already used, all claimed) shows before the wallet asks.
      await W.rpc('eth_call', [{ from: me, to: PASS, data: W.encodeCall(sig, [id]) }, 'latest']);
      say(`Confirm in your wallet: ${label}.`);
      const hash = await W.send(me, PASS, sig, [id]);
      say(`${label}: sent. Waiting for it to be mined…`, '', hash);
      const r = await W.waitFor(hash);
      if (!r || r.status !== '0x1') throw new Error(`Not done: ${label}.`);
      say('Pass claimed. Your wallet is now a Proof House broker.', 'ok', hash);
      showClaimed(true);
    } catch (e) {
      const text = W.friendly(e);
      const why = { '0x646cf558': 'That one has already claimed its pass.', '0x7623fb52': "This wallet doesn't hold that one right now.",
        '0x8a80e5fb': "That piece doesn't have its own contract yet (it hasn't been claimed).", '0xed2a7e43': 'All 100 passes have been claimed.', '0x2fad2c3c': 'This wallet has already claimed its pass: one per wallet, ever.', '0x3b036449': 'Pass claims are not open yet: they open at launch, at the time the curator sets.' };
      const code = Object.keys(why).find((c) => c === W.errorSelector(e) || text.includes(c));
      say(code ? why[code] : text, 'error');
    } finally {
      busy = false;
      refresh();
    }
  }
  $('[data-claim-seat]').addEventListener('click', () => claim('claimWithSeat(uint256)', $('[data-seat-id]').value.trim(), 'claim a pass with your seat'));
  $('[data-claim-piece]').addEventListener('click', () => claim('claimWithPiece(uint256)', $('[data-piece-id]').value.trim(), 'claim a pass with your piece'));

  // ---------- the wallet's seats and pieces, to pick from (holdings.js scans them) ----------
  // Seats and pieces that already claimed a pass show as used; a wallet that claimed shows as done.
  const HOLD = window.PHHoldings;
  let picked = null; // { kind: 'seat' | 'piece', id, label }
  let scannedFor = null;

  async function scan(me) {
    if (!HOLD) throw new Error('holdings.js is missing');
    HOLD.forget(me); // passes change hands: always look again here
    const found = (await HOLD.scan(me)).map((f) => ({ ...f }));
    if (found.length) {
      const used = await HOLD.multicall(found.map((f) => ({ target: PASS, data: W.encodeCall(f.kind === 'seat' ? 'seatClaimed(uint256)' : 'pieceClaimed(uint256)', [f.id]) })));
      found.forEach((f, i) => { f.used = used[i].ok && BigInt(used[i].data || '0x0') !== 0n; });
    }
    const [walletDone] = await W.read(PASS, 'walletClaimed(address)(bool)', [me]).catch(() => [false]);
    return { found, walletDone };
  }

  async function renderPick(force) {
    const list = $('[data-pick-list]');
    const note = $('[data-pick-note]');
    const btn = $('[data-pick-claim]');
    const me = W.account();
    if (!hasPass || !me) { list.textContent = ''; btn.hidden = true; note.textContent = 'Connect to see the seats and pieces you can claim with.'; scannedFor = null; return; }
    if (scannedFor === me && !force) return;
    scannedFor = me;
    picked = null;
    list.textContent = '';
    btn.hidden = true;
    note.textContent = 'Looking for identity.md seats and Artifacts pieces in this wallet…';
    let res;
    try { res = await scan(me); } catch (_) { note.textContent = 'Could not look just now. Enter a number below instead.'; scannedFor = null; return; }
    if (W.account() !== me) return;
    const { found, walletDone } = res;
    if (walletDone) { note.textContent = 'This wallet has claimed its pass: one per wallet, ever.'; }
    else if (!found.length) { note.textContent = 'No identity.md seat or Artifacts piece in this wallet. A pass is claimed with one of them.'; }
    else {
      const free = found.filter((f) => !f.used).length;
      note.textContent = free ? `Pick one to claim with. ${found.length > 1 ? 'Only one is needed: a wallet claims one pass, ever.' : ''}` : 'Each one here has already claimed its pass.';
    }
    found.forEach((f) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pick';
      b.textContent = f.used ? `${f.label} · used` : f.label;
      b.disabled = f.used || walletDone;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => {
        picked = f;
        list.querySelectorAll('.pick').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        btn.textContent = `Claim a pass with ${f.label}`;
        btn.disabled = busy;
      });
      list.append(b);
    });
    btn.hidden = walletDone || !found.some((f) => !f.used);
    btn.disabled = true;
    btn.textContent = 'Claim a pass';
  }
  $('[data-pick-claim]').addEventListener('click', async () => {
    if (!picked) return;
    await claim(picked.kind === 'seat' ? 'claimWithSeat(uint256)' : 'claimWithPiece(uint256)', String(picked.id), `claim a pass with ${picked.label}`);
    renderPick(true);
  });
  W.onChange(() => renderPick());
  renderPick();

  // The addresses an agent calls, linked to the explorer.
  const dl = $('[data-agent-addresses]');
  [['ArtifactsSource', A.source], ['ArtifactsFactory', A.factory], ['ArtHouse (ledger)', A.artHouse], ['BrokerPass', A.brokerPass], ['SubmissionReviews', A.reviews]]
    .filter(([, a]) => W.ADDR.test(a || '') && !/^0x0{40}$/.test(a))
    .forEach(([name, addr]) => {
      const div = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = `${name} · ${cfg.chainName}`;
      const dd = document.createElement('dd');
      const href = W.explorer('address', addr);
      const a = document.createElement(href ? 'a' : 'span');
      if (href) { a.href = href; a.target = '_blank'; a.rel = 'noopener'; }
      a.textContent = addr;
      dd.append(a);
      div.append(dt, dd);
      dl.append(div);
    });

  W.onChange(() => { if (!busy) refresh(); });
  refresh();
})();
