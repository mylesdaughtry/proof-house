// Proof House seal crypto for ARTIFACTS: viewing keys, key wrapping, and THE SOURCE's keystream.
// One file for the browser (window.ProofHouseSeal) and the offline Node tools (require), so both speak one format.
//
// Viewing key   secret = HKDF-SHA256(ikm = the wallet's 65-byte signature over VIEWING_MESSAGE, v as 27/28,
//                                    salt = "Proof House viewing key v1", info = "x25519"), used as an X25519 key.
//               The 32-byte X25519 public key is registered on-chain as a bytes32.
// Wrapped key   0x01 ‖ ephemeral X25519 public key (32) ‖ nonce (12) ‖ AES-256-GCM(K) (32 + 16-byte tag): 93 bytes.
//               AES key = HKDF-SHA256(ikm = X25519(ephemeral, viewing public key),
//                                     salt = ephemeral public ‖ viewing public, info = "Proof House key wrap v1");
//               additional data = the piece id as a 32-byte big-endian integer.
// Editions     each sealed seed (60 bytes) = nonce (12) ‖ AES-256-GCM(K, seed) (32 + 16-byte tag), additional data =
//               the edition id as a 32-byte big-endian integer. Commitment keccak256(K).
// THE SOURCE    stored byte j = plaintext byte j XOR byte (j % 32) of keccak256(K ‖ uint256(j / 32)).
//               Commitment keccak256(K). The same function encrypts and decrypts.
//
// Version 2 (contracts from v13): keys a contract can check, on secp256k1, Ethereum's own curve.
// Viewing key   the signature is over viewingMessage(2, chain id), which names the network, so a test network's keys
//               are never mainnet's; a wallet must sign it the same way every time (the site checks once, before
//               registering a key).
//               d = keccak256("Proof House viewing key v2" ‖ signature ‖ scope ‖ counter) mod n, the first counter
//               giving a public point D = d·G with x < n; d is negated if needed so D has an even y. Registered as D's
//               x (bytes32). Scope: empty for the wallet's key (first claims), chain id ‖ piece address for the key a
//               buyer registers when buying that piece, so each piece has a key of its own (bought again, the same one).
// Wrapped key   0x02 ‖ E.x (32) ‖ K XOR keccak256("Proof House key wrap v2" ‖ piece id ‖ B.x ‖ E.x ‖ S.x) (32): 65 bytes.
//               E = e·G is a fresh ephemeral point (even y, x < n), B the viewing key (lifted with even y), S = e·B =
//               b·E the shared point (x < n). No tag: a key is checked by keccak256(K) against the piece's commitment.
// Fake-key proof  the buyer reveals S for one wrapped key and proves S = b·E for the b behind their viewing key
//               (Chaum-Pedersen: A1 = w·G, A2 = w·E, c = keccak256("Proof House fake key v2" ‖ chain id ‖ piece ‖
//               buyer ‖ B.x ‖ E.x ‖ S ‖ A1 ‖ A2) mod n, z = w + c·b), with X = c·S as a hint. The contract checks it
//               with ecrecover and decrypts: a key that opens can never be proven fake.
(function (root, factory) {
  const webcrypto = root.crypto && root.crypto.subtle ? root.crypto : require('crypto').webcrypto;
  const api = factory(webcrypto);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProofHouseSeal = api;
})(typeof self !== 'undefined' ? self : globalThis, function (webcrypto) {
  'use strict';
  const subtle = webcrypto.subtle;
  const enc = new TextEncoder();

  const VIEWING_MESSAGE = [
    'Proof House viewing key',
    '',
    'Signing this creates your private viewing key for ARTIFACTS. It stays in this browser and is never sent anywhere.',
    '',
    'Only sign this on the Proof House site: anyone holding this signature can view your pieces.',
    '',
    'Version 1',
  ].join('\n');
  // Version 2 keys (contracts from v13) are signed over a message that names the network, so a signature given on a
  // test network never makes the mainnet key, and that says where to sign it.
  const NETWORK_NAMES = { 1: 'Ethereum mainnet', 11155111: 'the Sepolia test network' };
  function viewingMessage(scheme, chainId) {
    if (Number(scheme) !== 2) return VIEWING_MESSAGE;
    const id = Number(chainId);
    if (!Number.isInteger(id) || id < 1) throw new Error('A viewing key needs the network it is for.');
    return [
      'Proof House viewing key',
      '',
      `Signing this creates your private viewing keys for ARTIFACTS on ${NETWORK_NAMES[id] || `chain ${id}`}. They stay in this browser and are never sent anywhere.`,
      '',
      'Only sign this on proofhouse.fun or its ARTIFACTS market: anyone holding this signature can view your pieces.',
      '',
      `Chain ${id}, version 2`,
    ].join('\n');
  }
  const WRAP_VERSION = 1;
  const WRAPPED_LENGTH = 93;
  const PKCS8_X25519 = fromHex('302e020100300506032b656e04220420');

  // ---------- bytes ----------

  function hex(bytes) {
    return '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function fromHex(h) {
    const s = String(h).replace(/^0x/i, '').replace(/\s+/g, '');
    if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error('Not hex.');
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }

  function uint256(n) {
    const out = new Uint8Array(32);
    let v = BigInt(n);
    for (let i = 31; i >= 0 && v > 0n; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
    return out;
  }

  // ---------- keccak-256 (32-bit lanes, fast enough for THE SOURCE's 57,000 keystream blocks) ----------

  const RC64 = [
    '0000000000000001', '0000000000008082', '800000000000808a', '8000000080008000', '000000000000808b',
    '0000000080000001', '8000000080008081', '8000000000008009', '000000000000008a', '0000000000000088',
    '0000000080008009', '000000008000000a', '000000008000808b', '800000000000008b', '8000000000008089',
    '8000000000008003', '8000000000008002', '8000000000000080', '000000000000800a', '800000008000000a',
    '8000000080008081', '8000000000008080', '0000000080000001', '8000000080008008',
  ];
  const RCL = Uint32Array.from(RC64, (h) => parseInt(h.slice(8), 16));
  const RCH = Uint32Array.from(RC64, (h) => parseInt(h.slice(0, 8), 16));
  const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
  const PI = new Uint8Array(25); // lane (x, y) moves to (y, 2x + 3y)
  for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) PI[x + 5 * y] = y + 5 * ((2 * x + 3 * y) % 5);

  const C = new Uint32Array(10);
  const B = new Uint32Array(50);
  function keccakF(s) {
    for (let round = 0; round < 24; round++) {
      for (let x = 0; x < 5; x++) {
        C[2 * x] = s[2 * x] ^ s[2 * x + 10] ^ s[2 * x + 20] ^ s[2 * x + 30] ^ s[2 * x + 40];
        C[2 * x + 1] = s[2 * x + 1] ^ s[2 * x + 11] ^ s[2 * x + 21] ^ s[2 * x + 31] ^ s[2 * x + 41];
      }
      for (let x = 0; x < 5; x++) {
        const a = (x + 4) % 5;
        const b = (x + 1) % 5;
        const bl = C[2 * b];
        const bh = C[2 * b + 1];
        const dl = C[2 * a] ^ ((bl << 1) | (bh >>> 31));
        const dh = C[2 * a + 1] ^ ((bh << 1) | (bl >>> 31));
        for (let y = 0; y < 25; y += 5) { s[2 * (x + y)] ^= dl; s[2 * (x + y) + 1] ^= dh; }
      }
      for (let i = 0; i < 25; i++) {
        const lo = s[2 * i];
        const hi = s[2 * i + 1];
        const n = ROT[i];
        const j = PI[i];
        if (n === 0) { B[2 * j] = lo; B[2 * j + 1] = hi; }
        else if (n < 32) { B[2 * j] = (lo << n) | (hi >>> (32 - n)); B[2 * j + 1] = (hi << n) | (lo >>> (32 - n)); }
        else if (n === 32) { B[2 * j] = hi; B[2 * j + 1] = lo; }
        else { const m = n - 32; B[2 * j] = (hi << m) | (lo >>> (32 - m)); B[2 * j + 1] = (lo << m) | (hi >>> (32 - m)); }
      }
      for (let y = 0; y < 25; y += 5) {
        for (let x = 0; x < 5; x++) {
          const i = x + y;
          const i1 = ((x + 1) % 5) + y;
          const i2 = ((x + 2) % 5) + y;
          s[2 * i] = B[2 * i] ^ (~B[2 * i1] & B[2 * i2]);
          s[2 * i + 1] = B[2 * i + 1] ^ (~B[2 * i1 + 1] & B[2 * i2 + 1]);
        }
      }
      s[0] ^= RCL[round];
      s[1] ^= RCH[round];
    }
  }

  function keccak256(bytes) {
    const rate = 136;
    const s = new Uint32Array(50);
    const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
    padded.set(bytes);
    padded[bytes.length] ^= 0x01;
    padded[padded.length - 1] ^= 0x80;
    for (let off = 0; off < padded.length; off += rate) {
      for (let i = 0; i < rate / 4; i++) {
        const k = off + i * 4;
        s[i] ^= padded[k] | (padded[k + 1] << 8) | (padded[k + 2] << 16) | (padded[k + 3] << 24);
      }
      keccakF(s);
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      out[i * 4] = s[i] & 0xff;
      out[i * 4 + 1] = (s[i] >>> 8) & 0xff;
      out[i * 4 + 2] = (s[i] >>> 16) & 0xff;
      out[i * 4 + 3] = (s[i] >>> 24) & 0xff;
    }
    return out;
  }

  /// THE SOURCE's cipher: its own inverse. `key` is the 32-byte K.
  function keystreamXor(data, key) {
    if (key.length !== 32) throw new Error('The key must be 32 bytes.');
    const out = new Uint8Array(data.length);
    const block = new Uint8Array(64);
    block.set(key, 0);
    for (let i = 0, at = 0; at < data.length; i++, at += 32) {
      block[60] = (i >>> 24) & 0xff;
      block[61] = (i >>> 16) & 0xff;
      block[62] = (i >>> 8) & 0xff;
      block[63] = i & 0xff;
      const ks = keccak256(block);
      const end = Math.min(32, data.length - at);
      for (let j = 0; j < end; j++) out[at + j] = data[at + j] ^ ks[j];
    }
    return out;
  }

  const commitment = (key) => hex(keccak256(key));

  // ---------- viewing keys ----------

  async function hkdf(ikm, salt, info) {
    const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, base, 256));
  }

  function b64urlToBytes(s) {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    const bin = atob(b64);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  /// An X25519 viewing key from 32 secret bytes: { privateKey (CryptoKey), publicKey (32 bytes) }.
  async function viewingKeyFromSecret(secret) {
    if (secret.length !== 32) throw new Error('The viewing secret must be 32 bytes.');
    const privateKey = await subtle.importKey('pkcs8', concat(PKCS8_X25519, secret), { name: 'X25519' }, true, ['deriveBits']);
    const jwk = await subtle.exportKey('jwk', privateKey);
    return { privateKey, publicKey: b64urlToBytes(jwk.x) };
  }

  /// The owner's viewing key, from their wallet's signature over VIEWING_MESSAGE (65 bytes).
  async function viewingKeyFromSignature(signature) {
    if (signature.length !== 65) throw new Error('A viewing key needs a 65-byte wallet signature.');
    const sig = Uint8Array.from(signature);
    if (sig[64] < 27) sig[64] += 27; // wallets differ: v as 0/1 or 27/28, so one key gives one viewing key
    const secret = await hkdf(sig, enc.encode('Proof House viewing key v1'), enc.encode('x25519'));
    return viewingKeyFromSecret(secret);
  }

  // ---------- wrapping K to a viewing key ----------

  async function wrapAesKey(shared, ephPub, recipientPub, usage) {
    const bits = await hkdf(shared, concat(ephPub, recipientPub), enc.encode('Proof House key wrap v1'));
    return subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, [usage]);
  }

  /// Wraps the 32-byte K to a 32-byte X25519 viewing public key, bound to the piece id.
  async function wrapKey(key, recipientPub, pieceId) {
    if (key.length !== 32 || recipientPub.length !== 32) throw new Error('The key and viewing key must be 32 bytes.');
    const eph = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    const ephPub = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
    const recipient = await subtle.importKey('raw', recipientPub, { name: 'X25519' }, false, []);
    const shared = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: recipient }, eph.privateKey, 256));
    const aes = await wrapAesKey(shared, ephPub, recipientPub, 'encrypt');
    const nonce = webcrypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: uint256(pieceId) }, aes, key));
    return concat(Uint8Array.of(WRAP_VERSION), ephPub, nonce, sealed);
  }

  /// Unwraps K with the owner's viewing key ({ privateKey, publicKey }). Throws if it was wrapped to another key.
  async function unwrapKey(wrapped, viewingKey, pieceId) {
    if (wrapped.length !== WRAPPED_LENGTH || wrapped[0] !== WRAP_VERSION) throw new Error('Not a Proof House wrapped key.');
    const ephPub = wrapped.slice(1, 33);
    const nonce = wrapped.slice(33, 45);
    const sealed = wrapped.slice(45);
    const eph = await subtle.importKey('raw', ephPub, { name: 'X25519' }, false, []);
    const shared = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: eph }, viewingKey.privateKey, 256));
    const aes = await wrapAesKey(shared, ephPub, viewingKey.publicKey, 'decrypt');
    try {
      return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: uint256(pieceId) }, aes, sealed));
    } catch (_) {
      throw new Error('This key was not wrapped to your viewing key.');
    }
  }

  // ---------- secp256k1, for version 2 ----------

  const P = 2n ** 256n - 2n ** 32n - 977n;
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const G = { x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n };
  const md = (a, m = P) => { const r = a % m; return r >= 0n ? r : r + m; };
  function powmod(b, e, m) { let r = 1n; b = md(b, m); while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; }
  const invP = (a) => powmod(a, P - 2n, P);
  const big = (bytes) => BigInt(hex(bytes));
  const b32 = (n) => uint256(n);
  // Jacobian coordinates (a = 0), affine only at the end
  function jDouble([X, Y, Z]) {
    if (Z === 0n || Y === 0n) return [0n, 1n, 0n];
    const YY = md(Y * Y);
    const S = md(4n * X * YY);
    const M = md(3n * X * X);
    const X3 = md(M * M - 2n * S);
    return [X3, md(M * (S - X3) - 8n * YY * YY), md(2n * Y * Z)];
  }
  function jAdd(a, b) {
    if (a[2] === 0n) return b;
    if (b[2] === 0n) return a;
    const [X1, Y1, Z1] = a;
    const [X2, Y2, Z2] = b;
    const Z1Z1 = md(Z1 * Z1);
    const Z2Z2 = md(Z2 * Z2);
    const U1 = md(X1 * Z2Z2);
    const U2 = md(X2 * Z1Z1);
    const S1 = md(Y1 * Z2 * Z2Z2);
    const S2 = md(Y2 * Z1 * Z1Z1);
    if (U1 === U2) return S1 === S2 ? jDouble(a) : [0n, 1n, 0n];
    const H = md(U2 - U1);
    const R = md(S2 - S1);
    const HH = md(H * H);
    const HHH = md(H * HH);
    const V = md(U1 * HH);
    const X3 = md(R * R - HHH - 2n * V);
    return [X3, md(R * (V - X3) - S1 * HHH), md(Z1 * Z2 * H)];
  }
  function affine([X, Y, Z]) {
    if (Z === 0n) return null;
    const zi = invP(Z);
    const zi2 = md(zi * zi);
    return { x: md(X * zi2), y: md(Y * zi2 * zi) };
  }
  function mul(pt, k) {
    k = md(k, N);
    let r = [0n, 1n, 0n];
    let a = [pt.x, pt.y, 1n];
    while (k > 0n) { if (k & 1n) r = jAdd(r, a); a = jDouble(a); k >>= 1n; }
    return affine(r);
  }
  const onCurve = (q) => q && q.x < P && q.y < P && md(q.y * q.y) === md(q.x * q.x * q.x + 7n);
  /// The point with this x and an even y; null if x is not on the curve.
  function liftX(x) {
    if (x <= 0n || x >= P) return null;
    const c = md(x * x * x + 7n);
    const y = powmod(c, (P + 1n) / 4n, P);
    if (md(y * y) !== c) return null;
    return { x, y: y & 1n ? P - y : y };
  }
  /// The address that signed a 32-byte digest (hex) with a 65-byte signature (0x r ‖ s ‖ v, v 27 or 28), computed here:
  /// the signature behind a viewing key must never be sent anywhere, not even to an RPC to check it. Null if invalid.
  function recoverAddress(digestHex, sigHex) {
    const h = String(sigHex).replace(/^0x/, '');
    if (!/^[0-9a-fA-F]{130}$/.test(h)) return null;
    const r = BigInt('0x' + h.slice(0, 64));
    const s = BigInt('0x' + h.slice(64, 128));
    const v = parseInt(h.slice(128, 130), 16);
    if (r === 0n || r >= N || s === 0n || s >= N || (v !== 27 && v !== 28)) return null;
    const R0 = liftX(r);
    if (!R0) return null;
    const R = v === 28 ? { x: R0.x, y: P - R0.y } : R0;
    const z = md(BigInt(digestHex), N);
    const rinv = powmod(r, N - 2n, N);
    const a = mul(G, md(-z * rinv, N));
    const b = mul(R, md(s * rinv, N));
    const Q = !a ? b : !b ? a : affine(jAdd([a.x, a.y, 1n], [b.x, b.y, 1n]));
    if (!Q) return null;
    return hex(keccak256(concat(b32(Q.x), b32(Q.y))).slice(12));
  }

  function randomScalar() {
    for (;;) { const k = md(big(webcrypto.getRandomValues(new Uint8Array(32))), N); if (k !== 0n) return k; }
  }
  const WRAP2 = enc.encode('Proof House key wrap v2');
  const pad2 = (pieceId, bx, ex, sx) => keccak256(concat(WRAP2, uint256(pieceId), b32(bx), b32(ex), b32(sx)));

  /// A version 2 viewing key from the wallet's signature (65 bytes) and a scope (bytes; empty for the wallet's key):
  /// { scheme: 2, secret (bigint, D with even y), publicKey (32 bytes: D.x) }.
  function viewingKeyV2(signature, scope) {
    if (signature.length !== 65) throw new Error('A viewing key needs a 65-byte wallet signature.');
    const sig = Uint8Array.from(signature);
    if (sig[64] < 27) sig[64] += 27;
    // one form per signature: the low s (EIP-2), v flipped with it, so every wallet and tool derives the same key
    const s = big(sig.slice(32, 64));
    if (s > N / 2n) { sig.set(b32(N - s), 32); sig[64] = sig[64] === 27 ? 28 : 27; }
    return deriveV2(enc.encode('Proof House viewing key v2'), sig, scope);
  }
  /// The same from 32 secret bytes instead of a signature (agents that keep their own key, see agents.md).
  function viewingKeyV2FromSecret(secret, scope) {
    if (secret.length !== 32) throw new Error('The viewing secret must be 32 bytes.');
    return deriveV2(enc.encode('Proof House viewing key v2 secret'), secret, scope);
  }
  function deriveV2(domain, material, scope) {
    const sc = scope || new Uint8Array(0);
    for (let i = 0; i < 256; i++) {
      let d = md(big(keccak256(concat(domain, material, sc, Uint8Array.of(i)))), N);
      if (d === 0n) continue;
      const D = mul(G, d);
      if (D.x >= N) continue;
      if (D.y & 1n) d = N - d;
      return { scheme: 2, secret: d, publicKey: b32(D.x) };
    }
    throw new Error('No viewing key found.');
  }
  /// The scope of the key a buyer registers for one piece: chain id ‖ the piece's address.
  const pieceScope = (chainId, pieceAddress) => concat(uint256(chainId), fromHex(pieceAddress));
  /// Whether a registered viewing key (32 bytes) can receive version 2 keys: on the curve, with x < n.
  function isViewingKeyV2(pub) {
    const x = big(pub);
    return x < N && !!liftX(x);
  }

  function wrapKeyV2(key, recipientPub, pieceId) {
    return wrapV2(key, recipientPub, pieceId).wrapped;
  }
  /// A wrapped key for a resale, with the proof postEscrowKey takes from v13 (KeyProof.knowsWrap: the seller knows the
  /// e behind E, so nobody can post a key made from someone else's E). ctx: { chainId, piece, buyer, viewingKey } as
  /// the escrow holds them (0x hex). Returns { wrapped, r (an address, 0x hex), z (a decimal string) }.
  function wrapKeyForSale(key, recipientPub, pieceId, ctx) {
    const { wrapped, e } = wrapV2(key, recipientPub, pieceId);
    for (;;) {
      const k = randomScalar();
      const R = mul(G, k);
      const r = hex(keccak256(concat(b32(R.x), b32(R.y))).slice(12));
      const c = md(big(keccak256(concat(enc.encode('Proof House key wrap v2 proof'), uint256(ctx.chainId), fromHex(ctx.piece), fromHex(ctx.buyer),
        fromHex(ctx.viewingKey), keccak256(wrapped), fromHex(r)))), N);
      const z = md(k + c * e, N);
      if (c === 0n || z === 0n) continue;
      return { wrapped, r, z: z.toString() };
    }
  }
  function wrapV2(key, recipientPub, pieceId) {
    if (key.length !== 32 || recipientPub.length !== 32) throw new Error('The key and viewing key must be 32 bytes.');
    const B = liftX(big(recipientPub));
    if (!B || B.x >= N) throw new Error('That viewing key is not a version 2 viewing key.');
    for (;;) {
      let e = randomScalar();
      const E = mul(G, e);
      if (E.x >= N) continue;
      if (E.y & 1n) e = N - e; // E with an even y, as it is read back from its x
      const S = mul(B, e);
      if (S.x >= N) continue; // so the buyer can always prove a fake
      const pad = pad2(pieceId, B.x, E.x, S.x);
      return { wrapped: concat(Uint8Array.of(2), b32(E.x), key.map((v, i) => v ^ pad[i])), e };
    }
  }
  function unwrapKeyV2(wrapped, viewingKey, pieceId) {
    if (wrapped.length !== 65 || wrapped[0] !== 2) throw new Error('Not a version 2 wrapped key.');
    if (viewingKey.scheme !== 2) throw new Error('A version 2 key needs a version 2 viewing key.');
    const E = liftX(big(wrapped.slice(1, 33)));
    if (!E || E.x >= N) throw new Error('This wrapped key is malformed.');
    const S = mul(E, viewingKey.secret);
    const pad = pad2(pieceId, big(viewingKey.publicKey), E.x, S.x);
    return wrapped.slice(33).map((v, i) => v ^ pad[i]);
  }

  /// The proof that a wrapped key doesn't open (the caller has checked it doesn't): the arguments of
  /// ArtifactsPiece.proveFakeKey, as decimal strings. ctx: { chainId, piece, buyer } (addresses as 0x hex).
  function proveFakeKey(wrapped, viewingKey, ctx) {
    if (wrapped.length !== 65 || wrapped[0] !== 2) return { malformed: true, args: Array(9).fill('0') };
    const E = liftX(big(wrapped.slice(1, 33)));
    if (!E || E.x >= N) return { malformed: true, args: Array(9).fill('0') };
    const b = viewingKey.secret;
    const B = mul(G, b);
    if (B.y & 1n || hex(b32(B.x)) !== hex(viewingKey.publicKey)) throw new Error('This viewing key does not match.');
    const S = mul(E, b);
    if (S.x >= N) throw new Error('This wrapped key cannot be proven fake: its shared point is out of range.');
    for (;;) {
      const w = randomScalar();
      const A1 = mul(G, w);
      const A2 = mul(E, w);
      const c = md(big(keccak256(concat(enc.encode('Proof House fake key v2'), uint256(ctx.chainId), fromHex(ctx.piece), fromHex(ctx.buyer),
        b32(B.x), b32(E.x), b32(S.x), b32(S.y), b32(A1.x), b32(A1.y), b32(A2.x), b32(A2.y)))), N);
      const X = mul(S, c);
      if (c === 0n || !X || X.x === A2.x) continue; // re-draw w: the contract adds A2 and X
      const z = md(w + c * b, N);
      if (z === 0n) continue;
      return { malformed: false, args: [S.x, S.y, A1.x, A1.y, A2.x, A2.y, X.x, X.y, z].map(String) };
    }
  }

  // ---------- one signature, every key ----------

  /// Every viewing key one wallet signature makes: version 2 for the wallet (first claims, THE SOURCE) and for each
  /// piece bought on the market, and version 1 for older test deployments (made only when asked for).
  function keyring(signature) {
    let v1 = null;
    const scoped = new Map();
    return {
      wallet: viewingKeyV2(signature, new Uint8Array(0)),
      forPiece(chainId, piece) {
        const k = `${chainId}:${String(piece).toLowerCase()}`;
        if (!scoped.has(k)) scoped.set(k, viewingKeyV2(signature, pieceScope(chainId, piece)));
        return scoped.get(k);
      },
      v1: () => (v1 = v1 || viewingKeyFromSignature(signature)),
    };
  }

  /// K from a wrapped key, with whichever of `keys` it was wrapped to (version 1 or 2), checked against the piece's
  /// commitment (0x hex); null if none of them opens it.
  async function openKey(wrapped, keys, pieceId, commitmentHex) {
    const want = String(commitmentHex).toLowerCase();
    for (const k of keys) {
      if (!k) continue;
      try {
        let key = null;
        if (wrapped[0] === 2 && k.scheme === 2) key = unwrapKeyV2(wrapped, k, pieceId);
        else if (wrapped[0] === WRAP_VERSION && k.scheme !== 2) key = await unwrapKey(wrapped, k, pieceId);
        if (key && commitment(key).toLowerCase() === want) return key;
      } catch (_) { /* not this key */ }
    }
    return null;
  }

  // ---------- an edition's sealed seed ----------

  async function sealSeed(seed, key, pieceId) {
    if (seed.length !== 32 || key.length !== 32) throw new Error('The seed and key must be 32 bytes.');
    const aes = await subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
    const nonce = webcrypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: uint256(pieceId) }, aes, seed));
    return concat(nonce, sealed);
  }

  async function openSeed(ciphertext, key, pieceId) {
    if (ciphertext.length !== 60) throw new Error('Not an ARTIFACTS sealed seed.');
    const aes = await subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
    try {
      return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: ciphertext.slice(0, 12), additionalData: uint256(pieceId) }, aes, ciphertext.slice(12)));
    } catch (_) {
      throw new Error("This key does not open this piece's seed.");
    }
  }

  return {
    sealSeed, openSeed,
    VIEWING_MESSAGE, viewingMessage, hex, fromHex, keccak256, keystreamXor, commitment,
    viewingKeyFromSecret, viewingKeyFromSignature, wrapKey, unwrapKey,
    recoverAddress, viewingKeyV2, viewingKeyV2FromSecret, pieceScope, isViewingKeyV2, wrapKeyV2, wrapKeyForSale, unwrapKeyV2, proveFakeKey, keyring, openKey,
    secp256k1: { P, N, G, mul, liftX, onCurve },
  };
});
