/* app.js - the pick loop. One portfolio per contest: pick the most valuable
 * entry, see its options priced against the book as it stands, bank one, and
 * every other entry re-prices. Picks live in this browser (localStorage) and
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
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private window */ } }

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
    const bankBtn = (key, val, text) => key === cur ? '<button class="btn small ghost" data-unbank="1">Unbank</button>'
      : `<button class="btn small" data-bank="${key}" data-val="${val}">${text}</button>`;
    const rows = opts.map(o => {
      const tie = best && o !== best && (best.mean - o.mean) < 2 * o.seBest;
      const price = o.pick.split('+').map(t => doc.price[t] !== undefined ? (100 * doc.price[t]).toFixed(0) + '%' : '').join('<br>');
      const end = o.cands.reduce((s, ci) => s + book.endAlone(ci), 0) / o.cands.length;
      const alts = o.cands.map(ci => doc.cands[ci].alt).filter(x => x !== null && x !== undefined);
      const noPins = hasAlt && alts.length === o.cands.length && end > 0
        ? ' · without the pins ×' + (alts.reduce((s, x) => s + x, 0) / alts.length / end).toFixed(2) : '';
      const apart = o.paths.filter(p => p.apart).length;
      const paths = o.paths.map(p => `<div class="pth ${p.key === cur ? 'cur' : ''}">
          <div class="pv">${money(p.mean)} <span class="se">${(p.gap >= 0 ? '+' : '−') + gap(Math.abs(p.gap))} ±${gap(p.seGap)} vs the mix · week 18 ${money(p.end)}</span>
          ${p.apart ? '<span class="tie">stands apart</span>' : ''} ${bankBtn(p.key, p.mean, 'Bank this path')}</div>
          <div class="path" title="spine ${esc(doc.cands[p.cands[0]].spine)}">${pathText(doc, p.cands[0], cons, ch)}</div></div>`).join('');
      return `<div class="orow opt ${o.key === cur || (cur && cur.startsWith('p:') && o.cands.includes(+cur.slice(2))) ? 'cur' : ''}">
        <div class="pk"><span class="pick">${esc(o.pick).replace(/\+/g, '+<wbr>')}</span>${o === best ? ' <span class="tie">best</span>' : tie ? ' <span class="tie">tie</span>' : ''}
          <div class="se">${price.replace('<br>', ' + ')} to win</div>
          <div>${bankBtn(o.key, o.mean, 'Bank')}</div></div>
        <div class="num">${money(o.mean)}<div class="se">${o === best ? '±' + gap(o.se) : '−' + gap(best.mean - o.mean) + '<br>±' + gap(o.seBest)}</div></div>
        ${one ? '' : `<div class="num">${money(o.alone)}</div>`}
        <div class="num">${pct(o.reach)}</div>
        <div class="num">${o.strength.toFixed(2)}</div>
        <div class="num">${money(o.end)}</div>
        <div class="then path"><span class="muted">Typical</span> ${commonLine(shares(doc, o.cands, H2), ch, false)}
          <div class="muted small foot">${o.cands.length} path${o.cands.length === 1 ? '' : 's'}${noPins}</div>
          ${o.cands.length > 1 || apart ? `<details${apart ? ' open' : ''}><summary>${apart ? apart + ' path' + (apart === 1 ? '' : 's') + ' stand' + (apart === 1 ? 's' : '') + ' apart · ' : ''}the ${o.cands.length} paths</summary>${paths}</details>` : ''}</div></div>`;
    }).join('');
    box.innerHTML = `<div class="box">
      <h2 style="margin-top:0">${esc(e.name)} <span class="muted small">burned ${esc(e.burned.join(' '))}</span></h2>
      ${flip ? `<div class="note">On the end-of-season reading, the base model's field without this week's pins makes <b>${esc(doc.cands[flip.to].pick)}</b> the better option alone for this burned set, by ${money(flip.gain)} ± ${flip.se.toFixed(2)} over ${esc(doc.cands[flip.frm].pick)}. The pick leans on the pins.</div>` : ''}
      <p class="muted small">Each option is this week's team, priced as an even mix of the futures the value map planned behind it, since the rest of the season is re-solved every week. Worth now is what it adds to the book at week ${H}: in every simulated season where the entry is alive going into week ${H}, it takes an equal cut of the pot with everyone else still alive, counted as more than one entry when its plans have better teams left. Teams left is that count: how much more often than the field its plans survive weeks ${H} to ${H2}. Under the best option, ± is its standard error; under every other, the gap to the best and that gap's own standard error, measured on the same seasons. A tie is within two of those.${one ? '' : ' Alone is the option with no other entry beside it.'} Reaches is the chance the entry is alive going into week ${H}. Worth week 18 is the old reading, the pot to whoever is alive at the end, kept for comparison: it rests on a handful of seasons and swings by thousands. Worth, Alone aside, is what the option adds to the book as it stands, so it moves as you bank this contest's other entries; Reaches and Teams left never do. Every path can be banked on its own; one that stands apart beats the best team's mix by more than two standard errors, a season plan worth following as it is.</p>
      <div class="common path"><span class="muted">Common picks, the next ${NEAR} weeks</span> ${commonLine(sh, ch, true)}</div>
      <p class="muted small">The share of this entry's ${allCands.length} planned paths that play each team. In the paths, over the same ${NEAR} weeks, <span class="agree">this colour</span> is a team at least half of them play that week and <span class="differ">this colour</span> is a path going its own way.</p>
      <div class="opts" style="--n:${4 + (one ? 0 : 1)}"><div class="orow ohead"><div>Week ${doc.week}</div>
      <div class="num">Worth wk ${H}</div>${one ? '' : '<div class="num">Alone</div>'}<div class="num">Reaches wk ${H}</div><div class="num">Teams left wk ${H}–${H2}</div><div class="num">Worth wk 18</div></div>
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

  /* ---- the portfolio page and the cheat sheet ---- */
  function renderPortfolio() {
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
      const lines = s.order.map(id => s.picks[id]).sort((a, b) => (b.value || 0) - (a.value || 0))
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
    $('#main').innerHTML = `<section class="sheet">
      <div class="head"><div><h1>Portfolio, ${esc(app.week.replace('-', ' week '))}</h1>
      <div class="muted">Contests never share a pot, so their dollars add; the exposure is shown and nothing is optimised across contests.</div></div>
      <div class="actions"><button class="btn" id="copy">Copy cheat sheet</button>
      <button class="btn ghost" id="exp">Export picks</button><label class="btn ghost">Import<input id="imp" type="file" accept=".json" hidden></label></div></div>
      <div class="cards">
        <div class="card"><div class="k">All books, expected</div><div class="v">${money(total)}</div></div>
        <div class="card"><div class="k">Banked</div><div class="v">${banked} / ${entries}</div></div>
        <div class="card"><div class="k">Exposure, every contest</div><div class="chips">${expHtml}</div></div></div>
      <div class="tablewrap"><table><thead><tr><th>Contest</th><th class="num">Pot</th><th class="num">Banked</th><th class="num">Book</th><th class="num">Ours alive at the horizon, expected</th></tr></thead><tbody>
      ${saved.map(({ r, s }) => `<tr><td><a href="#${app.week}/${r.slug}">${esc(r.name)}</a></td><td class="num">${money(r.pot)}</td>
        <td class="num">${s && s.summary ? s.summary.banked : 0} / ${r.entries}</td><td class="num">${s && s.summary ? money(s.summary.dollars) : '—'}</td>
        <td class="num">${s && s.summary && s.summary.alive !== undefined ? s.summary.alive.toFixed(2) + ' into wk ' + s.summary.horizon : '—'}</td></tr>`).join('')}</tbody></table></div>
      ${hitHtml}
      <h2>Cheat sheet, by contest (most valuable entry first)</h2><pre id="sheet">${esc(sheet || 'Nothing banked yet.')}</pre>
      <h2>Every pick, most valuable first</h2><pre>${esc(byWorth || 'Nothing banked yet.')}</pre></section>`;
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

  init();
})();
