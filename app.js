/* app.js - the pick loop. One portfolio per contest: pick the most valuable
 * entry, see its options priced against the book as it stands, bank one, and
 * every other entry re-prices. Picks live in this browser (localStorage),
 * follow you to every device holding a gist token (the Sync button, D337), and
 * leave it as a cheat sheet or an exported file. */
(function () {
  'use strict';
  const E = window.SurvivorEngine;
  const $ = (s, el) => (el || document).querySelector(s);
  const app = { index: [], week: null, docs: {}, cur: null, sel: {} };

  const money = v => (Math.abs(v) >= 1000 ? '$' + Math.round(v).toLocaleString()
    : '$' + v.toFixed(2));
  const pct = v => (100 * v).toFixed(1) + '%';
  // the yardstick: every alive entry's equal cut of the pot, and a value as a multiple of it
  const fair = doc => doc.pot / doc.field;
  const times = (v, doc) => (v / fair(doc)).toFixed(1) + '×';
  // a standard error or a gap in dollars: whole dollars once they reach 100
  const gap = v => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const weekKey = r => r.season + '-' + r.week;
  const lsKey = (doc) => 'sb:' + doc.season + '-' + doc.week + '-' + doc.slug;

  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  // the chalk the operator types, one list per week, read by every contest
  const chalkKey = () => 'sb:chalk:' + app.week;
  function chalk() { return new Set(lsGet(chalkKey()) || []); }
  // a write that changes what a key holds is an edit the other devices should
  // see; the page re-saving the same picks on load (with a new `saved` stamp) is not
  function lsSet(k, v) {
    let changed;
    try {
      const nv = JSON.stringify(v);
      changed = stripSaved(localStorage.getItem(k)) !== stripSaved(nv);
      localStorage.setItem(k, nv);
    } catch (e) { return; /* private window */ }
    if (changed && k.startsWith('sb:')) markLocal(k);
  }
  function stripSaved(raw) {
    if (raw == null) return raw;
    try { const o = JSON.parse(raw); if (o && typeof o === 'object' && !Array.isArray(o)) delete o.saved; return JSON.stringify(o); }
    catch (e) { return raw; }
  }

  async function init() {
    let idx;
    try { idx = await (await fetch('data/index.json', { cache: 'no-cache' })).json(); }
    catch (e) { $('#main').innerHTML = '<p class="pad">No data yet: run <code>book_prep.py WEEK --all</code> and publish.</p>'; return; }
    app.index = idx.contests || [];
    const weeks = [...new Set(app.index.map(weekKey))];
    const sel = $('#week');
    sel.innerHTML = weeks.map(k => { const [s, w] = k.split('-'); return `<option value="${k}">${s} week ${w}</option>`; }).join('');
    const h = location.hash.slice(1).split('/');
    app.week = weeks.includes(h[0]) ? h[0] : weeks[0];
    sel.value = app.week;
    sel.onchange = () => { app.week = sel.value; go(null); };
    window.onhashchange = () => { const p = location.hash.slice(1).split('/'); if (p[1] && p[1] !== app.cur) show(p[1]); };
    go(h[1] || null);
    paintSync();
    autoSync();
  }

  function weekRows() { return app.index.filter(r => weekKey(r) === app.week); }

  function go(slug) {
    const rows = weekRows();
    show(slug && (slug === 'portfolio' || rows.some(r => r.slug === slug)) ? slug : (rows[0] ? rows[0].slug : 'portfolio'));
  }

  function tabs() {
    const rows = weekRows();
    const sel = $('#contest');
    sel.innerHTML = rows.map(r => {
      const st = lsGet('sb:' + r.season + '-' + r.week + '-' + r.slug);
      const n = st && st.summary ? st.summary.banked : 0;
      return `<option value="${r.slug}">${esc(r.name)} (${n}/${r.entries} banked)</option>`;
    }).join('') + '<option value="portfolio">Portfolio &amp; cheat sheet</option>';
    sel.value = app.cur;
    sel.onchange = () => show(sel.value);
  }

  async function show(slug) {
    app.cur = slug;
    location.hash = app.week + '/' + slug;
    tabs();
    if (slug === 'portfolio') return renderPortfolio();
    const row = weekRows().find(r => r.slug === slug);
    $('#main').innerHTML = '<p class="muted pad">Loading ' + esc(row.name) + '…</p>';
    const key = app.week + '/' + slug;
    if (!app.docs[key]) {
      const doc = await (await fetch('data/' + row.file, { cache: 'no-cache' })).json();
      const book = new E.Book(doc);
      const st = new E.State(book);
      app.docs[key] = { doc, book, st, history: [], stale: [] };
      restore(app.docs[key]);
    }
    renderContest(app.docs[key]);
  }

  /* ---- persistence: picks by team (or one path), re-matched if the data was rebuilt ---- */
  function restore(c) {
    const saved = lsGet(lsKey(c.doc));
    if (!saved || !saved.picks) return;
    for (const id of saved.order || Object.keys(saved.picks)) {
      const p = saved.picks[id];
      const gi = c.book.groupOf[id];
      if (!p || gi === undefined) { c.stale.push(p ? p.pick + ' (' + id + ')' : id); continue; }
      let key = 't:' + p.pick;   // a team, and every pick saved before teams existed
      if (p.key && p.key.startsWith('p:')) {
        // one path: matched by its plan, since a rebuild can move its id
        const ci = c.doc.groups[gi].cands.find(x => JSON.stringify(c.doc.cands[x].path) === JSON.stringify(p.path));
        key = ci === undefined ? null : 'p:' + ci;
      }
      if (!key || !c.st.bank(id, key)) { c.stale.push(p.pick + ' for ' + (p.name || id)); continue; }
      c.vals = c.vals || {}; c.vals[id] = p.value;
    }
    save(c);
  }

  function save(c) {
    app.port = null;          // the portfolio is read again after any bank
    const picks = {};
    for (const id of c.st.order) {
      const t = c.st.picks[id];
      const e = c.book.entries.find(x => x.id === id);
      picks[id] = { key: t.key, pick: t.pick, path: t.key.startsWith('p:') ? c.doc.cands[t.cands[0]].path : undefined,
        name: e ? e.name : id, value: (c.vals || {})[id] };
    }
    lsSet(lsKey(c.doc), { built: c.doc.built, name: c.doc.name, slug: c.doc.slug, pot: c.doc.pot,
      order: c.st.order, picks, summary: c.st.summary(), saved: new Date().toISOString() });
  }

  // a bank target's label: the team, or the team and "one path"
  const label = (doc, key) => key.startsWith('t:') ? key.slice(2) : doc.cands[+key.slice(2)].pick + ' (one path)';

  /* ---- the contest page ---- */
  function renderContest(c) {
    const { doc, book, st } = c;
    const root = $('#t-contest').content.cloneNode(true);
    $('.cname', root).textContent = doc.name;
    $('.meta', root).innerHTML = [
      'pot ' + money(doc.pot), doc.field.toLocaleString() + ' alive', doc.ours + ' of ours',
      doc.k === 2 ? 'doubles week' : 'single pick',
      'board ' + esc(doc.board.split('/').pop()) + (doc.scaled ? ' (family, scaled)' : ''),
      'built ' + esc((doc.built || '').replace('T', ' ').slice(0, 16)) + ' UTC'].join(' · ');
    const notes = (doc.notes || []).map(n => `<div class="note">${esc(n)}</div>`)
      .concat(c.stale.length ? [`<div class="note">Saved picks that no longer match this data and were dropped: ${esc(c.stale.join(', '))}. Re-bank them.</div>`] : []);
    $('.notes', root).innerHTML = notes.join('');
    $('#main').innerHTML = '';
    $('#main').appendChild(root);
    const sec = $('#main .contest');
    sec.querySelectorAll('[data-act]').forEach(b => b.onclick = () => act(c, b.dataset.act));
    const ci = $('.chalkin', sec);
    ci.value = [...chalk()].join(' ');
    ci.onchange = () => {
      const ts = [...new Set(ci.value.toUpperCase().split(/[^A-Z]+/).filter(Boolean))];
      lsSet(chalkKey(), ts);
      ci.value = ts.join(' ');
      paint(c);
    };
    paint(c);
  }

  function paint(c) {
    const { doc, book, st } = c;
    const sec = $('#main .contest');
    const sm = st.summary();
    const exp = Object.entries(sm.exposure).sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `<span class="chip">${esc(t)} ${n}</span>`).join('') || '<span class="muted small">nothing banked</span>';
    $('.cards', sec).innerHTML = `
      <div class="card"><div class="k">Book, expected at week ${sm.horizon}</div><div class="v">${money(sm.dollars)}</div><div class="k">${money(sm.endDollars)} on the week 18 reading</div></div>
      <div class="card"><div class="k">Fair share per entry</div><div class="v">${money(fair(doc))}</div><div class="k">pot ÷ ${doc.field.toLocaleString()} alive</div></div>
      <div class="card"><div class="k">Banked</div><div class="v">${sm.banked} / ${sm.total}</div></div>
      <div class="card"><div class="k">Ours alive into week ${sm.horizon}, expected</div><div class="v">${sm.alive.toFixed(2)}</div></div>
      <div class="card"><div class="k">This week's exposure</div><div class="chips">${exp}</div></div>`;
    const rows = st.worthNow();
    const todo = $('.todo', sec), done = $('.done', sec);
    todo.innerHTML = rows.length ? rows.map(r => `
      <li data-id="${esc(r.entry.id)}"><div><div class="n">${esc(r.entry.name)}</div>
      <div class="b">burned ${esc(r.entry.burned.join(' '))}${doc.groups[r.entry.group].alt_flip ? ' · <b>leans on the pins</b>' : ''}</div></div>
      <div class="r"><div>${r.best ? money(r.best.mean) + ' <span class="x">' + times(r.best.mean, doc) + '</span>' : '—'}</div>
      <div class="b">${r.best ? esc(r.best.pick) : 'no option'}</div></div></li>`).join('')
      : '<li class="empty">Every entry is banked.</li>';
    done.innerHTML = st.order.length ? st.order.map((id, i) => {
      const e = book.entries.find(x => x.id === id);
      const v = (c.vals || {})[id];
      return `<li data-id="${esc(id)}"><div><div class="n">${i + 1}. ${esc(e.name)}</div>
        <div class="b">burned ${esc(e.burned.join(' '))}</div></div>
        <div class="r"><div class="pick">${esc(label(doc, st.picks[id].key))}</div>
        <div class="b">${v !== undefined && v !== null ? money(v) + ' when banked' : ''}</div></div></li>`;
    }).join('') : '<li class="empty">Nothing banked yet.</li>';
    sec.querySelectorAll('.elist li[data-id]').forEach(li => li.onclick = () => { app.sel[doc.slug] = li.dataset.id; paint(c); });
    let sel = app.sel[doc.slug];
    if (!sel || !book.entries.some(e => e.id === sel)) sel = rows[0] ? rows[0].entry.id : (st.order[0] || null);
    app.sel[doc.slug] = sel;
    sec.querySelectorAll('.elist li[data-id]').forEach(li => li.classList.toggle('sel', li.dataset.id === sel));
    detail(c, sel);
    tabs();
  }

  // THE NEXT SIX WEEKS, the stretch where an entry's options mostly agree;
  // past it the plans scatter and the colouring would only say so
  const NEAR = E.NEAR;
  // per later week from the stand to `upto`: each team's share of the paths
  function shares(doc, cands, upto) {
    const out = {};
    cands.forEach(c => Object.entries(doc.cands[c].path).forEach(([w, ts]) => {
      if (+w <= doc.week || +w > upto) return;
      out[w] = out[w] || {};
      ts.forEach(t => out[w][t] = (out[w][t] || 0) + 1);
    }));
    Object.values(out).forEach(o => Object.keys(o).forEach(t => o[t] /= cands.length));
    return out;
  }
  // the teams at least half of the options play that week
  function consensus(sh) {
    const out = {};
    Object.keys(sh).forEach(w => out[w] = new Set(Object.keys(sh[w]).filter(t => sh[w][t] >= 0.5)));
    return out;
  }
  // a week by week line: the teams the paths play, the share where it is not all of them
  function commonLine(sh, ch, all) {
    return Object.keys(sh).map(Number).sort((a, b) => a - b).map(w => `<b>${w}</b> ` +
      Object.entries(sh[w]).sort((a, b) => b[1] - a[1]).filter(([, v], i) => i === 0 || v >= 0.25).slice(0, 3)
        .map(([t, v]) => `<span class="${all ? (v >= 0.5 ? 'agree' : 'differ') : ''}${ch.has(t) ? ' chalk' : ''}">${esc(t)}</span>${v > 0.995 ? '' : ' ' + Math.round(100 * v) + '%'}`).join(', ')).join(' · ');
  }

  function pathText(doc, cand, cons, ch) {
    const p = doc.cands[cand].path;
    return Object.keys(p).map(Number).filter(w => w > doc.week).sort((a, b) => a - b)
      .map(w => `<b>${w}</b> ` + p[w].map(t => `<span class="${!cons[w] ? '' : cons[w].has(t) ? 'agree' : 'differ'}${ch.has(t) ? ' chalk' : ''}">${esc(t)}</span>`).join('+')).join(' · ');
  }

  function detail(c, id) {
    const { doc, book, st } = c;
    const box = $('#main .detail');
    if (!id) { box.innerHTML = ''; return; }
    const e = book.entries.find(x => x.id === id);
    const opts = st.options(id, true);
    const best = opts[0];
    const cur = st.picks[id] ? st.picks[id].key : null;
    const hasAlt = doc.cands.some(x => x.alt !== undefined && x.alt !== null);
    // one entry in the contest: Alone is always Worth now, so it is not shown
    const one = book.entries.length === 1;
    const H = book.H, H2 = book.H2;
    const allCands = opts.flatMap(o => o.cands);
    const sh = shares(doc, allCands, doc.week + NEAR);
    const cons = consensus(sh);
    const ch = chalk();
    const off = [...ch].filter(t => doc.price[t] === undefined);
    $('#main .chalknote').textContent = !ch.size ? 'type the week\'s chalk teams to see where a path spends them'
      : 'highlighted in the paths' + (off.length ? '; not playing this week: ' + off.join(' ') : '');
    const flip = doc.groups[book.groupOf[id]].alt_flip;
    // THE PORTFOLIO TIE-BREAK (D328): among the options within one standard
    // error of the best, a statistical tie, the one that leaves the whole
    // portfolio's worst tenth of seasons highest. Read off the other books
    // season by season, so it needs them on the same seasons (D327).
    const port = app.port && app.port.week === app.week ? app.port : null;
    if (!port && !app.portLoading) {
      app.portLoading = true;
      portfolioContext().then(() => { app.portLoading = false; if (app.cur === doc.slug) paint(c); })
        .catch(() => { app.portLoading = false; });
    }
    const tb = {};
    if (port && port.aligned && port.eq[doc.slug] && best) {
      const N = port.N, own = port.eq[doc.slug], other = new Float64Array(N);
      for (let n = 0; n < N; n++) other[n] = port.total[n] - own[n];
      opts.filter(o => o === best || (best.mean - o.mean) < o.seBest).forEach(o => {
        const e = st.equityIf(id, o.key), tot = new Float64Array(N);
        for (let n = 0; n < N; n++) tot[n] = other[n] + e[n];
        tb[o.key] = E.tail(tot, 0.1);
      });
      const keys = Object.keys(tb);
      if (keys.length > 1) tb._best = keys.reduce((a, b) => tb[a] >= tb[b] ? a : b);
    }
    const bankBtn = (key, val, text) => key === cur ? '<button class="btn small ghost" data-unbank="1">Unbank</button>'
      : `<button class="btn small" data-bank="${key}" data-val="${val}">${text}</button>`;
    const rows = opts.map(o => {
      const tie = best && o !== best && (best.mean - o.mean) < 2 * o.seBest;
      const price = o.pick.split('+').map(t => doc.price[t] !== undefined ? (100 * doc.price[t]).toFixed(0) + '%' : '').join('<br>');
      const alts = o.cands.map(ci => doc.cands[ci].alt).filter(x => x !== null && x !== undefined);
      // the base-field check at the horizon (D318): the mix's worth alone
      // without the pins over its worth alone with them, the same reading
      const noPins = hasAlt && alts.length === o.cands.length && o.alone > 0
        ? ' · without the pins ×' + (alts.reduce((s, x) => s + x, 0) / alts.length / o.alone).toFixed(2) : '';
      const apart = o.paths.filter(p => p.apart).length;
      const paths = o.paths.map(p => `<div class="pth ${p.key === cur ? 'cur' : ''}">
          <div class="pv">${money(p.mean)} <span class="se">${(p.gap >= 0 ? '+' : '−') + gap(Math.abs(p.gap))} ±${gap(p.seGap)} vs the mix · to week 18 ${money(p.season)}</span>
          ${p.apart ? '<span class="tie">stands apart</span>' : ''} ${bankBtn(p.key, p.mean, 'Bank this path')}</div>
          <div class="path" title="spine ${esc(doc.cands[p.cands[0]].spine)}">${pathText(doc, p.cands[0], cons, ch)}</div></div>`).join('');
      // ONE TIGHT ROW AN OPTION, so the numbers read down their columns; the
      // plans behind it, the typical line and the extras sit in one fold
      const worst = tb[o.key] !== undefined && tb._best
        ? `<div class="muted small">portfolio's worst 10% of seasons: ${money(tb[o.key])}</div>` : '';
      return `<div class="orow opt ${o.key === cur || (cur && cur.startsWith('p:') && o.cands.includes(+cur.slice(2))) ? 'cur' : ''}">
        <div class="pk"><span class="pick">${esc(o.pick).replace(/\+/g, '+<wbr>')}</span>
          <div class="se">${price.replace('<br>', '+')}${o === best ? ' <span class="tie">best</span>' : tie ? ' <span class="tie">tie</span>' : ''}${tb._best === o.key ? ' <span class="tie">div</span>' : ''}</div>
          <div class="bk">${bankBtn(o.key, o.mean, 'Bank')}</div></div>
        <div class="num">${money(o.mean)}<div class="se">${o === best ? '±' + gap(o.se) : '−' + gap(best.mean - o.mean)}</div></div>
        <div class="num">${pct(o.reach)}</div>
        <div class="num">${o.strength.toFixed(2)}</div>
        <div class="num">${money(o.season)}<div class="se">±${gap(o.seasonSe)}</div></div>
        <details class="then"><summary>plans${apart ? ' · <span class="tie">' + apart + ' stand' + (apart === 1 ? 's' : '') + ' apart</span>' : ''}</summary>
          <div class="path"><span class="muted">Typical</span> ${commonLine(shares(doc, o.cands, H2), ch, false)}</div>
          <div class="muted small foot">${one ? '' : 'alone ' + money(o.alone) + ' · '}${o.cands.length} path${o.cands.length === 1 ? '' : 's'}${noPins}${o === best ? '' : ' · gap ±' + gap(o.seBest)} · raw last survivor ${money(o.end)}${tb._best === o.key ? ' · diversifies the portfolio best' : ''}</div>
          ${worst}${paths}</details></div>`;
    }).join('');
    box.innerHTML = `<div class="box">
      <h2 style="margin-top:0">${esc(e.name)} <span class="muted small">burned ${esc(e.burned.join(' '))}</span></h2>
      ${flip ? `<div class="note">On the end-of-season reading, the base model's field without this week's pins makes <b>${esc(doc.cands[flip.to].pick)}</b> the better option alone for this burned set, by ${money(flip.gain)} ± ${flip.se.toFixed(2)} over ${esc(doc.cands[flip.frm].pick)}. The pick leans on the pins.</div>` : ''}
      <details class="howto"><summary>How to read this</summary><p class="muted small">Each option is this week's team, priced as an even mix of the futures the value map planned behind it, since the rest of the season is re-solved every week. Worth now is what it adds to the book at week ${H}: in every simulated season where the entry is alive going into week ${H}, it takes an equal cut of the pot with everyone else still alive, counted as more than one entry when its plans have better teams left. Teams left is that count: how much more often than the field its plans survive weeks ${H} to ${H2}. Under the best option, ± is its standard error; under every other, the gap to the best and that gap's own standard error, measured on the same seasons. A tie is within two of those, and div marks the tie that diversifies the portfolio best.${one ? '' : ' Alone, under plans, is the option with no other entry beside it.'} Reaches is the chance the entry is alive going into week ${H}. Worth to week 18 is the same cut at week ${H} with the count read from what the paths have left all the way to the end, so the last weeks count (D324); it leans against plans that only survive when the favourites fall, which is why the decision stays on Worth wk ${H}. Raw under it is the old reading, the pot to whoever is alive at the end: it rests on a handful of seasons and swings by thousands. Worth, Alone aside, is what the option adds to the book as it stands, so it moves as you bank this contest's other entries; Reaches and Teams left never do. Every path can be banked on its own; one that stands apart beats the best team's mix by more than two standard errors, a season plan worth following as it is. Under each option, plans opens the typical line, every path behind it, the gap's standard error, the raw last-survivor reading and the portfolio's worst tenth of seasons.</p>
      <p class="muted small">Common picks is the share of this entry's ${allCands.length} planned paths that play each team. In the paths, over the same ${NEAR} weeks, <span class="agree">this colour</span> is a team at least half of them play that week and <span class="differ">this colour</span> is a path going its own way.</p></details>
      <div class="common path"><span class="muted">Common picks, the next ${NEAR} weeks</span> ${commonLine(sh, ch, true)}</div>
      <div class="opts" style="--n:4"><div class="orow ohead"><div>Week ${doc.week}</div>
      <div class="num">Worth wk ${H}</div><div class="num">Reach wk ${H}</div><div class="num">Left ${H}–${H2}</div><div class="num">To wk 18</div></div>
      ${rows}</div></div>`;
    box.querySelectorAll('[data-bank]').forEach(b => b.onclick = () => {
      c.history.push({ id, prev: st.picks[id] ? st.picks[id].key : undefined });
      c.vals = c.vals || {}; c.vals[id] = +b.dataset.val;
      st.bank(id, b.dataset.bank);
      save(c);
      const next = st.worthNow()[0];
      app.sel[doc.slug] = next ? next.entry.id : id;
      paint(c);
    });
    box.querySelectorAll('[data-unbank]').forEach(b => b.onclick = () => {
      c.history.push({ id, prev: st.picks[id] ? st.picks[id].key : undefined });
      st.unbank(id); save(c); paint(c);
    });
  }

  function act(c, what) {
    const { st, doc } = c;
    const sec = $('#main .contest');
    if (what === 'autofill') {
      const before = new Set(st.order);
      for (;;) {
        const r = st.worthNow()[0];
        if (!r || !r.best) break;
        c.vals = c.vals || {}; c.vals[r.entry.id] = r.best.mean;
        st.bank(r.entry.id, r.best.key);
      }
      c.history.push({ autofill: st.order.filter(x => !before.has(x)) });
      save(c); paint(c);
    } else if (what === 'undo') {
      const h = c.history.pop();
      if (!h) return;
      if (h.autofill) h.autofill.forEach(id => st.unbank(id));
      else if (h.prev === undefined) st.unbank(h.id);
      else st.bank(h.id, h.prev);
      save(c); paint(c);
    } else if (what === 'reset') {
      if (!confirm('Clear every pick in ' + doc.name + '?')) return;
      [...st.order].forEach(id => st.unbank(id));
      c.history = []; c.vals = {};
      save(c); paint(c);
    } else if (what === 'check') {
      const out = $('.checkout', sec);
      const sw = st.check(2);
      out.innerHTML = `<div class="sugg"><b>Check my book:</b> ${sw.length ? '' : 'no single swap improves the book by more than two standard errors.'}
        ${sw.map((s, i) => { const e = c.book.entries.find(x => x.id === s.entry);
          return `<div>${esc(e.name)}: ${esc(label(doc, s.from))} → <b>${esc(label(doc, s.to))}</b>
            adds ${money(s.gain)} ± ${gap(s.se)} <button class="btn small" data-sw="${i}">Apply</button></div>`; }).join('')}</div>`;
      out.querySelectorAll('[data-sw]').forEach(b => b.onclick = () => {
        const s = sw[+b.dataset.sw];
        c.history.push({ id: s.entry, prev: s.from });
        c.vals = c.vals || {}; c.vals[s.entry] = (c.vals[s.entry] || 0) + s.gain;
        st.bank(s.entry, s.to); save(c); out.innerHTML = ''; paint(c);
      });
    }
  }

  /* ---- THE PORTFOLIO ACROSS CONTESTS (D328) ----
   * Every contest of the week loaded with its saved picks, and where their
   * worlds are the same NFL seasons (the same game_seed and world count,
   * D327) the books added world by world: what the whole portfolio is
   * worth in each simulated season, not only on average. */
  async function portfolioContext() {
    if (app.port && app.port.week === app.week) return app.port;
    const rows = weekRows(), list = [];
    for (const r of rows) {
      const key = app.week + '/' + r.slug;
      if (!app.docs[key]) {
        try {
          const doc = await (await fetch('data/' + r.file, { cache: 'no-cache' })).json();
          const book = new E.Book(doc);
          app.docs[key] = { doc, book, st: new E.State(book), history: [], stale: [] };
          restore(app.docs[key]);
        } catch (e) { continue; }
      }
      list.push({ r, c: app.docs[key] });
    }
    const seeds = new Set(list.map(x => x.c.doc.game_seed));
    const ns = new Set(list.map(x => x.c.doc.worlds));
    const aligned = list.length > 0 && seeds.size === 1 && !seeds.has(undefined) && !seeds.has(null) && ns.size === 1;
    const port = { week: app.week, list, aligned, eq: {} };
    if (aligned) {
      const N = list[0].c.doc.worlds, total = new Float64Array(N);
      list.forEach(({ r, c }) => { const e = c.st.equity(); port.eq[r.slug] = e; for (let n = 0; n < N; n++) total[n] += e[n]; });
      port.total = total; port.N = N;
    }
    app.port = port;
    return port;
  }

  const guardKey = () => 'sb:guard';

  /* ---- the portfolio page and the cheat sheet ---- */
  async function renderPortfolio() {
    $('#main').innerHTML = '<p class="muted pad">Loading every contest of the week…</p>';
    const port = await portfolioContext();
    const rows = weekRows();
    const saved = rows.map(r => ({ r, s: lsGet('sb:' + r.season + '-' + r.week + '-' + r.slug) }));
    let total = 0, banked = 0, entries = 0;
    const exp = {};
    const all = [];
    saved.forEach(({ r, s }) => {
      entries += r.entries;
      if (!s) return;
      total += s.summary ? s.summary.dollars : 0;
      banked += s.summary ? s.summary.banked : 0;
      Object.entries(s.summary ? s.summary.exposure : {}).forEach(([t, n]) => exp[t] = (exp[t] || 0) + n);
      (s.order || []).forEach(id => { const p = s.picks[id]; all.push({ contest: r.name, slug: r.slug, name: p.name, pick: p.pick, value: p.value }); });
    });
    const sheet = saved.filter(x => x.s && x.s.order && x.s.order.length).map(({ r, s }) => {
      // by entry number, Entry 7 before Entry 16, the order the site lists them in
      const lines = s.order.map(id => s.picks[id]).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        .map(p => `  ${p.name.padEnd(24)} ${p.pick}`);
      return `${r.name.toUpperCase()}  (${s.order.length} of ${r.entries}, book ${money(s.summary.dollars)})\n${lines.join('\n')}`;
    }).join('\n\n');
    const byWorth = all.sort((a, b) => (b.value || 0) - (a.value || 0))
      .map(p => `  ${(p.contest + ' · ' + p.name).padEnd(36)} ${p.pick}`).join('\n');
    // a loss is shared across contests: the same team losing takes entries
    // in every book that holds it, and the books' dollars fall together
    const hit = {};
    let unsaved = 0;
    saved.forEach(({ r, s }) => {
      if (!s || !s.summary) return;
      if (s.summary.banked && !s.summary.ifLoses) { unsaved++; return; }
      Object.entries(s.summary.ifLoses || {}).forEach(([t, x]) => {
        const h = hit[t] = hit[t] || { entries: 0, drop: 0, chance: x.chance, where: [] };
        h.entries += x.entries;
        h.drop += s.summary.dollars - x.dollars;
        h.where.push(r.slug + ' ' + x.entries);
      });
    });
    const hitRows = Object.entries(hit).sort((a, b) => b[1].drop - a[1].drop).map(([t, h]) =>
      `<tr><td class="pick">${esc(t)}</td><td class="num">${pct(h.chance)}</td><td class="num">${h.entries}</td>
       <td class="num">${money(total - h.drop)}</td><td class="num">${h.drop > 0 ? '−' : '+'}${money(Math.abs(h.drop))}</td><td>${esc(h.where.join(' · '))}</td></tr>`).join('');
    const hitHtml = hitRows ? `<h2>If a team loses this week</h2>
      <p class="muted small">The entries a loss takes across every contest, and the books read over only the worlds where that team lost. A loss that takes a lot of the field can leave the books higher: our other entries face fewer rivals. The loss chance is the first contest's board.${unsaved ? ' ' + unsaved + ' contest(s) saved before this table existed: open each once to include it.' : ''}</p>
      <div class="tablewrap"><table><thead><tr><th>Team</th><th class="num">Loses</th><th class="num">Our entries</th>
      <th class="num">All books if it loses</th><th class="num">Change</th><th>Where</th></tr></thead><tbody>${hitRows}</tbody></table></div>` : '';
    const expHtml = Object.entries(exp).sort((a, b) => b[1] - a[1]).map(([t, n]) => `<span class="chip">${esc(t)} ${n}</span>`).join('') || '<span class="muted small">nothing banked</span>';
    // ---- THE WHOLE PORTFOLIO, WORLD BY WORLD (D328) ----
    let portHtml = '';
    const guard = lsGet(guardKey()) || {};
    if (!port.aligned) {
      portHtml = `<h2>The whole portfolio</h2><p class="muted small">The books of this week were not built on the same simulated seasons (they need the same game seed, D327: rebuild them together with <code>book ${esc(app.week.split('-')[1])} --all</code>), so they can only be added on average, not season by season.</p>`;
    } else {
      const T = port.total, N = port.N, mean = T.reduce((a, b) => a + b, 0) / N;
      const stand = +app.week.split('-')[1];
      const under = f => T.filter(v => v <= f * mean).length / N;
      const deadRows = [];
      const H = port.list[0].c.book.H;
      for (let w = stand + 1; w <= H; w++) {
        const all = new Float64Array(N).fill(1);
        port.list.forEach(({ c }) => { const d = c.st.deadBy(w); for (let n = 0; n < N; n++) all[n] *= d[n]; });
        deadRows.push([w, all.reduce((a, b) => a + b, 0) / N]);
      }
      const endAll = new Float64Array(N).fill(1);
      port.list.forEach(({ c }) => { const d = c.st.deadBy(c.doc.end); for (let n = 0; n < N; n++) endAll[n] *= d[n]; });
      const pAny = 1 - endAll.reduce((a, b) => a + b, 0) / N;
      // dollars each team carries this week: the portfolio less the same
      // portfolio without the entries banked on it, world by world
      const teams = new Set();
      port.list.forEach(({ c }) => Object.values(c.st.picks).forEach(t => t.pick.split('+').forEach(x => teams.add(x))));
      const carry = [...teams].map(t => {
        let d = 0;
        port.list.forEach(({ r, c }) => { const w = c.st.equityWithout(t), e = port.eq[r.slug]; for (let n = 0; n < N; n++) d += e[n] - w[n]; });
        return [t, d / N];
      }).sort((a, b) => b[1] - a[1]);
      const X = guard.x, Y = guard.y;
      const breach = [];
      if (X) carry.forEach(([t, d]) => { if (mean > 0 && 100 * d / mean > X) breach.push(`<b>${esc(t)}</b> carries ${(100 * d / mean).toFixed(0)}% of the portfolio's expected dollars, over your ${X}% limit`); });
      const p75 = under(0.25);
      if (Y && 100 * p75 > Y) breach.push(`the chance of keeping a quarter or less of the expected dollars at week ${H} is ${(100 * p75).toFixed(1)}%, over your ${Y}% limit`);
      // the cheapest moves off an over-limit team: each entry on it, its best
      // option without that team, and what the move costs in this book
      let swaps = '';
      if (X) {
        const over = carry.filter(([, d]) => mean > 0 && 100 * d / mean > X).map(([t]) => t);
        const moves = [];
        over.forEach(t => port.list.forEach(({ r, c }) => Object.keys(c.st.picks).forEach(id => {
          if (!c.st.picks[id].pick.split('+').includes(t)) return;
          const opts = c.st.options(id);
          const cur = opts.find(o => o.key === c.st.picks[id].key);
          const alt = opts.find(o => !o.pick.split('+').includes(t));
          if (cur && alt) moves.push({ r, id, t, from: cur.pick, to: alt.pick, cost: cur.mean - alt.mean,
            name: (c.book.entries.find(e => e.id === id) || {}).name || id });
        })));
        moves.sort((a, b) => a.cost - b.cost);
        if (moves.length) swaps = '<p class="small">The cheapest moves off it, in expected dollars of the entry\'s own book: ' +
          moves.slice(0, 6).map(m => `${esc(m.r.name)} · ${esc(m.name)}: ${esc(m.from)} → <b>${esc(m.to)}</b> ${m.cost < 0 ? 'gains ' + money(-m.cost) : 'costs ' + money(m.cost)}`).join('; ') + '.</p>';
      }
      portHtml = `<h2>The whole portfolio, season by season</h2>
        <p class="muted small">Every contest's book priced on the same ${N.toLocaleString()} simulated seasons (D327), so the books add up season by season: the spread of what the whole portfolio is worth at week ${H}, and how often everything we hold is out. Over the entries banked so far.</p>
        <div class="cards">
          <div class="card"><div class="k">Expected, all books</div><div class="v">${money(mean)}</div></div>
          <div class="card"><div class="k">Middle of the spread</div><div class="v">${money(E.quantile(T, 0.5))}</div><div class="k">1 in 10 under ${money(E.quantile(T, 0.1))}</div></div>
          <div class="card"><div class="k">Worst 10% of seasons, average</div><div class="v">${money(E.tail(T, 0.1))}</div></div>
          <div class="card"><div class="k">Keep half or less</div><div class="v">${pct(under(0.5))}</div><div class="k">a quarter or less ${pct(p75)}</div></div>
          <div class="card"><div class="k">At least one entry alive at the end</div><div class="v">${pct(pAny)}</div></div></div>
        <div class="tablewrap"><table><thead><tr><th>Everything out before week</th>${deadRows.map(([w]) => `<th class="num">${w}</th>`).join('')}</tr></thead>
          <tbody><tr><td>chance</td>${deadRows.map(([, p]) => `<td class="num">${pct(p)}</td>`).join('')}</tr></tbody></table></div>
        <h3>What each team carries this week, in dollars</h3>
        <div class="chips">${carry.map(([t, d]) => `<span class="chip">${esc(t)} ${money(d)}${mean > 0 ? ' · ' + (100 * d / mean).toFixed(0) + '%' : ''}</span>`).join('') || '<span class="muted small">nothing banked</span>'}</div>
        <h3>Guardrails</h3>
        <p class="small">Most a team may carry, % of expected dollars <input id="gx" type="number" min="1" max="100" value="${X || ''}" style="width:4em">
          · most the chance of keeping a quarter or less may be, % <input id="gy" type="number" min="0" max="100" value="${Y || ''}" style="width:4em">
          <button class="btn small" id="gsave">Set</button> <span class="muted">blank is off</span></p>
        ${breach.length ? '<div class="note">' + breach.join('<br>') + '</div>' + swaps : (X || Y ? '<p class="small muted">Inside both limits.</p>' : '')}`;
    }
    $('#main').innerHTML = `<section class="sheet">
      <div class="head"><div><h1>Portfolio, ${esc(app.week.replace('-', ' week '))}</h1>
      <div class="muted">Contests never share a pot, so their dollars add. Where the books stand on the same simulated seasons they are also added season by season, and the guardrails read that.</div></div>
      <div class="actions"><button class="btn" id="copy">Copy cheat sheet</button>
      <button class="btn ghost" id="exp">Export picks</button><label class="btn ghost">Import<input id="imp" type="file" accept=".json" hidden></label></div></div>
      <div class="cards">
        <div class="card"><div class="k">All books, expected</div><div class="v">${money(total)}</div></div>
        <div class="card"><div class="k">Banked</div><div class="v">${banked} / ${entries}</div></div>
        <div class="card"><div class="k">Entries per team, every contest</div><div class="chips">${expHtml}</div></div></div>
      ${portHtml}
      <div class="tablewrap"><table><thead><tr><th>Contest</th><th class="num">Pot</th><th class="num">Banked</th><th class="num">Book</th><th class="num">Ours alive at the horizon, expected</th></tr></thead><tbody>
      ${saved.map(({ r, s }) => `<tr><td><a href="#${app.week}/${r.slug}">${esc(r.name)}</a></td><td class="num">${money(r.pot)}</td>
        <td class="num">${s && s.summary ? s.summary.banked : 0} / ${r.entries}</td><td class="num">${s && s.summary ? money(s.summary.dollars) : '—'}</td>
        <td class="num">${s && s.summary && s.summary.alive !== undefined ? s.summary.alive.toFixed(2) + ' into wk ' + s.summary.horizon : '—'}</td></tr>`).join('')}</tbody></table></div>
      ${hitHtml}
      <h2>Cheat sheet, by contest (by entry number)</h2><pre id="sheet">${esc(sheet || 'Nothing banked yet.')}</pre>
      <h2>Every pick, most valuable first</h2><pre>${esc(byWorth || 'Nothing banked yet.')}</pre></section>`;
    if ($('#gsave')) $('#gsave').onclick = () => {
      const x = +$('#gx').value || null, y = +$('#gy').value || null;
      lsSet(guardKey(), { x, y }); renderPortfolio();
    };
    $('#copy').onclick = () => navigator.clipboard && navigator.clipboard.writeText(sheet).then(() => { $('#copy').textContent = 'Copied'; });
    $('#exp').onclick = () => {
      const out = {}; saved.forEach(({ r, s }) => { if (s) out[r.slug] = s; });
      const blob = new Blob([JSON.stringify({ week: app.week, exported: new Date().toISOString(), contests: out }, null, 1)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'picks_' + app.week + '.json'; a.click();
    };
    $('#imp').onchange = async ev => {
      const f = ev.target.files[0]; if (!f) return;
      const d = JSON.parse(await f.text());
      Object.entries(d.contests || {}).forEach(([slug, s]) => {
        const r = rows.find(x => x.slug === slug);
        if (r) { lsSet('sb:' + r.season + '-' + r.week + '-' + slug, s); delete app.docs[app.week + '/' + slug]; }
      });
      renderPortfolio(); tabs();
    };
  }

  /* ---- every device, one book: a private gist, as br_rankings does it ----
   * Everything the page keeps under `sb:` (the picks of every contest and week,
   * the chalk, the guardrails) is mirrored into one file of a private gist. A
   * token with the gist scope is all a device needs; one already saved on this
   * site for br_rankings is used as it is. Each key carries the time it last
   * changed and the newer side wins: an edit goes up a couple of seconds after
   * it is made, and opening or returning to the page brings down whatever
   * another device saved since. The token never leaves this browser except to
   * api.github.com. */
  const GH = 'https://api.github.com', GIST_FILE = 'survivor_book.json', GIST_DESC = 'survivor book picks';
  const SK = { token: 'sbsync:token', gist: 'sbsync:gist', mod: 'sbsync:mod', device: 'sbsync:device' };
  const sync = { timer: null, busy: false, msg: '', open: false };
  function rawGet(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function rawSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private window */ } }
  const token = () => rawGet(SK.token) || rawGet('brr:gh:token');
  function device() {
    let d = rawGet(SK.device);
    if (!d) {
      const u = navigator.userAgent;
      d = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android'
        : /Mac/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows' : 'a browser';
      rawSet(SK.device, d);
    }
    return d;
  }
  function markLocal(k) {
    const mods = rawGet(SK.mod) || {};
    mods[k] = new Date().toISOString();
    rawSet(SK.mod, mods);
    scheduleSync(2000);
  }
  function scheduleSync(ms) {
    if (!token()) return;
    clearTimeout(sync.timer);
    sync.timer = setTimeout(autoSync, ms);
  }
  async function gh(path, opts) {
    opts = opts || {};
    const headers = { Authorization: 'Bearer ' + token(), Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28' };
    if (opts.body) headers['Content-Type'] = 'application/json';
    let r;
    try { r = await fetch(GH + path, { method: opts.method || 'GET', headers, body: opts.body, cache: 'no-store' }); }
    catch (e) { throw new Error('could not reach GitHub; the page still works on this device'); }
    if (r.status === 401 || r.status === 403) throw new Error('GitHub refused the token; it needs the gist scope');
    if (!r.ok) throw new Error('GitHub returned HTTP ' + r.status);
    return r.json();
  }
  async function readGist() {
    let id = rawGet(SK.gist);
    if (!id) {
      const list = await gh('/gists?per_page=100');
      const g = list.find(x => x.files && x.files[GIST_FILE]);
      if (g) { id = g.id; rawSet(SK.gist, id); }
    }
    if (!id) return { id: null, keys: {} };
    const g = await gh('/gists/' + id);
    const f = (g.files || {})[GIST_FILE];
    let doc = null;
    try { doc = f && JSON.parse(f.content); } catch (e) { doc = null; }
    return { id, keys: (doc && doc.keys) || {} };
  }
  async function writeGist(id, keys) {
    const body = { description: GIST_DESC, files: { [GIST_FILE]: { content: JSON.stringify({ version: 1, keys }) } } };
    if (id) return gh('/gists/' + id, { method: 'PATCH', body: JSON.stringify(body) });
    body.public = false;
    const g = await gh('/gists', { method: 'POST', body: JSON.stringify(body) });
    rawSet(SK.gist, g.id);
    return g;
  }
  async function autoSync() {
    clearTimeout(sync.timer); sync.timer = null;
    if (!token()) return paintSync();
    if (sync.busy) { scheduleSync(1500); return; }
    sync.busy = true;
    try {
      const cur = await readGist();
      const mods = rawGet(SK.mod) || {};
      const local = new Set();
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('sb:')) local.add(k); }
      const out = Object.assign({}, cur.keys), took = [];
      let pushed = 0;
      for (const k of new Set([...Object.keys(cur.keys), ...local])) {
        const r = cur.keys[k];
        const lv = local.has(k) ? rawGet(k) : null;
        // the time of this device's last real edit; picks never edited since
        // sync came in carry none, so another device's save wins over them
        const lm = local.has(k) ? (mods[k] || '') : '';
        if (r && (!local.has(k) || r.saved_at > lm)) {
          if (stripSaved(JSON.stringify(r.value)) !== stripSaved(localStorage.getItem(k))) { rawSet(k, r.value); took.push(k); }
          mods[k] = r.saved_at;
        } else if (local.has(k) && (!r || lm > r.saved_at)) {
          out[k] = { value: lv, saved_at: lm || new Date().toISOString(), device: device() };
          mods[k] = out[k].saved_at;
          pushed++;
        }
      }
      rawSet(SK.mod, mods);
      if (pushed) await writeGist(cur.id, out);
      const when = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      sync.msg = 'Synced ' + when + (took.length ? ', brought in ' + took.length + ' change(s) from another device' : '')
        + (pushed ? ', sent ' + pushed : '');
      if (took.length) {
        app.docs = {}; app.port = null;
        if (app.cur) show(app.cur);
      }
    } catch (e) {
      sync.msg = 'Sync: ' + e.message;
    } finally {
      sync.busy = false;
      paintSync();
    }
  }
  function paintSync() {
    const b = $('#syncBtn'), p = $('#syncPanel');
    if (!b || !p) return;
    const on = !!token();
    b.textContent = on ? 'Synced' : 'Sync';
    b.title = on ? (sync.msg || 'Syncing every device through a private gist') : 'Keep picks the same on every device';
    p.hidden = !sync.open;
    $('#syncStatus').textContent = on
      ? (sync.msg || 'Checking the gist…') + '. Picks, chalk and guardrails follow you to every device holding the token. This device is ' + device() + '.'
      : 'Not connected. Paste a GitHub token with the gist scope (the one br_rankings uses works) and every device with it sees the same picks.';
    $('#syncConnectRow').hidden = on;
    $('#syncForget').hidden = !on;
  }
  $('#syncBtn').onclick = () => { sync.open = !sync.open; paintSync(); };
  $('#syncConnect').onclick = async () => {
    const t = $('#syncToken').value.trim();
    if (!t) return;
    rawSet(SK.token, t);
    $('#syncToken').value = '';
    sync.msg = 'Checking the token…'; paintSync();
    await autoSync();
    if (/refused|reach/.test(sync.msg)) { try { localStorage.removeItem(SK.token); } catch (e) { /* ignore */ } paintSync(); }
  };
  $('#syncForget').onclick = () => {
    try { localStorage.removeItem(SK.token); localStorage.removeItem(SK.gist); } catch (e) { /* ignore */ }
    sync.msg = ''; paintSync();
  };
  // coming back to the page pulls; leaving it sends anything still waiting
  document.addEventListener('visibilitychange', () => {
    if (!token()) return;
    if (document.visibilityState === 'visible' || sync.timer) autoSync();
  });

  init();
})();
