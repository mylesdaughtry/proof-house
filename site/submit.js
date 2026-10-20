// Proof House: the submissions page. Checks an artist's SVG in the browser (it is never uploaded), fingerprints it
// with keccak-256, and records the fingerprint and a preview link on-chain with ArtHouse.submit. Lists the
// connected wallet's past submissions and the curator's decisions.
(function () {
  'use strict';
  const W = window.ProofHouseWallet;
  const page = document.querySelector('[data-submit-page]');
  if (!W || !page) return;

  const cfg = W.cfg;
  const drop = (cfg.drops || {}).artifacts || {};
  const H = (drop.contracts || {}).artHouse;
  const RV = (drop.contracts || {}).reviews;
  const $ = (sel) => document.querySelector(sel);
  const MAX_BYTES = 100000; // the ledger rejects plain SVG pieces over 100 KB
  const msg = $('[data-submit-msg]');
  let file = null; // { bytes, hash, ok }
  let busy = false;

  // quiet: a form hint, shown here only, not as a corner notice
  function say(text, tone, hash, quiet) {
    if (!quiet) W.notify(text, tone, hash);
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

  // ---------- checking the file ----------

  function checks(bytes, text) {
    const out = [];
    out.push([bytes.length <= MAX_BYTES, `Under 100 KB (${(bytes.length / 1000).toFixed(1)} KB)`]);
    let doc = null;
    try { doc = new DOMParser().parseFromString(text, 'image/svg+xml'); } catch (_) { doc = null; }
    const parsed = !!doc && !doc.querySelector('parsererror') && doc.documentElement && doc.documentElement.localName === 'svg';
    out.push([parsed, 'A well-formed SVG']);
    if (!parsed) return out;
    const all = Array.from(doc.getElementsByTagName('*'));
    out.push([!all.some((el) => /^(script|foreignObject|iframe|object|embed)$/i.test(el.localName)), 'No scripts or embedded pages']);
    out.push([!all.some((el) => Array.from(el.attributes).some((at) => /^on/i.test(at.name))), 'No event handlers (onload, onclick…)']);
    const external = (v) => /^\s*(https?:|\/\/|ftp:|data:text\/html)/i.test(v || '');
    const refs = all.some((el) => Array.from(el.attributes).some((at) => /(^|:)href$|^src$/i.test(at.name) && external(at.value)));
    const cssRefs = /url\(\s*['"]?\s*(https?:|\/\/)|@import/i.test(text);
    out.push([!refs && !cssRefs, 'Self-contained: no outside links, images or fonts']);
    return out;
  }

  function renderChecks(list) {
    const ul = $('[data-checks]');
    ul.textContent = '';
    list.forEach(([ok, label]) => {
      const li = document.createElement('li');
      li.className = ok ? 'pass' : 'fail';
      li.textContent = label;
      ul.append(li);
    });
  }

  $('[data-file]').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    file = null;
    const frame = $('[data-preview-frame]');
    frame.textContent = '';
    if (!f) { renderChecks([]); update(); return; }
    const bytes = new Uint8Array(await f.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    const list = checks(bytes, text);
    renderChecks(list);
    const ok = list.every(([pass]) => pass);
    file = { bytes, ok, hash: W.keccakBytesHex(bytes), name: f.name };
    $('[data-hash]').textContent = file.hash;
    // Shown as an image: browsers never run scripts inside an <img>.
    const img = document.createElement('img');
    img.alt = `Preview of ${f.name}`;
    img.src = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
    frame.append(img);
    update();
  });

  // ---------- standard or custom ----------

  const kind = () => (document.querySelector('[data-kind]:checked') || {}).value || 'standard';
  const field = (k) => (document.querySelector(`[data-c="${k}"]`) || {}).value || '';
  function applyKind() {
    const custom = kind() === 'custom';
    $('[data-custom]').hidden = !custom;
    $('[data-n-file]').textContent = custom ? '04' : '03';
    $('[data-n-link]').textContent = custom ? '05' : '04';
    $('[data-file-label]').textContent = custom ? 'A sample piece as SVG (optional)' : 'Your work, as an SVG file';
    update();
  }
  document.querySelectorAll('[data-kind]').forEach((r) => r.addEventListener('change', applyKind));
  document.querySelectorAll('[data-c]').forEach((el) => el.addEventListener('input', update));

  // Both kinds: the project's name, and who made it.
  function projectProblem() {
    if (!field('title').trim()) return 'Give the project a name.';
    if (!field('artist').trim()) return 'Add the artist name.';
    return null;
  }

  function customProblem() {
    if (projectProblem()) return projectProblem();
    if (!/^\d{1,7}$/.test(field('supply').trim()) || Number(field('supply')) < 1) return 'Say how many pieces, as a number.';
    if (field('mechanics').trim().length < 40) return 'Describe the mechanics: everything the contracts must do (at least a few sentences).';
    if (field('reference').trim() && !/^https:\/\/\S+$/.test(field('reference').trim())) return 'The code or files link should start with https://.';
    return null;
  }

  // A custom submission's details go on-chain as a small JSON document: no server holds them.
  function customPackage() {
    const pkg = {
      proofHouseSubmission: 1,
      kind: 'custom',
      title: field('title').trim(),
      artist: field('artist').trim(),
      supply: Number(field('supply')),
      sale: field('sale'),
      price: field('price').trim(),
      reference: field('reference').trim(),
      description: field('description').trim(),
      mechanics: field('mechanics').trim(),
      contact: field('contact').trim(),
      preview: previewIn.value.trim(),
      sample: file ? { name: file.name, keccak256: file.hash, bytes: file.bytes.length } : null,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(pkg));
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return { bytes, hash: W.keccakBytesHex(bytes), uri: `data:application/json;base64,${btoa(bin)}` };
  }

  // A standard submission's details: the project's name, the artist and the link, as the same kind of small JSON
  // document. Its fingerprint stays the file's own, so the curator can check the file against it.
  function standardPackage() {
    const pkg = {
      proofHouseSubmission: 1,
      kind: 'standard',
      title: field('title').trim(),
      artist: field('artist').trim(),
      preview: previewIn.value.trim(),
      file: file ? { name: file.name, keccak256: file.hash, bytes: file.bytes.length } : null,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(pkg));
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return `data:application/json;base64,${btoa(bin)}`;
  }

  // ---------- the preview link ----------

  const previewIn = $('[data-preview]');
  const previewOk = () => /^(https:\/\/|ipfs:\/\/|ar:\/\/)\S{4,}$/.test(previewIn.value.trim()) && previewIn.value.trim().length <= 500;
  previewIn.addEventListener('input', update);

  function update() {
    const custom = kind() === 'custom';
    const fileOk = custom ? (!file || file.ok) : (file && file.ok);
    const ready = fileOk && previewOk() && !projectProblem() && (!custom || !customProblem()) && !busy;
    const btn = $('[data-submit]');
    btn.disabled = !ready;
    btn.textContent = busy ? 'Working…' : 'Submit on-chain';
    // why the button is off, in a word or two each, right under it
    const need = [];
    if (!field('title').trim()) need.push('the project name');
    if (!field('artist').trim()) need.push('the artist name');
    if (!custom && !file) need.push('your SVG');
    else if (file && !file.ok) need.push('an SVG that passes the checks');
    if (!previewOk()) need.push(previewIn.value.trim() ? 'a link starting https://, ipfs:// or ar://' : 'the link to see it');
    if (custom && !projectProblem() && customProblem()) need.push('the custom details');
    $('[data-submit-needed]').textContent = busy || ready || !need.length ? '' : `Still needed: ${need.join(', ')}.`;
    if (!busy) {
      if (file && !file.ok) say('This file needs changes before it can be submitted: see the checks above.', 'error', null, true);
      else if (custom && customProblem() && (field('title') || field('mechanics'))) say(customProblem(), 'error', null, true);
      else if (!custom && file && file.ok && previewOk() && projectProblem()) say(projectProblem(), 'error', null, true);
      else if (file && previewIn.value.trim() && !previewOk()) say('The preview link should start with https://, ipfs:// or ar://.', 'error', null, true);
      else say('', '', null, true);
    }
  }

  // ---------- submitting ----------

  // submit(bytes32,string): the string is ABI-encoded by hand (mint.js encodes static types only).
  function encodeSubmit(hash, uri) {
    const sel = W.keccakHex('submit(bytes32,string)').slice(0, 10);
    const bytes = new TextEncoder().encode(uri);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    const word = (n) => BigInt(n).toString(16).padStart(64, '0');
    return sel + hash.slice(2) + word(0x40) + word(bytes.length) + hex.padEnd(Math.ceil(bytes.length / 32) * 64, '0');
  }

  const SUBMITTED = W.keccakHex('Submitted(uint256,address,bytes32,string)');
  $('[data-submit-form]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const custom = kind() === 'custom';
    if (busy || !previewOk() || projectProblem() || (custom ? (customProblem() || (file && !file.ok)) : (!file || !file.ok))) return;
    busy = true;
    update();
    try {
      if (!W.ADDR.test(H || '')) throw new Error('Submissions are not open on this network yet.');
      if (!W.account()) await W.connect(true);
      await W.ensureChain();
      const me = W.account();
      let data;
      if (custom) {
        const pkg = customPackage();
        if (pkg.bytes.length > 8000) throw new Error('The details are too long to store on-chain; shorten the mechanics or description.');
        data = encodeSubmit(pkg.hash, pkg.uri);
      } else {
        data = encodeSubmit(file.hash, standardPackage());
      }
      await W.rpc('eth_call', [{ from: me, to: H, data }, 'latest']);
      say('Confirm in your wallet: submit your work.');
      const hash = await W.sendData(me, H, data);
      say('Submitted: waiting for it to be mined…', '', hash);
      const r = await W.waitFor(hash);
      if (!r || r.status !== '0x1') throw new Error('The submission did not go through.');
      const log = (r.logs || []).find((l) => (l.address || '').toLowerCase() === H.toLowerCase() && l.topics && l.topics[0] === SUBMITTED);
      const id = log ? Number(BigInt(log.topics[1])) : null;
      say(`Submitted${id !== null ? ` as #${id}` : ''}. Holders can now review it in public, and the curator's decision is recorded on-chain.${custom ? ' If accepted, Proof House has its contracts built and audited.' : ''}`, 'ok', hash);
      if (id !== null) {
        const a = document.createElement('a');
        a.href = `review.html#s-${id}`; a.textContent = 'See it on the Review page';
        msg.append(' ', a);
      }
    } catch (err) {
      say(W.friendly(err), 'error');
    } finally {
      busy = false;
      update();
      loadMine();
    }
  });

  // ---------- your submissions ----------

  const STATUS = ['Open to review', 'Accepted', 'Not this time']; // as on the Review page

  // ---------- since your last visit ----------
  // This browser remembers each submission's status and review counts as last seen (no account, nothing sent anywhere)
  // and says what changed: new reviews, and the curator's decision. "Got it" marks it seen.
  const seenKey = (me) => `ph-subs-seen:${cfg.chainId}:${me.toLowerCase()}`;
  let pendingSeen = null;
  function sinceLastVisit(me, now) {
    let before = null;
    try { before = JSON.parse(localStorage.getItem(seenKey(me))); } catch (_) { before = null; }
    const box = $('[data-since]');
    if (!before) { // a first visit: remember quietly, there is nothing to compare with
      try { localStorage.setItem(seenKey(me), JSON.stringify(now)); } catch (_) { /* storage off */ }
      box.hidden = true;
      return;
    }
    const lines = [];
    Object.entries(now).forEach(([id, cur]) => {
      const was = before[id];
      const label = `#${id}${cur.name ? ` ${cur.name}` : ''}`;
      if (!was) return; // submitted since: no news yet
      const parts = [];
      const added = cur.tally.reduce((a, b) => a + b, 0) - was.tally.reduce((a, b) => a + b, 0);
      const changed = cur.tally.some((v, i) => v !== was.tally[i]);
      if (added > 0) parts.push(`${added} new review${added === 1 ? '' : 's'}`);
      else if (changed) parts.push('reviews changed');
      if (changed) parts.push(`now ${cur.tally[0]} back · ${cur.tally[1]} neutral · ${cur.tally[2]} pass`);
      if (cur.status !== was.status) parts.push(cur.status === 1 ? 'accepted by the curator' : cur.status === 2 ? 'not chosen this time' : 'reopened');
      if (parts.length) lines.push({ id, text: `${label}: ${parts.join(' · ')}` });
    });
    pendingSeen = now;
    const ul = $('[data-since-list]');
    ul.textContent = '';
    lines.forEach((l) => { const li = document.createElement('li'); const a = document.createElement('a'); a.href = `review.html#s-${l.id}`; a.textContent = l.text; li.append(a); ul.append(li); });
    box.hidden = lines.length === 0;
    if (lines.length) W.toast(lines.length === 1 ? lines[0].text : `${lines.length} of your submissions have news since your last visit.`, 'ok');
    else { try { localStorage.setItem(seenKey(me), JSON.stringify(now)); } catch (_) { /* storage off */ } }
  }
  document.querySelector('[data-since-ok]').addEventListener('click', () => {
    const me = W.account();
    if (me && pendingSeen) { try { localStorage.setItem(seenKey(me), JSON.stringify(pendingSeen)); } catch (_) { /* storage off */ } }
    $('[data-since]').hidden = true;
  });
  // Only the fields a submission's details document should have, each of the right type and capped, so a malformed or
  // hostile document (submitting is open to anyone) can neither break a page nor flood it.
  function cleanPackage(json) {
    if (!json || typeof json !== 'object' || json.proofHouseSubmission !== 1) return null;
    const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
    const file = (f) => (f && typeof f === 'object'
      ? { name: str(f.name, 120), keccak256: /^0x[0-9a-fA-F]{64}$/.test(f.keccak256 || '') ? f.keccak256 : '', bytes: Number.isFinite(f.bytes) ? f.bytes : 0 }
      : null);
    return {
      proofHouseSubmission: 1, kind: json.kind === 'custom' ? 'custom' : 'standard',
      title: str(json.title, 120), artist: str(json.artist, 120), preview: str(json.preview, 500),
      supply: Number.isFinite(json.supply) ? json.supply : 0, sale: str(json.sale, 40), price: str(json.price, 80),
      reference: str(json.reference, 500), description: str(json.description, 4000), mechanics: str(json.mechanics, 8000),
      contact: str(json.contact, 200), file: file(json.file), sample: file(json.sample),
    };
  }
  // The details a submission carries in its preview field (name, artist, link), if it is a Proof House details
  // document; older standard submissions carry a bare link.
  function detailsOf(ret) {
    try {
      const h = ret.slice(2);
      const at = Number(BigInt('0x' + h.slice(128, 192))) * 2;
      const len = Number(BigInt('0x' + h.slice(at, at + 64)));
      const uri = new TextDecoder().decode(Uint8Array.from((h.slice(at + 64, at + 64 + len * 2).match(/../g) || []).map((x) => parseInt(x, 16))));
      const prefix = 'data:application/json;base64,';
      if (!uri.startsWith(prefix)) return null;
      const bin = atob(uri.slice(prefix.length));
      return cleanPackage(JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))));
    } catch (_) { return null; }
  }
  async function loadMine() {
    const me = W.account();
    const sec = $('[data-mine]');
    if (!me || !W.ADDR.test(H || '') || !drop.deployBlock) { sec.hidden = true; return; }
    try {
      const topicMe = '0x' + me.slice(2).padStart(64, '0');
      const logs = await W.logs({ address: H, topics: [SUBMITTED, null, topicMe] }, drop.deployBlock);
      const list = $('[data-mine-list]');
      list.textContent = '';
      const now = {};
      // every row's reads at once (one batched round trip), then drawn newest first
      const rows = await Promise.all(logs.reverse().map(async (l) => {
        const id = BigInt(l.topics[1]);
        // submissions(id) returns (address, bytes32, string, uint8): the status is the fourth word.
        const [ret, tallyR] = await Promise.all([
          W.rpc('eth_call', [{ to: H, data: W.encodeCall('submissions(uint256)', [id]) }, 'latest']),
          W.ADDR.test(RV || '') ? W.read(RV, 'tally(uint256)(uint256,uint256,uint256)', [id]).catch(() => null) : null, // no reviews contract here
        ]);
        return { l, id, ret, tally: tallyR ? tallyR.map(Number) : [0, 0, 0] };
      }));
      for (const { l, id, ret, tally } of rows) {
        const status = Number(BigInt('0x' + ret.slice(2 + 64 * 3, 2 + 64 * 4)));
        const hash = '0x' + l.data.slice(2, 66);
        const pkg = detailsOf(ret);
        const li = document.createElement('li');
        li.innerHTML = `<a><span class="dl-num"></span><span class="dl-name"></span><span class="dl-artist"></span><span class="dl-status"></span><span class="dl-go"></span></a>`;
        const a = li.querySelector('a');
        a.href = `review.html#s-${id}`;
        a.querySelector('.dl-num').textContent = `#${id}`;
        a.querySelector('.dl-name').textContent = pkg && pkg.title ? pkg.title : `${hash.slice(0, 10)}…`;
        a.querySelector('.dl-artist').textContent = pkg && pkg.artist ? pkg.artist : 'fingerprint';
        const total = tally[0] + tally[1] + tally[2];
        a.querySelector('.dl-status').textContent = `${STATUS[status] || 'unknown'} · ${total ? `${total} review${total === 1 ? '' : 's'}` : 'no reviews yet'}`;
        a.querySelector('.dl-go').textContent = 'Reviews →';
        list.append(li);
        now[String(id)] = { status, tally, name: pkg && pkg.title ? pkg.title : '' };
      }
      sec.hidden = logs.length === 0;
      sinceLastVisit(me, now);
    } catch (_) {
      sec.hidden = true;
    }
  }

  W.onChange(() => { if (!busy) { update(); loadMine(); } });
  applyKind();
  loadMine();
})();
