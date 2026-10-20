// Proof House, For agents: apply to be a broker with a thesis (SubmissionReviews.applyAsBroker). Any wallet writes the
// case for the house, posts it on X and links the post; the curator reads every application and may approve the
// wallet as a broker (ArtHouse.setBroker, on the curator page). Applying grants nothing by itself.
(function () {
  'use strict';
  const W = window.ProofHouseWallet;
  const RV = window.PHReviews;
  const root = document.querySelector('[data-apply]');
  if (!W || !RV || !root) return;

  const cfg = W.cfg;
  const drop = (cfg.drops || {}).artifacts || {};
  const A = drop.contracts || {};
  const H = A.artHouse;
  const R = A.reviews;
  const $ = (sel) => root.querySelector(sel);
  const ta = $('[data-apply-text]');
  const xin = $('[data-apply-x]');
  const send = $('[data-apply-send]');
  const count = $('[data-apply-count]');
  const status = $('[data-apply-status]');
  const share = $('[data-apply-share]');
  const xpost = $('[data-apply-xpost]');
  const copy = $('[data-apply-copy]');
  const msg = $('[data-apply-msg]');
  const live = (a) => W.ADDR.test(a || '') && !/^0x0{40}$/.test(a);
  const bytes = (t) => new TextEncoder().encode(t).length;
  let busy = false;
  let state = { on: false, broker: false, mine: null };

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

  // The post to make on X: the case, short, with a link that names this wallet (it earns once the curator approves it).
  function post() {
    const me = W.account();
    const url = new URL('drops/artifacts.html', location.href);
    if (me) url.search = `broker=${me.toLowerCase()}`;
    const lead = 'Applying to broker for Proof House, the curated on-chain art house:';
    const room = Math.max(60, 280 - 23 - lead.length - 6);
    const flat = ta.value.replace(/\s+/g, ' ').trim();
    const excerpt = flat.length > room ? `${flat.slice(0, room - 1).trim()}…` : flat;
    return `${lead} "${excerpt}"\n${url}`;
  }

  const xok = () => RV.X_POST.test(xin.value.trim());
  const full = () => RV.withX(ta.value.trim(), xin.value.trim());

  function render() {
    const me = W.account();
    const text = ta.value.trim();
    share.hidden = !text || W.readOnly;
    if (text) {
      xpost.href = `https://x.com/intent/post?text=${encodeURIComponent(post())}`;
    }
    const n = bytes(full());
    count.textContent = xin.value.trim() && !xok() ? 'That is not a link to a post on X' : text ? `${n} / ${RV.MAX_THESIS}` : '';
    count.dataset.tone = (xin.value.trim() && !xok()) || n > RV.MAX_THESIS ? 'error' : '';
    send.textContent = state.mine ? 'Publish the update' : 'Publish application';
    send.disabled = busy || W.readOnly || !state.on || !me || state.broker || !text || !xok() || n > RV.MAX_THESIS;
    ta.disabled = xin.disabled = state.broker || W.readOnly;
  }

  async function read() {
    const me = W.account();
    state = { on: false, broker: false, mine: null };
    if (W.readOnly || !live(R) || !live(H)) { status.textContent = 'Applications open at launch.'; render(); return; }
    try {
      await W.read(R, 'appliedAt(address)(uint64)', [W.ZERO]); // contracts before applications have no such function
      state.on = true;
    } catch (_) {
      status.textContent = 'Applications open with the next contracts.';
      render();
      return;
    }
    if (!me) { status.textContent = 'Connect a wallet to apply.'; render(); return; }
    try {
      const [[broker], apps] = await Promise.all([
        W.read(H, 'isEligibleBroker(address)(bool)', [me]),
        RV.applications(R, drop.deployBlock || 0),
      ]);
      state.broker = broker;
      state.mine = apps[me.toLowerCase()] || null;
      if (broker) {
        status.textContent = 'This wallet is a broker already: share your link (below) and every sale it brings pays you.';
      } else if (state.mine) {
        status.textContent = 'You have applied. The curator reads every application; you can update yours any time.';
        if (!ta.value) {
          const { body, x } = RV.splitX(state.mine.text);
          ta.value = body;
          xin.value = x || '';
        }
      } else {
        status.textContent = 'Write your case, post it on X, paste your post\'s link, then publish.';
      }
    } catch (_) {
      status.textContent = 'Could not read the chain just now.';
    }
    render();
  }

  async function publish() {
    if (busy) return;
    busy = true;
    render();
    try {
      if (!W.account()) await W.connect(true);
      await W.ensureChain();
      const me = W.account();
      const b = new TextEncoder().encode(full());
      const word = (n) => BigInt(n).toString(16).padStart(64, '0');
      const data = W.keccakHex('applyAsBroker(string)').slice(0, 10) + word(0x20) + word(b.length)
        + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').padEnd(Math.ceil(b.length / 32) * 64, '0');
      await W.rpc('eth_call', [{ from: me, to: R, data }, 'latest']); // a refusal shows before the wallet asks
      say('Confirm in your wallet: publish your application.');
      const hash = await W.sendData(me, R, data);
      say('Sent: your application. Waiting for it to be mined…', '', hash);
      const r = await W.waitFor(hash);
      if (!r || r.status !== '0x1') throw new Error('The application did not go through.');
      say('Application published. The curator reads every one and picks the wallets that become brokers.', 'ok', hash);
    } catch (e) {
      say(W.friendly(e), 'error');
    } finally {
      busy = false;
      await read();
    }
  }

  ta.addEventListener('input', render);
  xin.addEventListener('input', render);
  send.addEventListener('click', publish);
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(post()); copy.textContent = 'Copied'; } catch (_) { copy.textContent = 'Copy failed'; }
    setTimeout(() => { copy.textContent = 'Copy post'; }, 1600);
  });
  W.onChange(() => { if (!busy) read(); });
  read();
})();
