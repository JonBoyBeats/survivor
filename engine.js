/* engine.js - the book's dollar arithmetic.
 *
 * A contest export carries, for every candidate path, the week it first loses
 * in every simulated world (one byte per world; `end` where it survives every
 * week), and the field's alive count into every week of every world, our own
 * entries already taken out.
 *
 * THE BOOK IS PRICED AT A HORIZON, NOT AT THE END. Six weeks out (the stand
 * plus six, the stretch where an entry's options still agree), an entry
 * alive in a world takes an equal cut of the pot with everyone else alive
 * there. Pricing the last survivor instead rests on the few worlds where an
 * entry outlasts the whole field, a dozen of ten thousand, and is mostly
 * noise; the horizon reads every world the entry reaches.
 *
 * THE CUT IS WEIGHTED BY WHAT THE PATH HAS LEFT. A path's own survival over
 * the four weeks after the horizon, pooled over the worlds it reaches it in,
 * set against the field's over the same weeks, is its strength k: an entry
 * with better teams left counts as k entries at the horizon.
 *
 * AN OPTION IS A TEAM, NOT A PATH. This week's pick is the decision; the
 * future behind it is re-solved every week. So an option is an even mix of
 * every path the value map planned behind that pick, and an entry banked on
 * it follows a typical one. A single path can still be banked on its own,
 * which the page offers where one stands clearly apart from its team.
 *
 * Runs in the browser and in Node, no dependencies.
 */
