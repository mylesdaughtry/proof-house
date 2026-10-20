// Proof House: reading artist submissions (ArtHouse) and the reviews of them (SubmissionReviews), where every
// identity.md seat and every claimed Artifacts piece is one voice.
// Shared by the Review page and the curator page; posting a review lives on the Review page.
(function () {
  'use strict';
  const W = window.ProofHouseWallet;
  if (!W) return;

  const VERDICTS = ['', 'Back', 'Neutral', 'Pass'];
  const REVIEWED = W.keccakHex('Reviewed(uint256,uint256,address,uint8,string)');
  // A voice is a seat id, or PIECE_VOICE + a piece id.
  const PIECE_VOICE = 1n << 128n;
  const ZERO = /^0x0{40}$/;
  const live = (a) => W.ADDR.test(a || '') && !ZERO.test(a);

  const text = (hex) => new TextDecoder().decode(Uint8Array.from(hex.match(/../g) || [], (x) => parseInt(x, 16)));

  // submissions(id) returns (address submitter, bytes32 contentHash, string previewURI, uint8 status).
  async function submission(H, id) {
    const ret = await W.rpc('eth_call', [{ to: H, data: W.encodeCall('submissions(uint256)', [id]) }, 'latest']);
    const h = ret.slice(2);
    const word = (i) => h.slice(i * 64, i * 64 + 64);
    const at = Number(BigInt('0x' + word(2))) * 2;
    const len = Number(BigInt('0x' + h.slice(at, at + 64)));
    return { id, submitter: '0x' + word(0).slice(24), hash: '0x' + word(1), uri: text(h.slice(at + 64, at + 64 + len * 2)), status: Number(BigInt('0x' + word(3))) };
  }

  // A custom submission stores its details as data:application/json;base64,… in the preview field.
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
  function packageOf(uri) {
    const prefix = 'data:application/json;base64,';
    if (typeof uri !== 'string' || !uri.startsWith(prefix)) return null;
    try {
      const bin = atob(uri.slice(prefix.length));
      return cleanPackage(JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))));
    } catch (_) { return null; }
  }

  // Only plain https links open; anything else is shown as text, never as a link.
  const safeHref = (u) => (typeof u !== 'string' ? null : /^https:\/\/\S+$/.test(u) ? u : u.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${u.slice(7)}` : null);

  // Logs from the deployment block, oldest first (settled ones are kept in this browser; see W.logs).
  const logs = (address, topics, fromBlock) => W.logs({ address, topics }, fromBlock);

  function voiceOf(v) {
    const n = BigInt(v);
    return n >= PIECE_VOICE ? { kind: 'piece', id: Number(n - PIECE_VOICE) } : { kind: 'seat', id: Number(n) };
  }
  const voiceKey = (kind, id) => (kind === 'piece' ? PIECE_VOICE + BigInt(id) : BigInt(id)).toString();
  const voiceLabel = (x) => (x.kind === 'piece' ? (x.id === 256 ? 'THE SOURCE' : `Piece #${String(x.id).padStart(3, '0')}`) : `Seat #${x.id}`);

  // Every submission's current reviews: the latest review from each voice, and the tally [back, neutral, pass].
  // Reviewed's data is the verdict (word 0), then the note as a string at the offset in word 1.
  async function reviews(R, fromBlock) {
    const by = {};
    for (const l of await logs(R, [REVIEWED], fromBlock)) {
      const h = l.data.slice(2);
      const off = Number(BigInt('0x' + h.slice(64, 128))) * 2;
      const len = Number(BigInt('0x' + h.slice(off, off + 64)));
      const r = {
        submission: Number(BigInt(l.topics[1])), voice: BigInt(l.topics[2]).toString(), ...voiceOf(l.topics[2]), reviewer: '0x' + l.topics[3].slice(26),
        verdict: Number(BigInt('0x' + h.slice(0, 64))), note: text(h.slice(off + 64, off + 64 + len * 2)), tx: l.transactionHash,
      };
      (by[r.submission] = by[r.submission] || new Map()).set(r.voice, r); // a later review from the same voice replaces it
    }
    const out = {};
    for (const [id, m] of Object.entries(by)) {
      const list = [...m.values()].sort((a, b) => a.verdict - b.verdict || (a.kind === b.kind ? a.id - b.id : a.kind === 'seat' ? -1 : 1));
      out[id] = { list, tally: [1, 2, 3].map((v) => list.filter((r) => r.verdict === v).length) };
    }
    return out;
  }

  // Every thesis on each submission (any wallet may write one), the latest per author: { [id]: [{ author, text, block, tx }] }, newest first.
  // Thesis(uint256 indexed submissionId, address indexed author, string text).
  const THESIS = W.keccakHex('Thesis(uint256,address,string)');
  async function theses(R, fromBlock) {
    const by = {};
    for (const l of await logs(R, [THESIS], fromBlock)) {
      const h = l.data.slice(2);
      const off = Number(BigInt('0x' + h.slice(0, 64))) * 2;
      const len = Number(BigInt('0x' + h.slice(off, off + 64)));
      const t = { submission: Number(BigInt(l.topics[1])), author: ('0x' + l.topics[2].slice(26)).toLowerCase(), text: text(h.slice(off + 64, off + 64 + len * 2)), block: l.blockNumber, tx: l.transactionHash };
      (by[t.submission] = by[t.submission] || new Map()).set(t.author, t); // a later thesis by the same author replaces it
    }
    const out = {};
    for (const [id, m] of Object.entries(by)) out[id] = [...m.values()].sort((a, b) => b.block - a.block);
    return out;
  }

  // What each broker has brought, from the ledger: sales naming it (Sale: collection, buyer, broker; currency, amount,
  // broker share, …) and resales (Resale: collection, piece, broker; royalty, broker share). { [broker]: { sales, eth } }.
  const SALE = W.keccakHex('Sale(address,address,address,address,uint256,uint256,uint256,uint256,uint256)');
  const RESALE = W.keccakHex('Resale(address,address,address,uint256,uint256)');
  async function brought(H, fromBlock) {
    const [sales, resales] = await Promise.all([logs(H, [SALE], fromBlock), logs(H, [RESALE], fromBlock)]);
    const out = {};
    const add = (topic, share, eth, buyerTopic) => {
      const who = ('0x' + topic.slice(26)).toLowerCase();
      if (ZERO.test(who)) return;
      if (buyerTopic && ('0x' + buyerTopic.slice(26)).toLowerCase() === who) return; // its own buys aren't brought
      const o = (out[who] = out[who] || { sales: 0, eth: 0n });
      o.sales += 1;
      if (eth) o.eth += share;
    };
    sales.forEach((l) => { const h = l.data.slice(2); add(l.topics[3], BigInt('0x' + h.slice(128, 192)), /^0{64}$/.test(h.slice(0, 64)), l.topics[2]); });
    resales.forEach((l) => add(l.topics[3], BigInt('0x' + l.data.slice(66, 130)), true));
    return out;
  }

  // "Back 2 · Neutral 0 · Pass 1", or a plain note when nobody has reviewed yet.
  const tallyText = (t) => (t && t.some((n) => n) ? `Back ${t[0]} · Neutral ${t[1]} · Pass ${t[2]}` : 'No reviews yet');

  // A thesis may end with the writer's post on X ("\n\nOn X: https://x.com/<handle>/status/<id>"), so the curator can
  // read the case and its post together. { body, x }: x only when it is exactly such a post link.
  const X_POST = /^https:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d{5,25}(?:\?[\w=&.-]*)?$/;
  function splitX(text) {
    const m = /\n\nOn X: (\S+)\s*$/.exec(String(text || ''));
    return m && X_POST.test(m[1]) ? { body: text.slice(0, m.index), x: m[1] } : { body: String(text || ''), x: null };
  }
  const withX = (body, x) => (x ? `${body}\n\nOn X: ${x}` : body);

  // Applications to be a broker (a thesis for the house itself, any wallet), the latest per author:
  // { [author]: { author, text, block, tx } }. BrokerApplication(address indexed author, string text).
  const APPLIED = W.keccakHex('BrokerApplication(address,string)');
  async function applications(R, fromBlock) {
    const out = {};
    for (const l of await logs(R, [APPLIED], fromBlock)) {
      const h = l.data.slice(2);
      const off = Number(BigInt('0x' + h.slice(0, 64))) * 2;
      const len = Number(BigInt('0x' + h.slice(off, off + 64)));
      const a = { author: ('0x' + l.topics[1].slice(26)).toLowerCase(), text: text(h.slice(off + 64, off + 64 + len * 2)), block: l.blockNumber, tx: l.transactionHash };
      const prev = out[a.author];
      if (!prev || Number(a.block) >= Number(prev.block)) out[a.author] = a;
    }
    return out;
  }

  window.PHReviews = { X_POST, splitX, withX, applications, VERDICTS, live, submission, packageOf, cleanPackage, safeHref, reviews, theses, brought, voiceKey, voiceLabel, tallyText, MAX_THESIS: 4000 };
})();
