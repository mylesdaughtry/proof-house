// Proof House: what a wallet holds that gives it a voice or a pass: identity.md seats and claimed Artifacts pieces.
// identity.md has 2,000 seats (ids 0 to 1999) and no list per holder, so this asks who holds each, in batches through
// Multicall3; pieces are at most 256 contracts (255 editions and THE SOURCE). Shared by the For agents page (claiming a
// pass) and the Review page (reviewing as a seat or a piece). A wallet with no seats skips the seat scan; batches go
// out a few at a time; results are kept per wallet for a minute (across pages, in this tab).
(function () {
  'use strict';
  const W = window.ProofHouseWallet;
  if (!W) return;
  const A = (((W.cfg.drops || {}).artifacts || {}).contracts) || {};
  const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
  const AGG3 = W.keccakHex('aggregate3((address,bool,bytes)[])').slice(0, 10);
  const SEAT_COUNT = 2000;
  const pad32 = (n) => BigInt(n).toString(16).padStart(64, '0');
  const at = (h, byte) => Number(BigInt('0x' + (h.slice(byte * 2, byte * 2 + 64) || '0')));

  async function batch(part) {
      const out = [];
      const tuples = part.map(({ target, data }) => {
        const d = data.slice(2);
        const len = d.length / 2;
        return target.slice(2).toLowerCase().padStart(64, '0') + pad32(1) + pad32(0x60) + pad32(len) + d.padEnd(Math.ceil(len / 32) * 64, '0');
      });
      let off = part.length * 32;
      const offsets = tuples.map((t) => { const o = pad32(off); off += t.length / 2; return o; }).join('');
      const h = (await W.rpc('eth_call', [{ to: MULTICALL3, data: AGG3 + pad32(0x20) + pad32(part.length) + offsets + tuples.join('') }, 'latest'])).slice(2);
      const base = at(h, 0) + 32;
      for (let j = 0; j < at(h, at(h, 0)); j++) {
        const t = base + at(h, base + j * 32);
        const b = t + at(h, t + 32);
        out.push({ ok: at(h, t) !== 0, data: '0x' + h.slice((b + 32) * 2, (b + 32 + at(h, b)) * 2) });
      }
      return out;
  }
  // in batches of 150 calls, up to 4 at once (public RPCs throttle more)
  async function multicall(calls) {
    const parts = [];
    for (let i = 0; i < calls.length; i += 150) parts.push(calls.slice(i, i + 150));
    const results = new Array(parts.length);
    let next = 0;
    const worker = async () => { while (next < parts.length) { const k = next++; results[k] = await batch(parts[k]); } };
    await Promise.all(Array.from({ length: Math.min(4, parts.length) }, worker));
    return results.flat();
  }
  const addrOf = (r) => (r.ok && r.data.length >= 66 ? ('0x' + r.data.slice(26, 66)).toLowerCase() : null);
  const live = (a) => W.ADDR.test(a || '') && !/^0x0{40}$/.test(a);

  const cache = new Map(); // wallet → promise of the list, so two callers share one scan
  const TTL = 60000;
  const storeKey = (mine) => `ph-holdings:${W.cfg.chainId || ''}:${mine}`;
  function stored(mine) {
    try {
      const v = JSON.parse(sessionStorage.getItem(storeKey(mine)) || 'null');
      return v && Date.now() - v.at < TTL && Array.isArray(v.found) ? v.found : null;
    } catch (_) { return null; }
  }
  // → [{ kind: 'seat' | 'piece', id, label }], seats first. Pieces count once claimed (their own contract exists).
  function scan(wallet) {
    const mine = (wallet || '').toLowerCase();
    if (!mine) return Promise.resolve([]);
    if (!cache.has(mine)) {
      const kept = stored(mine);
      const run = kept ? Promise.resolve(kept) : look(mine).then((found) => {
        try { sessionStorage.setItem(storeKey(mine), JSON.stringify({ at: Date.now(), found })); } catch (_) { /* private mode */ }
        return found;
      });
      run.catch(() => cache.delete(mine)); // a failed read is tried again next time
      cache.set(mine, run);
    }
    return cache.get(mine);
  }
  async function seatCount(mine) {
    try { const [n] = await W.read(A.seats, 'balanceOf(address)(uint256)', [mine]); return n; } catch (_) { return null; }
  }
  async function look(mine) {
    const found = [];
    const seatsHeld = live(A.seats) ? seatCount(mine) : Promise.resolve(0n);
    const piecesFound = lookPieces(mine);
    const held = await seatsHeld;
    if (live(A.seats) && held !== 0n) {
      const res = await multicall(Array.from({ length: SEAT_COUNT }, (_, i) => ({ target: A.seats, data: W.encodeCall('ownerOf(uint256)', [i]) })));
      res.forEach((r, i) => { if (addrOf(r) === mine) found.push({ kind: 'seat', id: i, label: `Seat #${i}` }); });
    }
    return found.concat(await piecesFound);
  }
  async function lookPieces(mine) {
    const found = [];
    if (live(A.factory) && live(A.source)) {
      const ids = Array.from({ length: 255 }, (_, i) => i + 1);
      const pc = await multicall([...ids.map((id) => ({ target: A.factory, data: W.encodeCall('pieceContract(uint256)', [id]) })), { target: A.source, data: W.encodeCall('pieceContract()', []) }]);
      const pieces = pc.map((r, i) => ({ id: i < 255 ? ids[i] : 256, addr: addrOf(r) })).filter((p) => live(p.addr));
      const owners = pieces.length ? await multicall(pieces.map((p) => ({ target: p.addr, data: W.encodeCall('ownerOf(uint256)', [1]) }))) : [];
      pieces.forEach((p, i) => { if (addrOf(owners[i]) === mine) found.push({ kind: 'piece', id: p.id, label: p.id === 256 ? 'THE SOURCE' : `ARTIFACTS #${String(p.id).padStart(3, '0')}` }); });
    }
    return found;
  }
  function forget(wallet) {
    const mine = (wallet || '').toLowerCase();
    cache.delete(mine);
    try { sessionStorage.removeItem(storeKey(mine)); } catch (_) { /* private mode */ }
  }

  window.PHHoldings = Object.freeze({ scan, multicall, forget });
})();