(function (root) {
  'use strict';

  const NEAR = 6;    // the horizon: the stand week plus this
  const AHEAD = 4;   // the weeks after it that measure what a path has left

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
    this.loses = {};
    for (const t of Object.keys(doc.loses || {})) this.loses[t] = b64bytes(doc.loses[t]);
    // the horizon and the field there
    this.H = Math.min(doc.week + NEAR, doc.end);
    this.H2 = Math.min(this.H + AHEAD, doc.end);
    const iH = this.weeks.indexOf(this.H), i2 = this.weeks.indexOf(this.H2);
    this.fieldH = this.others.subarray(iH * this.N, (iH + 1) * this.N);
    let f1 = 0, f2 = 0;
    for (let n = 0; n < this.N; n++) { f1 += this.others[iH * this.N + n]; f2 += this.others[i2 * this.N + n]; }
    this.fieldAhead = f1 > 0 ? f2 / f1 : 0;
    // per path: how often it reaches the horizon, and its strength
    // THE SEASON READING (D324): the same horizon cut, with the strength
    // read over every week from the horizon to the end instead of four, so
    // what a path has left for the last weeks counts without resting on
    // the dozen seasons the raw last-survivor reading stands on
    const iE = this.weeks.indexOf(doc.end);
    let fE = 0;
    for (let n = 0; n < this.N; n++) fE += this.others[iE * this.N + n];
    this.fieldEnd = f1 > 0 ? fE / f1 : 0;
    this.reach = []; this.k = []; this.kE = [];
    doc.cands.forEach((c, ci) => {
      const d = this.death[ci];
      let a = 0, b = 0, e = 0;
      for (let n = 0; n < this.N; n++) {
        if (d[n] >= this.H) a++;
        if (d[n] >= this.H2) b++;
        if (d[n] >= doc.end) e++;
      }
      this.reach[ci] = a / this.N;
      this.k[ci] = this.H2 > this.H && a && this.fieldAhead > 0 ? (b / a) / this.fieldAhead : 1;
      this.kE[ci] = doc.end > this.H && a && this.fieldEnd > 0 ? (e / a) / this.fieldEnd : 1;
    });
    // the options: per group, one per pick, each the even mix of its paths
    this.options = doc.groups.map(g => {
      const by = {};
      g.cands.forEach(ci => (by[doc.cands[ci].pick] = by[doc.cands[ci].pick] || []).push(ci));
      return Object.keys(by).map(pick => ({ key: 't:' + pick, pick: pick, cands: by[pick] }));
    });
    this.alone = {};
  }

  /* what one bank target puts at the horizon in every world: the mix's
   * weighted share of an entry alive there */
  Book.prototype.contrib = function (cands, season) {
    const N = this.N, x = new Float64Array(N), w = 1 / cands.length;
    for (const ci of cands) {
      const d = this.death[ci], k = (season ? this.kE[ci] : this.k[ci]) * w, H = this.H;
      for (let n = 0; n < N; n++) if (d[n] >= H) x[n] += k;
    }
    return x;
  };

  /* the same target on the last-survivor reading: the mix's share of an
   * entry alive into every week of every world */
  Book.prototype.contribEnd = function (cands) {
    const N = this.N, W = this.W, x = new Float32Array(W * N), w = 1 / cands.length;
    for (const ci of cands) {
      const d = this.death[ci];
      for (let i = 0; i < W; i++) {
        const wk = this.weeks[i], row = i * N;
        for (let n = 0; n < N; n++) if (d[n] >= wk) x[row + n] += w;
      }
    }
    return x;
  };

  /* our share in every world on the last survivor: the pot to the entries
   * alive into the last week anyone is */
  Book.prototype.shareEnd = function (ours) {
    const N = this.N, W = this.W, o = this.others, out = new Float64Array(N);
    for (let n = 0; n < N; n++) {
      for (let i = W - 1; i >= 0; i--) {
        const k = i * N + n, tot = o[k] + ours[k];
        if (tot >= 1) { out[n] = ours[k] / tot; break; }
      }
    }
    return out;
  };

  Book.prototype.marginalEnd = function (ours, base, x) {
    const N = this.N, W = this.W, o = this.others;
    let sum = 0;
    for (let n = 0; n < N; n++) {
      let s = 0;
      for (let i = W - 1; i >= 0; i--) {
        const k = i * N + n, mine = ours[k] + x[k], tot = o[k] + mine;
        if (tot >= 1) { s = mine / tot; break; }
      }
      sum += s - base[n];
    }
    return this.pot * sum / N;
  };

  Book.prototype.empty = function () { return new Float64Array(this.N); };

  Book.prototype.add = function (ours, x, sign) {
    for (let n = 0; n < this.N; n++) ours[n] += sign * x[n];
  };

  /* our share of the pot in every world: an equal cut at the horizon */
  Book.prototype.share = function (ours, out) {
    const N = this.N, f = this.fieldH;
    out = out || new Float64Array(N);
    for (let n = 0; n < N; n++) out[n] = ours[n] > 0 ? ours[n] / Math.max(1, f[n] + ours[n]) : 0;
    return out;
  };

  /* what adding `x` to the book is worth: mean and standard error of the
   * per-world difference */
  Book.prototype.marginal = function (ours, base, x, keep) {
    const N = this.N, f = this.fieldH;
    const arr = keep ? new Float64Array(N) : null;
    let sum = 0, sq = 0;
    for (let n = 0; n < N; n++) {
      const o = ours[n] + x[n];
      const s = o > 0 ? o / Math.max(1, f[n] + o) : 0;
      const diff = this.pot * (s - base[n]);
      if (arr) arr[n] = diff;
      sum += diff; sq += diff * diff;
    }
    const m = sum / N;
    const sd = Math.sqrt(Math.max(0, sq / N - m * m));
    return { mean: m, se: sd / Math.sqrt(N), arr: arr };
  };

  /* the standard error of the DIFFERENCE between two options scored on the
   * same worlds: far smaller than either option's own */
  function pairedSE(a, b) {
    const N = a.length;
    let s = 0, q = 0;
    for (let n = 0; n < N; n++) { const x = a[n] - b[n]; s += x; q += x * x; }
    const m = s / N;
    return Math.sqrt(Math.max(0, q / N - m * m)) / Math.sqrt(N);
  }

  /* a target alone, cached by its paths (a team's key is shared by every
   * burned set, its paths are not): its worth before any other entry */
  Book.prototype.aloneOf = function (key, cands) {
    const id = cands.join(',');
    if (this.alone[id] === undefined) {
      const z = this.empty();
      this.alone[id] = this.marginal(z, z, this.contrib(cands)).mean;
    }
    return this.alone[id];
  };

  /* the old reading, kept beside the new: one path alone priced on the last
   * survivor (the pot to the entries alive into the last week anyone is) */
  Book.prototype.endAlone = function (ci) {
    this.endCache = this.endCache || {};
    if (this.endCache[ci] !== undefined) return this.endCache[ci];
    const N = this.N, W = this.W, o = this.others, d = this.death[ci];
    let sum = 0;
    for (let n = 0; n < N; n++) {
      for (let i = W - 1; i >= 0; i--) {
        const mine = d[n] >= this.weeks[i] ? 1 : 0, tot = o[i * N + n] + mine;
        if (tot >= 1) { sum += mine / tot; break; }
      }
    }
    return (this.endCache[ci] = this.pot * sum / N);
  };

  /* the chance a target reaches the horizon, and survives the whole season */
  Book.prototype.reachOf = function (cands) {
    return cands.reduce((s, c) => s + this.reach[c], 0) / cands.length;
  };
  Book.prototype.survivesOf = function (cands) {
    const end = this.doc.end;
    let k = 0;
    for (const c of cands) { const d = this.death[c]; for (let n = 0; n < this.N; n++) if (d[n] >= end) k++; }
    return k / (this.N * cands.length);
  };
  Book.prototype.strengthOf = function (cands) {
    return cands.reduce((s, c) => s + this.k[c], 0) / cands.length;
  };

  /* a bank target, by key: 't:PICK' is the team's mix, 'p:ID' one path */
  Book.prototype.target = function (gi, key) {
    if (key.startsWith('t:')) {
      const o = this.options[gi].find(x => x.key === key);
      return o ? { key: key, pick: o.pick, cands: o.cands } : null;
    }
    const ci = +key.slice(2);
    if (!this.doc.groups[gi].cands.includes(ci)) return null;
    return { key: key, pick: this.doc.cands[ci].pick, cands: [ci] };
  };

  function addEnd(ours, x, sign) {
    for (let i = 0; i < ours.length; i++) ours[i] += sign * x[i];
  }

  function mean(a) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i];
    return a.length ? s / a.length : 0;
  }

  /* the portfolio state for one contest */
  function State(book) {
    this.book = book;
    this.picks = {};          // entry id -> bank target {key, pick, cands}
    this.x = {};              // entry id -> its horizon contribution
    this.order = [];          // entry ids in the order banked
    this.ours = book.empty();
    this.base = book.share(this.ours);
    // the season reading's own book (D324): the same banks, each weighted by
    // what its paths have left to the end
    this.xs = {};
    this.oursS = book.empty();
    this.baseS = book.share(this.oursS);
    // the end-of-season reading kept alongside, for the week 18 column
    this.xe = {};
    this.oursEnd = new Float32Array(book.W * book.N);
    this.baseEnd = book.shareEnd(this.oursEnd);
  }

  State.prototype.bank = function (entryId, key) {
    const t = this.book.target(this.book.groupOf[entryId], key);
    if (!t) return false;
    if (this.picks[entryId] !== undefined) this.unbank(entryId);
    this.picks[entryId] = t;
    this.x[entryId] = this.book.contrib(t.cands);
    this.xs[entryId] = this.book.contrib(t.cands, true);
    this.xe[entryId] = this.book.contribEnd(t.cands);
    this.order.push(entryId);
    this.book.add(this.ours, this.x[entryId], +1);
    this.base = this.book.share(this.ours);
    this.book.add(this.oursS, this.xs[entryId], +1);
    this.baseS = this.book.share(this.oursS);
    addEnd(this.oursEnd, this.xe[entryId], +1);
    this.baseEnd = this.book.shareEnd(this.oursEnd);
    return true;
  };

  State.prototype.unbank = function (entryId) {
    if (this.picks[entryId] === undefined) return;
    this.book.add(this.ours, this.x[entryId], -1);
    this.book.add(this.oursS, this.xs[entryId], -1);
    addEnd(this.oursEnd, this.xe[entryId], -1);
    delete this.picks[entryId]; delete this.x[entryId]; delete this.xe[entryId]; delete this.xs[entryId];
    this.order = this.order.filter(x => x !== entryId);
    this.base = this.book.share(this.ours);
    this.baseS = this.book.share(this.oursS);
    this.baseEnd = this.book.shareEnd(this.oursEnd);
  };

  /* one entry's options, the team mixes, priced against the book as it
   * stands (the entry's own pick taken out first); with `paired`, each
   * team's paths too, and every gap's paired standard error */
  State.prototype.options = function (entryId, paired) {
    const bk = this.book, gi = bk.groupOf[entryId];
    let ours = this.ours, base = this.base, oursE = this.oursEnd, baseE = this.baseEnd;
    let oursS = this.oursS, baseS = this.baseS;
    const mine = this.picks[entryId];
    if (mine !== undefined) {
      ours = ours.slice(); bk.add(ours, this.x[entryId], -1); base = bk.share(ours);
      oursS = oursS.slice(); bk.add(oursS, this.xs[entryId], -1); baseS = bk.share(oursS);
      if (paired) { oursE = oursE.slice(); addEnd(oursE, this.xe[entryId], -1); baseE = bk.shareEnd(oursE); }
    }
    const price = (key, cands) => {
      const m = bk.marginal(ours, base, bk.contrib(cands), paired);
      const ms = bk.marginal(oursS, baseS, bk.contrib(cands, true), false);
      return { key: key, cands: cands, mean: m.mean, se: m.se, arr: m.arr,
        season: ms.mean, seasonSe: ms.se,
        // the week 18 reading only where the page shows it, each path priced
        // whole and averaged: near the end the field is a handful and a
        // fraction of an entry would read as nobody
        end: paired ? cands.reduce((s, c) => s + bk.marginalEnd(oursE, baseE, bk.contribEnd([c])), 0) / cands.length : null,
        alone: bk.aloneOf(key, cands), reach: bk.reachOf(cands), strength: bk.strengthOf(cands) };
    };
    const out = bk.options[gi].map(o => Object.assign(price(o.key, o.cands), { pick: o.pick }))
      .sort((a, b) => b.mean - a.mean);
    if (paired && out.length) {
      const cur = mine ? out.find(o => o.key === mine.key) : null;
      let top = null;  // the best team's best path, the bar another team's path clears
      for (const o of out) {
        o.seBest = pairedSE(out[0].arr, o.arr);
        o.seCur = cur ? pairedSE(o.arr, cur.arr) : null;
        // the team's paths, each against the team's own mix; one of another
        // team STANDS APART where it beats the best team's own best path,
        // best against best so the luck of topping several cancels, by more
        // than three standard errors, since many paths are tried: a season
        // plan worth banking on its own
        o.paths = o.cands.map(c => price('p:' + c, [c])).sort((a, b) => b.mean - a.mean);
        if (o === out[0]) top = o.paths[0];
        for (const p of o.paths) {
          p.gap = p.mean - o.mean;
          p.seGap = pairedSE(p.arr, o.arr);
          p.apart = !!top && o !== out[0] && o.cands.length > 1 && p.mean - top.mean > 3 * pairedSE(p.arr, top.arr);
          if (p !== top) p.arr = null;
        }
      }
      if (top) top.arr = null;
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

  /* single swaps between team mixes that would improve the book by more
   * than `z` standard errors */
  State.prototype.check = function (z) {
    z = z === undefined ? 2 : z;
    const out = [];
    for (const id of Object.keys(this.picks)) {
      const cur = this.picks[id];
      const opts = this.options(id, true);
      const now = opts.find(o => o.key === cur.key);
      const best = opts[0];
      if (best && now && best.key !== cur.key) {
        const gain = best.mean - now.mean;
        if (gain > z * best.seCur) out.push({ entry: id, from: cur.key, to: best.key, gain: gain, se: best.seCur });
      }
    }
    return out.sort((a, b) => b.gain - a.gain);
  };

  /* the book's numbers: dollars, our entries expected alive at the
   * horizon, and the stand week's exposure */
  State.prototype.summary = function () {
    const bk = this.book, N = bk.N;
    const exp = {};
    let alive = 0;
    for (const id of Object.keys(this.picks)) {
      const t = this.picks[id];
      exp[t.pick] = (exp[t.pick] || 0) + 1;
      alive += bk.reachOf(t.cands);
    }
    // if a team we hold this week loses: the entries it takes and the book
    // read over only the worlds where it lost
    const ifLoses = {};
    for (const t of Object.keys(exp).join('+').split('+')) {
      if (!t || ifLoses[t] || !bk.loses[t]) continue;
      let k = 0, s = 0;
      for (let n = 0; n < N; n++) if (bk.lost(t, n)) { k++; s += this.base[n]; }
      let entries = 0;
      for (const id of Object.keys(this.picks)) if (this.picks[id].pick.split('+').includes(t)) entries++;
      ifLoses[t] = { entries: entries, chance: k / N, dollars: k ? bk.pot * s / k : 0 };
    }
    return {
      dollars: bk.pot * mean(this.base),
      seasonDollars: bk.pot * mean(this.baseS),
      endDollars: bk.pot * mean(this.baseEnd),
      ifLoses: ifLoses,
      alive: alive,
      horizon: bk.H,
      banked: Object.keys(this.picks).length,
      total: bk.entries.length,
      exposure: exp,
    };
  };

  /* ---- THE PORTFOLIO (D328): what one contest's book is in every world,
   * so books whose worlds are the same NFL seasons (D327: the same
   * game_seed and world count) can be added up world by world ---- */

  /* the book's horizon dollars in every world */
  State.prototype.equity = function () {
    const N = this.book.N, out = new Float64Array(N);
    for (let n = 0; n < N; n++) out[n] = this.book.pot * this.base[n];
    return out;
  };

  /* per world, the chance every banked entry is already out going into
   * `week`: each entry's paths weighed evenly, the entries multiplied */
  State.prototype.deadBy = function (week) {
    const bk = this.book, N = bk.N, out = new Float64Array(N).fill(1);
    for (const id of Object.keys(this.picks)) {
      const cands = this.picks[id].cands, w = 1 / cands.length;
      const pd = new Float64Array(N);
      for (const ci of cands) { const d = bk.death[ci]; for (let n = 0; n < N; n++) if (d[n] < week) pd[n] += w; }
      for (let n = 0; n < N; n++) out[n] *= pd[n];
    }
    return out;
  };

  /* the book's horizon dollars per world with the entries banked on `team`
   * this week taken out: what that team carries */
  State.prototype.equityWithout = function (team) {
    const bk = this.book, ours = this.ours.slice();
    for (const id of Object.keys(this.picks)) {
      if (this.picks[id].pick.split('+').includes(team)) bk.add(ours, this.x[id], -1);
    }
    const sh = bk.share(ours), N = bk.N, out = new Float64Array(N);
    for (let n = 0; n < N; n++) out[n] = bk.pot * sh[n];
    return out;
  };

  /* the book's horizon dollars per world with one entry moved to `key` */
  State.prototype.equityIf = function (entryId, key) {
    const bk = this.book, t = bk.target(bk.groupOf[entryId], key);
    const ours = this.ours.slice();
    if (this.picks[entryId] !== undefined) bk.add(ours, this.x[entryId], -1);
    if (t) bk.add(ours, bk.contrib(t.cands), +1);
    const sh = bk.share(ours), N = bk.N, out = new Float64Array(N);
    for (let n = 0; n < N; n++) out[n] = bk.pot * sh[n];
    return out;
  };

  /* the mean of the worst `q` share of a per-world total */
  function tail(arr, q) {
    const v = Array.from(arr).sort((a, b) => a - b);
    const k = Math.max(1, Math.floor(q * v.length));
    let s = 0; for (let i = 0; i < k; i++) s += v[i];
    return s / k;
  }
  function quantile(arr, q) {
    const v = Array.from(arr).sort((a, b) => a - b);
    return v[Math.min(v.length - 1, Math.max(0, Math.floor(q * (v.length - 1))))];
  }

  /* does `team` lose this week in world n (one bit a world, high bit first) */
  Book.prototype.lost = function (team, n) {
    return (this.loses[team][n >> 3] >> (7 - (n & 7))) & 1;
  };

  const api = { Book: Book, State: State, b64bytes: b64bytes, NEAR: NEAR, AHEAD: AHEAD,
    tail: tail, quantile: quantile };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SurvivorEngine = api;
})(this);
