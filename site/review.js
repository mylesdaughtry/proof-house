// Proof House: the Review page. Every artist submission with its reviews. Every identity.md seat and every claimed
// Artifacts piece is one voice: its holder posts or updates that voice's review of a pending submission
// (SubmissionReviews.reviewAsSeat / reviewAsPiece). The curator decides on the curator page.
(function () {
  'use strict';
  const W = window.ProofHouseWallet;
  const RV = window.PHReviews;
  const page = document.querySelector('[data-review-page]');
  if (!W || !RV || !page) return;

  const cfg = W.cfg;
  const drop = (cfg.drops || {}).artifacts || {};
  const A = drop.contracts || {};
  const H = A.artHouse;
  const R = A.reviews;
  const $ = (sel) => document.querySelector(sel);
  const list = $('[data-rv-list]');
  const msg = $('[data-rv-msg]');
  const STATUS = ['Open to review', 'Accepted', 'Not this time'];
  const MAX_NOTE = 280;
  let busy = false;

  // The seat or piece this viewer last reviewed with, so the form starts there (a convenience, kept in this browser).
  const VOICE_KEY = 'ph-review-voice';
  let lastVoice = { kind: 'seat', id: '' };
  try { const v = JSON.parse(localStorage.getItem(VOICE_KEY)); if (v && (v.kind === 'seat' || v.kind === 'piece')) lastVoice = v; } catch (_) { /* storage off */ }
  const remember = (v) => { lastVoice = v; try { localStorage.setItem(VOICE_KEY, JSON.stringify(v)); } catch (_) { /* storage off */ } };

  // As on the drop page: ?broker= names whoever shared the link, for the rest of this visit.
  try {
    const fromUrl = new URLSearchParams(location.search).get('broker');
    if (fromUrl && W.ADDR.test(fromUrl)) sessionStorage.setItem('ph-broker', JSON.stringify(fromUrl.toLowerCase()));
  } catch (_) { /* storage off: no remembered broker */ }

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

  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const bytes = (s) => new TextEncoder().encode(s).length;

  // reviewAsSeat / reviewAsPiece(uint256,uint256,uint8,string): three words, the string's offset (0x80), the string.
  function encodeReview(kind, id, voiceId, verdict, note) {
    const sel = W.keccakHex(`${kind === 'piece' ? 'reviewAsPiece' : 'reviewAsSeat'}(uint256,uint256,uint8,string)`).slice(0, 10);
    const b = new TextEncoder().encode(note);
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    const word = (n) => BigInt(n).toString(16).padStart(64, '0');
    return sel + word(id) + word(voiceId) + word(verdict) + word(0x80) + word(b.length) + hex.padEnd(Math.ceil(b.length / 32) * 64, '0');
  }

  // One load at a time; one asked for meanwhile runs once after, so an older read never paints over a newer one.
  let loading = null;
  let again = false;
  function load() {
    if (loading) { again = true; return loading; }
    loading = (async () => { do { again = false; await loadOnce(); } while (again); })().finally(() => { loading = null; });
    return loading;
  }
  async function loadOnce() {
    if (!RV.live(H) || !RV.live(R)) {
      list.innerHTML = '<li class="dl-empty">Submissions and reviews open at launch.</li>';
      return;
    }
    try {
      const [count] = await W.read(H, 'submissionCount()(uint256)', []);
      const n = Number(count);
      const me = W.account();
      const [subs, revs, ths, thesesOn, brought, eligible] = await Promise.all([
        Promise.all(Array.from({ length: Math.min(n, 50) }, (_, k) => RV.submission(H, n - 1 - k))),
        RV.reviews(R, drop.deployBlock),
        RV.theses(R, drop.deployBlock).catch(() => ({})), // reviews contracts before v13 have no theses
        W.read(R, 'MAX_THESIS()(uint256)', []).then(() => true, () => false),
        RV.brought(H, drop.deployBlock).catch(() => ({})),
        me ? W.read(H, 'isEligibleBroker(address)(bool)', [me]).then((r) => r[0], () => false) : false,
      ]);
      // which writers are brokers now (a pass, or approved by the curator): their links earn; the others make their case
      const authors = [...new Set(Object.values(ths).flat().map((t) => t.author))];
      const isBroker = Object.fromEntries(await Promise.all(authors.map((a) => W.read(H, 'isEligibleBroker(address)(bool)', [a]).then((r) => [a, r[0]], () => [a, false]))));
      thesisState = { ths, brought, eligible, on: thesesOn, isBroker };
      $('[data-rv-pending]').textContent = String(subs.filter((s) => s.status === 0).length);
      $('[data-rv-count]').textContent = String(Object.values(revs).reduce((a, r) => a + r.list.length, 0));
      render(subs, revs);
    } catch (e) {
      list.innerHTML = '';
      list.append(el('li', 'dl-empty', e.code === 'NO_CODE' ? `No Proof House contracts answered on ${cfg.chainName}.` : 'Could not read the submissions just now.'));
    }
  }

  let thesisState = { ths: {}, brought: {}, eligible: false, on: false, isBroker: {} };
  const STATUS_TONE = ['open', 'yes', 'no'];
  const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch (_) { return u.slice(0, 40); } };
  const isImage = (u) => /\.(svg|png|jpe?g|gif|webp)(\?|#|$)/i.test(u) || /^https:\/\/ipfs\.io\/ipfs\//.test(u);

  // One card per submission: who and what, where the voices stand, the reviews, your review, then sharing.
  function render(subs, revs) {
    list.textContent = '';
    if (!subs.length) { list.append(el('li', 'dl-empty', 'No submissions yet. Artists submit on the Artists page.')); return; }
    subs.forEach((s) => {
      try {
        const r = revs[s.id] || { list: [], tally: [0, 0, 0] };
        const pkg = RV.packageOf(s.uri);
        const card = el('li', 'rv-card');
        card.id = `s-${s.id}`;

        const head = el('div', 'rv-head');
        const custom = !!pkg && pkg.kind === 'custom';
        head.append(el('span', null, `Submission #${s.id} · ${custom ? 'custom drop' : 'standard drop'}`));
        head.append(el('span', `rv-status rv-${STATUS_TONE[s.status] || 'open'}`, STATUS[s.status] || 'unknown'));
        card.append(head);

        const body = el('div', 'rv-body');
        if (pkg) {
          body.append(el('p', 'rv-title', pkg.title || 'Untitled'));
          if (pkg.artist) body.append(el('p', 'rv-by', `by ${pkg.artist}`));
        }
        const facts = el('dl', 'rv-facts');
        const fact = (k, v) => { const d = el('div'); d.append(el('dt', null, k)); const dd = el('dd'); if (typeof v === 'string') dd.textContent = v; else dd.append(v); d.append(dd); facts.append(d); };
        fact('From', `${W.short(s.submitter)}${W.account() && W.account().toLowerCase() === s.submitter.toLowerCase() ? ' (you)' : ''}`);
        const previewUri = pkg ? pkg.preview || '' : s.uri;
        const href = RV.safeHref(previewUri);
        if (href) { const a = el('a', 'rv-link', `${hostOf(href)} ↗`); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; fact('See it', a); }
        else fact('See it', previewUri ? previewUri.slice(0, 60) : 'no link given');
        const fp = el('span', 'rv-fp');
        fp.append(el('code', null, `${s.hash.slice(0, 10)}…${s.hash.slice(-6)}`));
        if (href && !custom) {
          const check = el('button', 'rv-mini', 'Check the file');
          check.type = 'button';
          const out = el('span', 'rv-check');
          check.addEventListener('click', () => checkFile(href, s.hash, out, check));
          fp.append(check, out);
        }
        fact('Fingerprint', fp);
        body.append(facts);
        if (pkg && pkg.description) body.append(el('p', 'rv-about', pkg.description.length > 280 ? pkg.description.slice(0, 280) + '…' : pkg.description));
        if (href && isImage(href)) {
          const show = el('button', 'rv-mini', 'Show the image here');
          show.type = 'button';
          show.addEventListener('click', () => { const img = el('img', 'rv-img'); img.src = href; img.alt = `Submission #${s.id}`; img.referrerPolicy = 'no-referrer'; show.replaceWith(img); });
          body.append(show);
        }

        // where the voices stand: one bar, then the counts
        const total = r.tally[0] + r.tally[1] + r.tally[2];
        const stand = el('div', 'rv-stand');
        const bar = el('div', 'rv-bar');
        bar.setAttribute('aria-hidden', 'true');
        ['back', 'neutral', 'pass'].forEach((v, i) => { if (r.tally[i]) { const seg = el('span', `rv-seg-${v}`); seg.style.flexGrow = String(r.tally[i]); bar.append(seg); } });
        if (!total) bar.append(el('span', 'rv-seg-none'));
        stand.append(bar, el('p', 'rv-counts', total ? `${r.tally[0]} back · ${r.tally[1]} neutral · ${r.tally[2]} pass` : 'No reviews yet'));
        body.append(stand);

        if (r.list.length) {
          const wrap = r.list.length > 4 ? el('details', 'rv-reviews') : el('div', 'rv-reviews');
          if (r.list.length > 4) wrap.append(el('summary', null, `${r.list.length} reviews`));
          else wrap.append(el('p', 'rv-sub', r.list.length === 1 ? '1 review' : `${r.list.length} reviews`));
          const ul = el('ul', 'rv-review-list');
          r.list.forEach((x) => {
            const item = el('li');
            item.append(el('b', `rv-v rv-${RV.VERDICTS[x.verdict].toLowerCase()}`, RV.VERDICTS[x.verdict]));
            item.append(el('span', 'rv-who', `${RV.voiceLabel(x)} · ${W.short(x.reviewer)}${x.reviewer === s.submitter.toLowerCase() ? ' (the artist)' : ''}`));
            if (x.note) item.append(el('span', 'rv-note', x.note));
            ul.append(item);
          });
          wrap.append(ul);
          body.append(wrap);
        }
        card.append(body);
        if (thesisState.on) card.append(thesesBox(s, pkg));
        if (s.status === 0 && !W.readOnly) card.append(form(s, r));
        if (s.status === 0 && !W.readOnly) card.append(share(s, pkg));
        list.append(card);
      } catch (_) { list.append(el('li', 'dl-empty', `Submission #${s.id} could not be shown.`)); } // one bad card never takes the list down
    });
  }

  // Brokers' theses on a submission: each author's latest, with what that broker has brought (sales naming it in the
  // ledger), and a link that credits them; a broker can write or update theirs while the submission isn't declined.
  const thesisDrafts = {};
  let justPublished = null; // the submission whose thesis this wallet just published: its share buttons come first

  // A ready post for a thesis: an excerpt and a link to it that names the author as the broker, so every sale it
  // brings pays them. Sized for one post on X (a link counts as 23 characters there).
  function thesisPost(s, pkg, t) {
    const url = new URL('review.html', location.href);
    url.search = `broker=${t.author}`;
    url.hash = `s-${s.id}`;
    const mine = t.author === (W.account() || '').toLowerCase();
    const what = pkg && pkg.title ? `${pkg.title}${pkg.artist ? ` by ${pkg.artist}` : ''}` : `submission #${s.id}`;
    const lead = `${mine ? 'My' : 'A'} thesis on ${what}, ${s.status === 1 ? 'a Proof House drop' : 'up for review at Proof House'}:`;
    const room = Math.max(60, 280 - 23 - lead.length - 6);
    const flat = RV.splitX(t.text).body.replace(/\s+/g, ' ').trim();
    const excerpt = flat.length > room ? `${flat.slice(0, room - 1).trim()}…` : flat;
    return `${lead} "${excerpt}"\n${url}`;
  }
  async function copyText(btn, text) {
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
      W.toast('Post copied: paste it into X, Telegram, Discord or anywhere.', 'ok');
    } catch (_) {
      W.toast('Copy failed: select the post and copy it.', 'error');
    }
    setTimeout(() => { btn.textContent = label; }, 2500);
  }
  function thesisShare(s, pkg, t) {
    const text = thesisPost(s, pkg, t);
    const acts = el('div', 'actions share-actions rv-thesis-share');
    const x = el('a', 'btn btn-solid btn-sm', 'Share on X');
    x.href = `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
    x.target = '_blank'; x.rel = 'noopener';
    const copy = el('button', 'btn btn-sm', 'Copy post');
    copy.type = 'button';
    copy.addEventListener('click', () => copyText(copy, text));
    acts.append(x, copy);
    return acts;
  }

  function thesesBox(s, pkg) {
    const list = thesisState.ths[s.id] || [];
    const box = el('section', 'rv-theses');
    box.setAttribute('aria-label', 'Theses');
    box.append(el('p', 'rv-sub', list.length ? `Theses · ${list.length}` : 'Theses'));
    if (!list.length) box.append(el('p', 'mint-note', 'Nobody has made the case for this one yet.'));
    list.forEach((t) => {
      const art = el('article', 'rv-thesis');
      const b = thesisState.brought[t.author];
      const broker = !!thesisState.isBroker[t.author];
      const head = el('p', 'rv-thesis-head');
      head.append(el('b', null, W.short(t.author)), el('span', null, broker
        ? ` · broker · ${b ? `brought ${b.sales} sale${b.sales === 1 ? '' : 's'}${b.eth > 0n ? `, earned ${W.units(b.eth)} ETH` : ''}` : 'no sales brought yet'}`
        : ' · not a broker yet'));
      art.append(head);
      const { body: text, x: onX } = RV.splitX(t.text);
      const body = text.length > 700 ? el('details', 'rv-thesis-more') : null;
      if (body) {
        body.append(el('summary', null, `${text.slice(0, 600).trim()}… Read the whole thesis`));
        body.append(el('p', 'rv-thesis-text', text));
        art.append(body);
      } else {
        art.append(el('p', 'rv-thesis-text', text));
      }
      if (onX) {
        const a = el('a', 'rv-thesis-x', 'Posted on X');
        a.href = onX; a.target = '_blank'; a.rel = 'noopener noreferrer';
        const p = el('p', 'mint-note');
        p.append(a);
        art.append(p);
      }
      const own = t.author === (W.account() || '').toLowerCase();
      // a broker's link earns; a writer who isn't one yet shares their own, to make their case
      if (!W.readOnly && (broker || own)) art.append(thesisShare(s, pkg, t));
      if (t.author === (W.account() || '').toLowerCase() && justPublished === s.id) {
        art.classList.add('is-new');
        art.prepend(el('p', 'rv-thesis-new', broker ? 'Published. Share it: a sale your link brings pays you 15% (2.5% on a resale).'
          : 'Published. Post it on X (below), then add your post\'s link to your thesis: the curator reads every thesis with its post, and picks the writers who become brokers.'));
      }
      box.append(art);
    });
    if (W.readOnly || s.status === 2) return box;
    const me = W.account();
    if (!me) { box.append(el('p', 'mint-note', 'Anyone can make the case for this work: connect a wallet to write a thesis. The curator reads every one, and may make the best writers brokers.')); return box; }
    const mine = list.find((t) => t.author === me.toLowerCase());
    const det = el('details', 'rv-thesis-form');
    if (!mine) det.open = !!thesisDrafts[s.id];
    det.append(el('summary', null, mine ? 'Update your thesis' : 'Write a thesis'));
    const ta = el('textarea', 'share-text rv-text');
    ta.rows = 7;
    ta.maxLength = RV.MAX_THESIS;
    ta.placeholder = `Why ${pkg && pkg.title ? pkg.title : 'this work'} should be a drop, and who will want it. Up to ${RV.MAX_THESIS} bytes. Signed by your wallet, on-chain.`;
    ta.setAttribute('aria-label', 'Your thesis');
    const mineX = mine ? RV.splitX(mine.text) : { body: '', x: null };
    ta.value = thesisDrafts[s.id] !== undefined ? thesisDrafts[s.id] : mineX.body;
    const xin = el('input', 'handover-input rv-xlink');
    xin.placeholder = 'Your post on X (optional): https://x.com/you/status/…';
    xin.setAttribute('aria-label', 'Your post on X');
    xin.value = thesisDrafts[`x${s.id}`] !== undefined ? thesisDrafts[`x${s.id}`] : mineX.x || '';
    const xok = () => !xin.value.trim() || RV.X_POST.test(xin.value.trim());
    const full = () => RV.withX(ta.value.trim(), xok() ? xin.value.trim() : '');
    const count = el('span', 'rv-count');
    const btn = el('button', 'btn btn-solid btn-sm', mine ? 'Publish the update' : 'Publish thesis');
    btn.type = 'button';
    const update = () => {
      const n = bytes(full());
      count.textContent = !xok() ? 'That is not a link to a post on X' : `${n} / ${RV.MAX_THESIS}`;
      count.dataset.tone = !xok() || n > RV.MAX_THESIS ? 'error' : '';
      btn.disabled = busy || !ta.value.trim() || !xok() || n > RV.MAX_THESIS;
    };
    ta.addEventListener('input', () => { thesisDrafts[s.id] = ta.value; update(); });
    xin.addEventListener('input', () => { thesisDrafts[`x${s.id}`] = xin.value; update(); });
    btn.addEventListener('click', () => publishThesis(s.id, full(), btn));
    const foot = el('div', 'rv-form-foot');
    foot.append(count, btn);
    det.append(ta, xin, foot, el('p', 'mint-note', thesisState.eligible
      ? 'Your latest thesis is the one shown. Link to it with your wallet attached: a sale it brings pays you the broker share.'
      : 'Anyone can write one. Post it on X too and paste your post\'s link above: the curator reads every thesis with its post and picks the writers who become brokers. Then a sale your link brings pays you 15% (2.5% on a resale).'));
    update();
    box.append(det);
    return box;
  }

  async function publishThesis(id, text, btn) {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    btn.textContent = 'Publishing…';
    try {
      if (!W.account()) await W.connect(true);
      await W.ensureChain();
      const me = W.account();
      const b = new TextEncoder().encode(text);
      const word = (n) => BigInt(n).toString(16).padStart(64, '0');
      const data = W.keccakHex('postThesis(uint256,string)').slice(0, 10) + word(id) + word(0x40) + word(b.length)
        + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').padEnd(Math.ceil(b.length / 32) * 64, '0');
      await W.rpc('eth_call', [{ from: me, to: R, data }, 'latest']); // a refusal shows before the wallet asks
      say(`Confirm in your wallet: publish your thesis on submission #${id}.`);
      const hash = await W.sendData(me, R, data);
      say(`Sent: your thesis on submission #${id}. Waiting for it to be mined…`, '', hash);
      const rc = await W.waitFor(hash);
      if (!rc || rc.status !== '0x1') throw new Error('The thesis did not go through.');
      delete thesisDrafts[id];
      delete thesisDrafts[`x${id}`];
      justPublished = id;
      say(thesisState.eligible ? `Thesis published on submission #${id}. Share it: a sale your link brings pays you 15% (2.5% on a resale).`
        : `Thesis published on submission #${id}. The curator reads every one, and may make you a broker.`, 'ok', hash);
    } catch (e) {
      const t = W.friendly(e);
      const code = Object.keys(WHY).find((c) => c === W.errorSelector(e) || t.includes(c));
      say(code ? WHY[code] : t, 'error');
    } finally {
      busy = false;
      await load();
      // bring the new thesis and its share buttons into view
      const fresh = justPublished !== null && document.querySelector(`#s-${justPublished} .rv-thesis.is-new`);
      if (fresh) fresh.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // Fetches the linked file in this browser and compares its keccak-256 with the fingerprint on-chain. Many sites don't
  // let a page read their files (CORS); then it says so, and the curator checks it on the curator page.
  async function checkFile(href, hash, out, btn) {
    btn.disabled = true;
    out.textContent = ' checking…';
    out.dataset.tone = '';
    try {
      const res = await fetch(href, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error(`the link answered ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      const ok = W.keccakBytesHex(buf).toLowerCase() === hash.toLowerCase();
      out.textContent = ok ? ' ✓ the linked file matches' : ' ✕ the linked file is different from what was submitted';
      out.dataset.tone = ok ? 'ok' : 'error';
    } catch (_) {
      out.textContent = " can't check from here: that site doesn't let browsers read its files, or it links to a page, not the file";
      out.dataset.tone = '';
    } finally {
      btn.disabled = false;
    }
  }

  // A ready-made post for a pending submission, linking to it here with the sharer's wallet attached, so anyone can
  // promote an artist they believe in. Same idea as the broker link: whoever arrives through it names the sharer.
  function share(s, pkg) {
    const det = el('details', 'sub-details rv-share');
    det.append(el('summary', null, 'Share this submission'));
    const me = W.account();
    const url = new URL('review.html', location.href);
    if (me) url.search = `broker=${me}`;
    url.hash = `s-${s.id}`;
    const who = pkg ? `${pkg.title} by ${pkg.artist}` : `A new work by ${W.short(s.submitter)}`;
    const text = `${who} is up for review at Proof House, the on-chain art house. Seat and piece holders are weighing in now, and the curator decides. Take a look:\n${url}`;
    const box = el('textarea', 'share-text rv-text');
    box.rows = 3; box.readOnly = true; box.value = text;
    box.setAttribute('aria-label', 'A post about this submission');
    const acts = el('div', 'actions share-actions');
    const copy = el('button', 'btn btn-sm', 'Copy post');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); say('Post copied: paste it anywhere.', 'ok'); }
      catch (_) { say('Copy failed: select the post and copy it.', 'error'); }
    });
    const x = el('a', 'btn btn-sm', 'Share on X');
    x.href = `https://x.com/intent/post?text=${encodeURIComponent(text)}`; x.target = '_blank'; x.rel = 'noopener';
    acts.append(copy, x);
    det.append(box, acts);
    if (!me) det.append(el('p', 'mint-note', 'Connect first to put your wallet on the link.'));
    return det;
  }

  // Your review: one of your seats or pieces (found in this wallet, or typed), Back / Neutral / Pass, and a note. A voice
  // that already reviewed starts from its review, and posting again updates it.
  const drafts = {}; // submission id → what was typed there, kept across redraws until it is posted
  function form(s, r) {
    const f = el('form', 'rv-form');
    f.append(el('p', 'rv-form-title', 'Your review'));
    const draft = drafts[s.id];
    const voice = draft ? { kind: draft.kind, id: draft.id } : { kind: lastVoice.kind, id: lastVoice.id || '' };
    const pickRow = el('div', 'rv-voices');
    pickRow.setAttribute('role', 'group');
    pickRow.setAttribute('aria-label', 'Review as');
    const pickNote = el('p', 'mint-note rv-voice-note');
    const manual = el('details', 'rv-manual');
    manual.append(el('summary', null, 'Enter a seat or piece number instead'));
    const mrow = el('div', 'rv-form-row');
    const kind = el('select', 'handover-input rv-pick');
    kind.setAttribute('aria-label', 'Review as');
    [['seat', 'identity.md seat'], ['piece', 'Artifacts piece']].forEach(([v, t]) => { const o = el('option', null, t); o.value = v; kind.append(o); });
    kind.value = voice.kind;
    const num = el('input', 'handover-input rv-num');
    num.inputMode = 'numeric'; num.autocomplete = 'off';
    num.setAttribute('aria-label', 'Its number');
    num.value = voice.id;
    const hint = () => { num.placeholder = kind.value === 'piece' ? 'Piece 1 to 256' : 'Seat, e.g. 986'; };
    hint();
    mrow.append(kind, num);
    manual.append(mrow);
    f.append(pickRow, pickNote, manual);

    const seg = el('div', 'rv-seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'Your verdict');
    const radios = ['Back', 'Neutral', 'Pass'].map((v, i) => {
      const lab = el('label', `rv-opt rv-opt-${v.toLowerCase()}`);
      const inp = el('input');
      inp.type = 'radio'; inp.name = `rv-${s.id}`; inp.value = String(i + 1);
      inp.setAttribute('aria-label', v);
      lab.append(inp, el('span', null, v));
      seg.append(lab);
      return inp;
    });
    const row2 = el('div', 'rv-form-row');
    row2.append(seg);
    f.append(row2);
    const note = el('textarea', 'share-text rv-text');
    note.rows = 2;
    note.placeholder = 'A short note for the curator (optional, up to 280 bytes)';
    note.setAttribute('aria-label', 'Your note');
    const count = el('span', 'rv-count');
    const btn = el('button', 'btn btn-solid btn-sm', 'Post review');
    btn.type = 'submit';
    const foot = el('div', 'rv-form-foot');
    foot.append(count, btn);
    f.append(note, foot);

    const current = () => ({ kind: kind.value, id: num.value.trim() });
    const existing = () => { const v = current(); return /^\d{1,9}$/.test(v.id) ? r.list.find((x) => x.voice === RV.voiceKey(v.kind, v.id)) : null; };
    const update = () => {
      const n = bytes(note.value);
      count.textContent = `${n} / ${MAX_NOTE}`;
      count.dataset.tone = n > MAX_NOTE ? 'error' : '';
      btn.disabled = busy || n > MAX_NOTE || !radios.some((x) => x.checked) || !/^\d{1,9}$/.test(num.value.trim());
    };
    const keep = () => { drafts[s.id] = { kind: kind.value, id: num.value.trim(), verdict: (radios.find((x) => x.checked) || {}).value || null, note: note.value }; };
    const fill = () => {
      const e = existing();
      radios.forEach((x) => { x.checked = !!e && Number(x.value) === e.verdict; });
      note.value = e ? e.note : '';
      // what was typed for this voice before the list redrew comes back
      const d = drafts[s.id];
      if (d && d.kind === kind.value && d.id === num.value.trim()) {
        radios.forEach((x) => { x.checked = x.value === d.verdict; });
        note.value = d.note;
      }
      btn.textContent = e ? 'Update review' : 'Post review';
      pickRow.querySelectorAll('.pick').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === kind.value && b.dataset.id === num.value.trim())));
      update();
    };
    const choose = (k, id) => { kind.value = k; num.value = String(id); hint(); fill(); };
    note.addEventListener('input', () => { keep(); update(); });
    kind.addEventListener('change', () => { hint(); fill(); });
    num.addEventListener('input', fill);
    radios.forEach((x) => x.addEventListener('change', () => { keep(); update(); }));
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = radios.find((x) => x.checked);
      if (!v || busy) return;
      btn.disabled = true;
      btn.textContent = 'Posting…'; // the list redraws once it is through, or not
      post(s.id, kind.value, Number(num.value.trim()), Number(v.value), note.value.trim());
    });

    // the voices in the connected wallet, as buttons; a voice that already reviewed this one says so
    const me = W.account();
    if (!me || !window.PHHoldings) {
      pickNote.textContent = me ? '' : 'Connect to review with the seats and pieces in your wallet.';
    } else {
      pickNote.textContent = 'Looking for your seats and pieces…';
      window.PHHoldings.scan(me).then((voices) => {
        pickNote.textContent = voices.length ? 'Review as one of these: one voice each, and you can change it until the curator decides.' : 'No identity.md seat or claimed Artifacts piece in this wallet, so no voice here.';
        voices.forEach((v) => {
          const done = r.list.find((x) => x.voice === RV.voiceKey(v.kind, v.id));
          const b = el('button', 'pick', done ? `${v.label} · reviewed` : v.label);
          b.type = 'button'; b.dataset.kind = v.kind; b.dataset.id = String(v.id);
          b.addEventListener('click', () => choose(v.kind, v.id));
          pickRow.append(b);
        });
        if (voices.length && !num.value.trim()) choose(voices[0].kind, voices[0].id);
        else fill();
      }, () => { pickNote.textContent = 'Could not look in this wallet just now: enter a number below.'; });
    }
    fill();
    return f;
  }

  const WHY = {
    '0x7623fb52': "This wallet doesn't hold that seat or piece right now.",
    '0x8a80e5fb': "That piece hasn't been claimed yet, so it has no contract to review with (pieces are 1 to 256).",
    '0x7dc6505a': 'The curator has already decided this submission, so its reviews are closed.',
    '0x155be563': 'Keep the note to 280 bytes.',
    '0x3ee8d4b9': 'There is no submission with that number.',
    '0xa6edfb0c': 'This submission was declined, so theses on it are closed.',
    '0xc18fc0da': 'A thesis is 1 to 4,000 bytes.',
  };

  async function post(id, kind, voiceId, verdict, note) {
    if (busy) return;
    if (bytes(note) > MAX_NOTE) { say('Keep the note to 280 bytes.', 'error'); return; }
    busy = true;
    try {
      if (!W.account()) await W.connect(true);
      await W.ensureChain();
      const me = W.account();
      const data = encodeReview(kind, id, voiceId, verdict, note);
      // Simulate first, so a refusal (not your seat or piece, already decided) shows before the wallet asks.
      await W.rpc('eth_call', [{ from: me, to: R, data }, 'latest']);
      const label = `${['', 'back', 'stay neutral on', 'pass on'][verdict]} submission #${id} as ${RV.voiceLabel({ kind, id: voiceId })}`;
      say(`Confirm in your wallet: ${label}.`);
      const hash = await W.sendData(me, R, data);
      say(`Sent: ${label}. Waiting for it to be mined…`, '', hash);
      const rc = await W.waitFor(hash);
      if (!rc || rc.status !== '0x1') throw new Error('The review did not go through.');
      remember({ kind, id: String(voiceId) });
      delete drafts[id];
      say(`Review posted: ${label}.`, 'ok', hash);
    } catch (e) {
      const text = W.friendly(e);
      const code = Object.keys(WHY).find((c) => c === W.errorSelector(e) || text.includes(c));
      say(code ? WHY[code] : text, 'error');
    } finally {
      busy = false;
      load();
    }
  }

  W.onChange(() => { if (!busy) load(); });
  // A shared link (#s-<id>) scrolls to its submission once the list is drawn.
  load().then(() => {
    const t = location.hash && document.getElementById(location.hash.slice(1));
    if (t) { t.classList.add('rv-target'); t.scrollIntoView({ block: 'start' }); }
  });
})();
