/* engine.js - the book's dollar arithmetic, the same as tools/book_prep.py.
 *
 * A contest export carries, for every candidate path, the week it first loses
 * in every simulated world (one byte per world; `end` where it survives every
 * week), and the field's alive count into every week of every world, our own
 * entries already taken out. The pot goes to the entries standing after the
 * last week, split evenly; where the whole field is gone before the end, the
 * entries alive into the week it ran out split it. Our share of a world's pot
 * is our entries in that group over everyone in it.
 *
 * Runs in the browser and in Node (the parity test), no dependencies.
 */
(function (root) {
  'use strict';

  function b64bytes(s) {
    if (typeof atob === 'function') {
      const bin = atob(s);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(s, 'base64'));
  }

  function Book(doc) {
    this.doc = doc;
    this.N = doc.worlds;
    this.weeks = doc.weeks;
    this.W = doc.weeks.length;
    this.pot = doc.pot;
    const ob = b64bytes(doc.others);
    this.others = new Float32Array(ob.buffer, ob.byteOffset, this.W * this.N);
    this.half = b64bytes(doc.half);
    this.death = doc.cands.map(c => b64bytes(c.death));
    this.groupOf = {};
    this.entries = [];
    doc.groups.forEach((g, gi) => g.entries.forEach(e => {
      this.groupOf[e.id] = gi;
      this.entries.push(Object.assign({ group: gi, burned: g.burned }, e));
    }));
    this.alone = null;
    this.loses = {};
    for (const t of Object.keys(doc.loses || {})) this.loses[t] = b64bytes(doc.loses[t]);
  }

  /* does `team` lose this week in world n (one bit a world, high bit first) */
  Book.prototype.lost = function (team, n) {
    return (this.loses[team][n >> 3] >> (7 - (n & 7))) & 1;
  };

  /* our entries alive into each week of each world: Float32Array W*N */
  Book.prototype.empty = function () { return new Float32Array(this.W * this.N); };

  Book.prototype.add = function (ours, cand, sign) {
    const d = this.death[cand], N = this.N;
    for (let i = 0; i < this.W; i++) {
      const w = this.weeks[i], row = i * N;
      for (let n = 0; n < N; n++) if (d[n] >= w) ours[row + n] += sign;
    }
  };

  /* our share of the pot in every world */
  Book.prototype.share = function (ours, out) {
    const N = this.N, W = this.W, o = this.others;
    out = out || new Float64Array(N);
    for (let n = 0; n < N; n++) {
      let s = 0;
      for (let i = W - 1; i >= 0; i--) {
        const k = i * N + n, tot = o[k] + ours[k];
        if (tot >= 1) { s = ours[k] / tot; break; }
      }
      out[n] = s;
    }
    return out;
  };

  /* the book's dollars: mean over the worlds (or one half, 0 or 1) */
  Book.prototype.dollars = function (ours, half) {
    const sh = this.share(ours);
    return this.pot * mean(sh, half === undefined ? null : this.half, half);
  };

  /* what adding `cand` to the book is worth: mean and standard error of
   * the per-world difference, without copying the book */
  Book.prototype.marginal = function (ours, base, cand, keep) {
    const N = this.N, W = this.W, o = this.others, d = this.death[cand];
    const arr = keep ? new Float64Array(N) : null;
    let sum = 0, sq = 0;
    for (let n = 0; n < N; n++) {
      let s = 0;
      const dn = d[n];
      for (let i = W - 1; i >= 0; i--) {
        const k = i * N + n;
        const mine = dn >= this.weeks[i] ? 1 : 0;
        const tot = o[k] + ours[k] + mine;
        if (tot >= 1) { s = (ours[k] + mine) / tot; break; }
      }
      const diff = this.pot * (s - base[n]);
      if (arr) arr[n] = diff;
      sum += diff; sq += diff * diff;
    }
    const m = sum / N;
    const sd = Math.sqrt(Math.max(0, sq / N - m * m));
    return { mean: m, se: sd / Math.sqrt(N), arr: arr };
  };

  /* the standard error of the DIFFERENCE between two options scored on the
   * same worlds: far smaller than either option's own, because the worlds
   * that flatter one flatter the other */
  function pairedSE(a, b) {
    const N = a.length;
    let s = 0, q = 0;
    for (let n = 0; n < N; n++) { const x = a[n] - b[n]; s += x; q += x * x; }
    const m = s / N;
    return Math.sqrt(Math.max(0, q / N - m * m)) / Math.sqrt(N);
  }

  /* the chance one path is still standing after the last week */
  Book.prototype.survives = function (cand) {
    const d = this.death[cand], end = this.doc.end;
    let k = 0;
    for (let n = 0; n < this.N; n++) if (d[n] >= end) k++;
    return k / this.N;
  };

  /* each candidate alone, cached: an entry's worth before any pick */
  Book.prototype.aloneValues = function () {
    if (this.alone) return this.alone;
    const z = this.empty(), base = new Float64Array(this.N);
    this.alone = this.doc.cands.map(c => this.marginal(z, base, c.id).mean);
    return this.alone;
  };

  function mean(a, mask, which) {
    let s = 0, n = 0;
    for (let i = 0; i < a.length; i++) {
      if (mask && mask[i] !== which) continue;
      s += a[i]; n++;
    }
    return n ? s / n : 0;
  }

  /* the portfolio state for one contest: picks, the book's arrays, history */
  function State(book) {
    this.book = book;
    this.picks = {};          // entry id -> candidate id
    this.order = [];          // entry ids in the order banked
    this.ours = book.empty();
    this.base = book.share(this.ours);
  }

  State.prototype.bank = function (entryId, cand) {
    if (this.picks[entryId] !== undefined) this.unbank(entryId);
    this.picks[entryId] = cand;
    this.order.push(entryId);
    this.book.add(this.ours, cand, +1);
    this.base = this.book.share(this.ours);
  };

  State.prototype.unbank = function (entryId) {
    const c = this.picks[entryId];
    if (c === undefined) return;
    delete this.picks[entryId];
    this.order = this.order.filter(x => x !== entryId);
    this.book.add(this.ours, c, -1);
    this.base = this.book.share(this.ours);
  };

  /* every candidate of one entry, priced against the book as it stands
   * (the entry's own pick, if banked, taken out first) */
  State.prototype.options = function (entryId, paired) {
    const bk = this.book, gi = bk.groupOf[entryId];
    let ours = this.ours, base = this.base;
    const mine = this.picks[entryId];
    if (mine !== undefined) {
      ours = ours.slice(); bk.add(ours, mine, -1); base = bk.share(ours);
    }
    const alone = bk.aloneValues();
    const out = bk.doc.groups[gi].cands.map(c => {
      const m = bk.marginal(ours, base, c, paired);
      return { cand: c, mean: m.mean, se: m.se, alone: alone[c], arr: m.arr };
    }).sort((a, b) => b.mean - a.mean);
    if (paired && out.length) {
      // each option against the best and against the entry's current pick
      const cur = out.find(o => o.cand === mine);
      for (const o of out) {
        o.seBest = pairedSE(out[0].arr, o.arr);
        o.seCur = cur ? pairedSE(o.arr, cur.arr) : null;
      }
      for (const o of out) o.arr = null;
    }
    return out;
  };

  /* the entries not yet banked, each at its best option: worth now */
  State.prototype.worthNow = function () {
    const bk = this.book, cache = {};
    return bk.entries.filter(e => this.picks[e.id] === undefined).map(e => {
      if (!cache[e.group]) cache[e.group] = this.options(e.id);
      const best = cache[e.group][0];
      return { entry: e, best: best, options: cache[e.group] };
    }).sort((a, b) => (b.best ? b.best.mean : -1e9) - (a.best ? a.best.mean : -1e9));
  };

  /* bank the rest greedily, most valuable first, re-pricing after each */
  State.prototype.autofill = function () {
    for (;;) {
      const rows = this.worthNow();
      if (!rows.length || !rows[0].best) break;
      this.bank(rows[0].entry.id, rows[0].best.cand);
    }
  };

  /* single swaps that would improve the book by more than `z` standard
   * errors: the polishing pass, offered and never applied unasked */
  State.prototype.check = function (z) {
    z = z === undefined ? 2 : z;
    const out = [];
    for (const id of Object.keys(this.picks)) {
      const cur = this.picks[id];
      const opts = this.options(id, true);
      const now = opts.find(o => o.cand === cur);
      const best = opts[0];
      if (best && now && best.cand !== cur) {
        const gain = best.mean - now.mean;
        const se = best.seCur;
        if (gain > z * se) out.push({ entry: id, from: cur, to: best.cand, gain: gain, se: se });
      }
    }
    return out.sort((a, b) => b.gain - a.gain);
  };

  /* the book's numbers: dollars, the chance any of ours is standing at the
   * end, and the stand week's exposure */
  State.prototype.summary = function () {
    const bk = this.book, N = bk.N, last = (bk.W - 1) * N;
    let any = 0;
    for (let n = 0; n < N; n++) if (this.ours[last + n] > 0) any++;
    const exp = {};
    for (const id of Object.keys(this.picks)) {
      const p = bk.doc.cands[this.picks[id]].pick;
      exp[p] = (exp[p] || 0) + 1;
    }
    // if a team we hold this week loses: the entries it takes and the book
    // read over only the worlds where it lost
    const ifLoses = {};
    for (const t of Object.keys(exp).join('+').split('+')) {
      if (!t || ifLoses[t] || !bk.loses[t]) continue;
      let k = 0, s = 0;
      for (let n = 0; n < N; n++) if (bk.lost(t, n)) { k++; s += this.base[n]; }
      let entries = 0;
      for (const id of Object.keys(this.picks)) {
        if (bk.doc.cands[this.picks[id]].pick.split('+').includes(t)) entries++;
      }
      ifLoses[t] = { entries: entries, chance: k / N, dollars: k ? bk.pot * s / k : 0 };
    }
    return {
      dollars: bk.pot * mean(this.base, null),
      ifLoses: ifLoses,
      any: any / N,
      banked: Object.keys(this.picks).length,
      total: bk.entries.length,
      exposure: exp,
    };
  };

  const api = { Book: Book, State: State, b64bytes: b64bytes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SurvivorEngine = api;
})(this);
