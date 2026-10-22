// Proof House: ARTIFACTS editions held by a Safe or another smart-contract wallet. The drop page makes a viewing key
// from one wallet signature, which a Safe can't give; this page makes one from 32 random secret bytes instead
// (viewingKeyV2FromSecret, agents.md "See what you collect"), hands the Safe the transactions that register it and
// claim the editions (Safe Transaction Builder batch files), and opens the editions with the secret. The secret stays in
// this page's memory and in the file its owner saves; only the public key goes on-chain, from the Safe.
(function () {
  'use strict';
  const W = window.ProofHouseWallet;
  const Seal = window.ProofHouseSeal;
  const page = document.querySelector('[data-safe]');
  if (!W || !Seal || !page) return;
  const $ = (sel) => page.querySelector(sel);
  const cfg = W.cfg;
  const A = (((cfg.drops || {}).artifacts || {}).contracts) || {};
  const F = A.factory;
  const lc = (a) => (a || '').toLowerCase();
  const pad3 = (n) => String(n).padStart(3, '0');
  const ZERO_KEY = /^0x0{64}$/;
  const CLAIMS_PER_TX = 2; // each claim deploys a full contract; an Ethereum transaction holds at most two (EIP-7825)

  document.querySelectorAll('[data-market-link]').forEach((a) => { a.href = ((cfg.drops || {}).artifacts || {}).market || a.href; });

  function say(sel, text, tone) {
    const el = $(sel);
    el.textContent = text || '';
    el.dataset.tone = tone || '';
  }
  function fact(dl, label, value) {
    const div = document.createElement('div');
    const dt = document.createElement('dt'); dt.textContent = label;
    const dd = document.createElement('dd');
    if (value instanceof Node) dd.append(value); else dd.textContent = value;
    div.append(dt, dd);
    dl.append(div);
  }
  function link(addr, text) {
    const href = W.explorer('address', addr);
    const a = document.createElement(href ? 'a' : 'span');
    if (href) { a.href = href; a.target = '_blank'; a.rel = 'noopener'; }
    a.textContent = text || addr;
    return a;
  }
  function saveFile(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  const saveJson = (obj, name) => saveFile(new Blob([JSON.stringify(obj, null, 2) + '\n'], { type: 'application/json' }), name);

  // ---------- reading the chain ----------

  const word = (h, byte) => h.slice(byte * 2, byte * 2 + 64);
  const num = (h, byte) => Number(BigInt('0x' + (word(h, byte) || '0')));
  const call = (to, data) => W.rpc('eth_call', [{ to, data }, 'latest']);
  function decodeUintArray(ret) {
    const h = (ret || '0x').slice(2);
    if (h.length < 128) return [];
    const at = num(h, 0);
    return Array.from({ length: num(h, at) }, (_, i) => num(h, at + 32 + i * 32));
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
    return Array.from({ length: num(h, at) }, (_, i) => '0x' + word(h, at + 32 + i * 32).slice(24));
  }
  function decodeString(ret) {
    const h = (ret || '0x').slice(2);
    const at = num(h, 0);
    const len = num(h, at);
    return new TextDecoder().decode(Uint8Array.from(h.slice((at + 32) * 2, (at + 32 + len) * 2).match(/../g) || [], (x) => parseInt(x, 16)));
  }

  let S = null; // { wallet, kind, owners, threshold, viewingKey, editions: [{ e, piece, posted }] }

  async function lookUp(wallet) {
    const code = await W.rpc('eth_getCode', [wallet, 'latest']);
    let kind = 'contract';
    if (!code || code === '0x') kind = 'ordinary';
    else if (/^0xef0100/i.test(code)) kind = 'delegated'; // an EIP-7702 account still signs as an ordinary wallet
    let owners = null, threshold = null;
    if (kind === 'contract') {
      try {
        owners = decodeAddressArray(await call(wallet, W.encodeCall('getOwners()', [])));
        [threshold] = await W.read(wallet, 'getThreshold()(uint256)', []);
        kind = 'safe';
      } catch (_) { /* another kind of smart-contract wallet */ }
    }
    const [[viewingKey], editionsRet] = await Promise.all([
      W.read(F, 'viewingKeyOf(address)(bytes32)', [wallet]),
      call(F, W.encodeCall('editionsOf(address)', [wallet])),
    ]);
    const ids = decodeUintArray(editionsRet).sort((a, b) => a - b);
    const editions = await Promise.all(ids.map(async (e) => {
      const [piece] = await W.read(F, 'pieceContract(uint256)(address)', [e]);
      const claimed = lc(piece) !== W.ZERO;
      const wrapped = decodeBytes(claimed ? await call(piece, W.encodeCall('wrappedKey()', [])) : await call(F, W.encodeCall('wrappedKeyOf(uint256)', [e])));
      // a claimed piece can have moved on since (a transfer or a resale): then it is no longer this wallet's to open
      let holder = null;
      if (claimed) { const [owner] = await W.read(piece, 'ownerOf(uint256)(address)', [1]); if (lc(owner) !== lc(wallet)) holder = lc(owner); }
      return { e, piece: claimed ? lc(piece) : null, posted: wrapped.length > 0, holder };
    }));
    return { wallet: lc(wallet), kind, owners, threshold: threshold === null ? null : Number(threshold), viewingKey: lc(viewingKey), editions };
  }

  function showWallet() {
    const dl = $('[data-safe-facts]');
    dl.textContent = '';
    dl.hidden = false;
    fact(dl, 'Wallet', link(S.wallet, W.short(S.wallet)));
    fact(dl, 'Kind', S.kind === 'safe' ? `Safe, ${S.threshold} of ${S.owners.length} owners` : S.kind === 'contract' ? 'a smart-contract wallet' : 'an ordinary wallet');
    fact(dl, 'Viewing key', ZERO_KEY.test(S.viewingKey) ? 'none registered yet' : `${S.viewingKey.slice(0, 10)}…${S.viewingKey.slice(-6)}`);
    const n = S.editions.length;
    fact(dl, 'Editions', n ? S.editions.map((d) => `#${pad3(d.e)}`).join(' ') : 'none');
    // counted over the editions this wallet still holds: a piece that moved away is listed apart
    const held = S.editions.filter((d) => !d.holder);
    const moved = n - held.length;
    if (n) fact(dl, 'Their keys', `${held.filter((d) => d.posted).length} of ${held.length} sent${held.some((d) => d.piece) ? ` · ${held.filter((d) => d.piece).length} claimed` : ''}${moved ? ` · ${moved} since moved to another wallet` : ''}`);
  }

  $('[data-safe-look]').addEventListener('click', () => { lookUpShown(); });
  async function lookUpShown() {
    const addr = $('[data-safe-addr]').value.trim();
    if (!W.ADDR.test(addr)) { say('[data-safe-msg]', 'Paste the wallet address: 0x and 40 characters.', 'error'); return; }
    say('[data-safe-msg]', 'Reading the chain…');
    try {
      S = await lookUp(addr);
      showWallet();
      const ordinary = S.kind === 'ordinary' || S.kind === 'delegated';
      say('[data-safe-msg]', ordinary
        ? 'This is an ordinary wallet: it can sign, so make its viewing key on the drop page, under Yours. This page is for Safes and other smart-contract wallets.'
        : !S.editions.length ? 'This wallet holds no ARTIFACTS editions from the sale.' : '', ordinary ? 'error' : '');
      ['make', 'register', 'open', 'claim'].forEach((s) => { $(`[data-step-${s}]`).hidden = ordinary || !S.editions.length; });
      $('[data-make-replace]').hidden = ZERO_KEY.test(S.viewingKey);
      showClaims();
      if (opened) showList();
    } catch (e) { say('[data-safe-msg]', W.friendly(e), 'error'); }
  }

  // ---------- 2 · the key, from a random secret ----------

  let made = null; // { secret, key, saved }
  const secretFile = () => ({
    proofHouseViewingSecret: 2,
    chainId: cfg.chainId,
    wallet: S.wallet,
    publicKey: Seal.hex(made.key.publicKey),
    secret: Seal.hex(made.secret),
    made: new Date().toISOString(),
    note: "Keep this file private. It opens this wallet's ARTIFACTS editions on Proof House (proofhouse.fun/safe). It cannot move or spend anything.",
  });

  function showMade(fromFile) {
    const dl = $('[data-make-facts]');
    dl.textContent = '';
    dl.hidden = false;
    fact(dl, 'Public viewing key', Seal.hex(made.key.publicKey));
    fact(dl, 'For wallet', W.short(S.wallet));
    $('[data-make-save]').hidden = fromFile;
    $('[data-make-keep]').hidden = false;
    $('[data-make-confirm]').hidden = true;
    $('[data-make-saved]').checked = false;
    $('[data-step-register]').classList.toggle('safe-locked', !made.saved);
    showManual();
  }

  $('[data-make]').addEventListener('click', () => {
    if (!S) return;
    if (made && !made.saved && !window.confirm('A key made here has not been saved yet. Replace it with a new one?')) return;
    try {
      const secret = crypto.getRandomValues(new Uint8Array(32));
      const key = Seal.viewingKeyV2FromSecret(secret, new Uint8Array(0));
      if (!Seal.isViewingKeyV2(key.publicKey)) throw new Error('That key came out invalid. Make another.');
      made = { secret, key, saved: false };
      showMade(false);
      say('[data-make-msg]', 'Made. Now save the secret file.');
    } catch (e) { say('[data-make-msg]', e.message || String(e), 'error'); }
  });

  $('[data-make-save]').addEventListener('click', () => {
    if (!made) return;
    saveJson(secretFile(), `ARTIFACTS-viewing-secret-${S.wallet.slice(2, 8)}.json`);
    $('[data-make-confirm]').hidden = false;
    say('[data-make-msg]', 'Check the file is in your downloads (or wherever you saved it), then tick the box.');
  });
  $('[data-make-saved]').addEventListener('change', (ev) => {
    if (!made) return;
    made.saved = ev.target.checked;
    $('[data-step-register]').classList.toggle('safe-locked', !made.saved);
    say('[data-make-msg]', made.saved ? 'Saved. Step 3 registers it from your Safe.' : '');
  });

  // ---------- 3 · the Safe's transactions: Transaction Builder batch files ----------

  // The Transaction Builder's checksum: keccak256 of its own key-sorted serialisation of the batch, with meta.name null.
  // A file without a matching checksum still loads; the app only warns that it was changed.
  function serialize(json) {
    if (Array.isArray(json)) return `[${json.map(serialize).join(',')}]`;
    if (json && typeof json === 'object') {
      const keys = Object.keys(json).sort();
      let acc = `{${JSON.stringify(keys)}`;
      keys.forEach((k) => { acc += `${serialize(json[k])},`; });
      return `${acc}}`;
    }
    return JSON.stringify(json === undefined ? null : json);
  }
  function batchFile(name, description, transactions) {
    const batch = {
      version: '1.0',
      chainId: String(cfg.chainId),
      createdAt: Date.now(),
      meta: { name, description, txBuilderVersion: '1.18.0', createdFromSafeAddress: W.toChecksum(S.wallet), createdFromOwnerAddress: '' },
      transactions,
    };
    const checksum = Seal.hex(Seal.keccak256(new TextEncoder().encode(serialize({ ...batch, meta: { ...batch.meta, name: null } }))));
    return { ...batch, meta: { ...batch.meta, checksum } };
  }
  const tx = (data) => ({ to: W.toChecksum(F), value: '0', data, contractMethod: null, contractInputsValues: null });

  function showManual() {
    const dl = $('[data-reg-manual]');
    dl.textContent = '';
    if (!made) return;
    fact(dl, 'Enter address', W.toChecksum(F));
    fact(dl, 'Contract', 'ArtifactsFactory (its ABI loads by itself: verified on Etherscan)');
    fact(dl, 'Method', 'registerViewingKey');
    fact(dl, 'key (bytes32)', Seal.hex(made.key.publicKey));
    fact(dl, 'ETH value', '0');
  }

  $('[data-reg-file]').addEventListener('click', () => {
    if (!made) { say('[data-reg-msg]', 'Make the viewing key first (step 2).', 'error'); return; }
    if (!made.saved) { say('[data-reg-msg]', 'Save the secret file first (step 2): without it, nothing sent to this key could ever be opened.', 'error'); return; }
    const data = W.encodeCall('registerViewingKey(bytes32)', [Seal.hex(made.key.publicKey)]);
    saveJson(batchFile('ARTIFACTS · register the viewing key', `Registers this Safe's viewing key on the ArtifactsFactory (${F}), so its editions' keys can be sent to it. 0 ETH.`, [tx(data)]),
      `ARTIFACTS-register-viewing-key-${S.wallet.slice(2, 8)}.json`);
    say('[data-reg-msg]', 'Saved. Load it in the Safe app: Apps → Transaction Builder → drop the file in → Create batch → Send batch. Once it is executed, check it here.', 'ok');
  });

  $('[data-reg-check]').addEventListener('click', async () => {
    if (!S) return;
    try {
      const [vk] = await W.read(F, 'viewingKeyOf(address)(bytes32)', [S.wallet]);
      S.viewingKey = lc(vk);
      showWallet();
      $('[data-make-replace]').hidden = ZERO_KEY.test(S.viewingKey);
      if (ZERO_KEY.test(S.viewingKey)) say('[data-reg-msg]', 'Not registered yet. Once the Safe has executed the transaction, check again.', 'error');
      else if (!made) say('[data-reg-msg]', `Your Safe has a viewing key registered (${S.viewingKey.slice(0, 10)}…). Open it with the secret file that made it (step 4).`, 'ok');
      else if (S.viewingKey === lc(Seal.hex(made.key.publicKey))) say('[data-reg-msg]', 'Registered: this key is on-chain for your Safe. Its editions join the curator\'s next key batch.', 'ok');
      else say('[data-reg-msg]', `The Safe's registered key is ${S.viewingKey.slice(0, 10)}…, not the one made here. Open it with the secret file that made it (step 4).`, 'error');
    } catch (e) { say('[data-reg-msg]', W.friendly(e), 'error'); }
  });

  // ---------- 4 · open the editions with the secret ----------

  let opened = null; // { key }: this page's memory only
  let pickFor = 'open'; // which step asked for the file: 'make' (reuse a saved secret) or 'open'
  const pick = (mode) => { pickFor = mode; $('[data-open-file]').click(); };
  $('[data-open-pick]').addEventListener('click', () => pick('open'));
  $('[data-open-pick-1]').addEventListener('click', () => pick('open')); // a returning owner: the file names its Safe
  $('[data-make-load]').addEventListener('click', () => pick('make'));

  // A saved secret file: checked for its format and network, and for the wallet this page is looking at (looked up
  // from the file when nothing is yet). Returns { secret, key }.
  async function readSecretFile(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch (_) { data = null; }
    if (!data || data.proofHouseViewingSecret !== 2 || !/^0x[0-9a-fA-F]{64}$/.test(data.secret || '')) throw new Error('This is not a Proof House viewing secret file.');
    if (Number(data.chainId) !== Number(cfg.chainId)) throw new Error(`This secret was made for chain ${data.chainId}, not ${cfg.chainId}.`);
    if (!S && W.ADDR.test(data.wallet || '')) { $('[data-safe-addr]').value = data.wallet; await lookUpShown(); }
    if (!S) throw new Error('Look your Safe up first (step 1).');
    if (W.ADDR.test(data.wallet || '') && lc(data.wallet) !== S.wallet) throw new Error(`This secret file is for ${W.short(data.wallet)}, not ${W.short(S.wallet)}. Look that wallet up, or choose its own file.`);
    const secret = Seal.fromHex(data.secret);
    return { secret, key: Seal.viewingKeyV2FromSecret(secret, new Uint8Array(0)) };
  }

  $('[data-open-file]').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    // where the answer shows: the step that asked, or step 1 while no wallet has been looked up yet
    const where = () => (pickFor === 'make' ? '[data-make-msg]' : S ? '[data-open-msg]' : '[data-safe-msg]');
    try {
      const { secret, key } = await readSecretFile(file);
      const pub = lc(Seal.hex(key.publicKey));
      if (pickFor === 'make') {
        made = { secret, key, saved: true };
        showMade(true);
        $('[data-make-replace]').hidden = ZERO_KEY.test(S.viewingKey) || pub === S.viewingKey;
        say(where(), pub === S.viewingKey ? 'This is the key already registered for your Safe: nothing more to do in step 3.' : 'Loaded. Step 3 registers it from your Safe.', 'ok');
        return;
      }
      if (pub !== S.viewingKey) {
        throw new Error(ZERO_KEY.test(S.viewingKey)
          ? 'This wallet has no viewing key registered yet: register this one from the Safe first (step 3).'
          : 'This secret does not make the viewing key registered for this wallet. Use the file that made it.');
      }
      opened = { key };
      showList();
      say(where(), 'Your secret opens this wallet\'s viewing key. Choose an edition to see it.', 'ok');
    } catch (e) { say(where(), e.message || String(e), 'error'); }
  });

  function showList() {
    const ul = $('[data-open-list]');
    ul.textContent = '';
    S.editions.forEach((d) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = `#${pad3(d.e)} · ${d.holder ? `claimed, since moved to ${W.short(d.holder)}` : d.posted ? (d.piece ? 'claimed, its own contract' : 'key sent') : 'key not sent yet'}`;
      li.append(label);
      if (d.posted && opened && !d.holder) {
        const b = document.createElement('button');
        b.className = 'btn btn-sm';
        b.type = 'button';
        b.textContent = `View #${pad3(d.e)}`;
        b.addEventListener('click', () => view(d).catch((e) => say('[data-open-msg]', e.message || String(e), 'error')));
        li.append(b);
      }
      ul.append(li);
    });
  }

  // The rules are on-chain: the renderer page from THE SOURCE's chunks, then the seed, then the piece's RENDER_SUFFIX
  // with "),false,EDITION);" for an edition. It runs in a sandboxed frame with no network and hands back its SVG.
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
  let renderer = null;
  async function rendererPage() {
    if (!renderer) {
      const pointers = decodeAddressArray(await call(A.source, W.encodeCall('rendererChunks()', [])));
      const codes = await Promise.all(pointers.map((p) => W.rpc('eth_getCode', [p, 'latest'])));
      const parts = codes.map((code) => Seal.fromHex(code).slice(1)); // SSTORE2: skip the leading STOP byte
      const html = new TextDecoder().decode(new Uint8Array(parts.reduce((a, p) => [...a, ...p], [])));
      const suffix = decodeString(await call(A.piece, W.encodeCall('RENDER_SUFFIX()', [])));
      renderer = { html, suffix };
    }
    return renderer;
  }
  const cropToArt = (svg) => svg
    .replace(/viewBox="0 0 1080 1080" width="1080" height="1080"/, 'viewBox="199 219 682 642" width="682" height="642"')
    .replace('<rect width="1080" height="1080" fill="#ffffff"/>', '<rect x="199" y="219" width="682" height="642" fill="#ffffff"/>');
  const svgUrl = (text) => URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
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
    } finally { URL.revokeObjectURL(url); }
  }

  let shown = null; // { e, svg, url }
  function closeView() {
    if (shown) URL.revokeObjectURL(shown.url);
    shown = null;
    $('[data-view]').hidden = true;
    $('[data-view-img]').hidden = true;
    $('[data-view-img]').removeAttribute('src');
    document.querySelectorAll('[data-view-png]').forEach((b) => { b.hidden = true; });
  }
  async function view(d) {
    if (!opened) throw new Error('Open your secret file first.');
    const e = d.e;
    say('[data-open-msg]', `Opening edition #${pad3(e)} in this browser…`);
    const [wrappedRet, [commitment], sealedRet] = await Promise.all([
      d.piece ? call(d.piece, W.encodeCall('wrappedKey()', [])) : call(F, W.encodeCall('wrappedKeyOf(uint256)', [e])),
      W.read(F, 'commitmentOf(uint256)(bytes32)', [e]),
      call(F, W.encodeCall('ciphertextOf(uint256)', [e])),
    ]);
    const wrapped = decodeBytes(wrappedRet);
    if (!wrapped.length) throw new Error(`Edition #${pad3(e)}'s key has not been sent yet.`);
    const key = await Seal.openKey(wrapped, [opened.key], e, commitment);
    if (!key) throw new Error(`This viewing key does not open edition #${pad3(e)}'s key. If the Safe registered a new viewing key after it was sent, ask the curator to send it again.`);
    const seed = Seal.hex(await Seal.openSeed(decodeBytes(sealedRet), key, e));
    const { html, suffix } = await rendererPage();
    const edition = suffix.replace('"),true);', `"),false,${e});`); // the same rules: not the master, and its number (R8)
    if (edition === suffix) throw new Error('The renderer page on-chain ends differently than this page expects.');
    closeView();
    $('[data-view]').hidden = false;
    $('[data-view-drawing]').hidden = false;
    $('[data-view-caption]').textContent = `ARTIFACTS #${pad3(e)} · private view: drawn from its seed in this browser, sent nowhere`;
    const svg = await drawWithPage(html + seed + edition);
    shown = { e, svg, url: svgUrl(cropToArt(svg)) };
    const img = $('[data-view-img]');
    img.src = shown.url;
    img.alt = `ARTIFACTS #${pad3(e)}, drawn from its seed`;
    img.hidden = false;
    $('[data-view-drawing]').hidden = true;
    document.querySelectorAll('[data-view-png]').forEach((b) => { b.hidden = false; });
    say('[data-open-msg]', `Only you are seeing edition #${pad3(e)}. It is drawn here and gone when you close it.`, 'ok');
  }
  $('[data-view-close]').addEventListener('click', closeView);
  page.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-view-png]');
    if (!b || !shown) return;
    const white = b.dataset.viewPng === 'white';
    artPng(shown.svg, white).then((png) => saveFile(png, `ARTIFACTS-${pad3(shown.e)}${white ? '-white' : ''}.png`), (e) => say('[data-open-msg]', e.message, 'error'));
  });

  // ---------- 5 · claim from the Safe ----------

  function showClaims() {
    const box = $('[data-claim-files]');
    box.textContent = '';
    if (!S) return;
    const ready = S.editions.filter((d) => d.posted && !d.piece).map((d) => d.e);
    if (!ready.length) {
      say('[data-claim-msg]', S.editions.every((d) => d.piece) ? 'Every edition here is claimed.' : 'Nothing to claim yet: an edition can be claimed once its key has been sent.');
      return;
    }
    say('[data-claim-msg]', '');
    for (let i = 0; i < ready.length; i += CLAIMS_PER_TX) {
      const part = ready.slice(i, i + CLAIMS_PER_TX);
      const names = part.map((e) => `#${pad3(e)}`).join(' and ');
      const b = document.createElement('button');
      b.className = 'btn btn-sm';
      b.type = 'button';
      b.textContent = `Claim ${names}`;
      b.addEventListener('click', () => {
        // claimMany(uint256[]): selector, offset, length, then each edition (encodeCall takes static types only)
        const w = (n) => BigInt(n).toString(16).padStart(64, '0');
        const data = W.keccakHex('claimMany(uint256[])').slice(0, 10) + w(32) + w(part.length) + part.map(w).join('');
        saveJson(batchFile(`ARTIFACTS · claim ${names}`, `Claims ${names} from the ArtifactsFactory (${F}): each becomes its own contract holding its one token, owned by this Safe. 0 ETH.`, [tx(data)]),
          `ARTIFACTS-claim-${part.map(pad3).join('-')}.json`);
        say('[data-claim-msg]', `Saved. Load it in the Transaction Builder, then Create batch → Send batch. Look the wallet up again afterwards to see ${names} as claimed.`, 'ok');
      });
      box.append(b);
    }
  }

  // a link with ?wallet=0x… fills the address in
  const pre = new URLSearchParams(location.search).get('wallet');
  if (W.ADDR.test(pre || '')) { $('[data-safe-addr]').value = pre; $('[data-safe-look]').click(); }
})();
