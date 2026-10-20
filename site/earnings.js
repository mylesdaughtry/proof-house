// Proof House: "Your earnings". What the ledger holds for the connected wallet (a broker's 15% and 2.5%, an artist's
// share and royalties) in ETH and IMD, with a Withdraw button for each. ArtHouse.withdraw pays the wallet, or an
// artist's payout address if they set one. Renders into every [data-earnings] box on the page.
(function () {
  'use strict';
  const W = window.ProofHouseWallet;
  const boxes = [...document.querySelectorAll('[data-earnings]')];
  if (!W || !boxes.length) return;

  const A = (((W.cfg.drops || {}).artifacts || {}).contracts) || {};
  const H = A.artHouse;
  const live = (a) => W.ADDR.test(a || '') && !/^0x0{40}$/.test(a);
  let busy = false;
  let imd = null;

  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

  function say(box, text, tone, hash) {

    W.notify(text, tone, hash);
    const m = box.querySelector('.mint-message');
    m.textContent = text;
    m.dataset.tone = tone || '';
    const href = hash && W.explorer('tx', hash);
    if (href) { const a = el('a', null, ' View transaction'); a.href = href; a.target = '_blank'; a.rel = 'noopener'; m.append(a); }
  }

  async function render() {
    for (const box of boxes) {
      const body = box.querySelector('[data-earnings-body]');
      body.textContent = '';
      if (!live(H)) { body.append(el('p', 'mint-note', 'Earnings show here at launch.')); continue; }
      const me = W.account();
      if (!me) { body.append(el('p', 'mint-note', 'Connect to see what the ledger holds for you.')); continue; }
      try {
        if (!imd) [imd] = await W.read(H, 'imd()(address)', []);
        const [[eth], [imdBal]] = await Promise.all([
          W.read(H, 'balances(address,address)(uint256)', [me, W.ZERO]),
          live(imd) ? W.read(H, 'balances(address,address)(uint256)', [me, imd]) : Promise.resolve([0n]),
        ]);
        const dl = el('dl', 'facts');
        [['ETH', eth, W.ZERO], ['IMD', imdBal, imd]].forEach(([name, amount, currency]) => {
          const div = el('div');
          div.append(el('dt', null, `In the ledger, ${name}`));
          const dd = el('dd', null, `${W.units(amount)} ${name} `);
          if (amount > 0n) {
            const b = el('button', 'btn btn-sm', `Withdraw ${name}`);
            b.type = 'button';
            b.disabled = busy || W.readOnly;
            b.addEventListener('click', () => withdraw(box, currency, name, amount));
            dd.append(b);
          }
          div.append(dd);
          dl.append(div);
        });
        body.append(dl);
        // an artist is paid straight to their payout address at each sale (ArtistPaid); the ledger above holds only
        // what that address couldn't take
        const [payout] = await W.read(H, 'artistPayout(address)(address)', [me]).catch(() => [W.ZERO]); // zero: not an artist
        if (live(payout)) {
          const PAID = W.keccakHex('ArtistPaid(address,address,uint256)');
          const topicMe = '0x' + me.slice(2).padStart(64, '0');
          const logs = await W.logs({ address: H, topics: [PAID, topicMe] }, (((W.cfg.drops || {}).artifacts || {}).deployBlock) || 0).catch(() => []);
          const total = logs.reduce((a, l) => a + BigInt('0x' + l.data.slice(2, 66)), 0n);
          const p = el('p', 'mint-note', `Paid to you directly, at each sale: ${W.units(total)} ETH in all, to ${W.short(live(payout) ? payout : me)}.`);
          body.append(p);
        }
      } catch (_) {
        body.append(el('p', 'mint-note', 'Could not read the ledger just now.'));
      }
    }
  }

  async function withdraw(box, currency, name, amount) {
    if (busy) return;
    busy = true;
    try {
      if (!W.account()) await W.connect(true);
      await W.ensureChain();
      const me = W.account();
      await W.rpc('eth_call', [{ from: me, to: H, data: W.encodeCall('withdraw(address)', [currency]) }, 'latest']);
      say(box, `Confirm in your wallet: withdraw ${W.units(amount)} ${name}.`);
      const hash = await W.send(me, H, 'withdraw(address)', [currency]);
      say(box, 'Sent. Waiting for it to be mined…', '', hash);
      const r = await W.waitFor(hash);
      if (!r || r.status !== '0x1') throw new Error('The withdrawal did not go through.');
      say(box, `Withdrawn: ${W.units(amount)} ${name}, to your wallet (or your payout address, for an artist who set one).`, 'ok', hash);
    } catch (e) {
      say(box, W.friendly(e), 'error');
    } finally {
      busy = false;
      render();
    }
  }

  W.onChange(() => { if (!busy) render(); });
  render();
})();
