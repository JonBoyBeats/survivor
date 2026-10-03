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
  // a standard error or a gap in dollars: whole dollars once they reach 100
  const gap = v => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const weekKey = r => r.season + '-' + r.week;
  const lsKey = (doc) => 'sb:' + doc.season + '-' + doc.week + '-' + doc.slug;

  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
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

  /* ---- persistence: picks by candidate, re-matched by path if the data was rebuilt ---- */
  function restore(c) {
    const saved = lsGet(lsKey(c.doc));
    if (!saved || !saved.picks) return;
    const sameBuild = saved.built === c.doc.built;
    for (const id of saved.order || Object.keys(saved.picks)) {
      const p = saved.picks[id];
      if (!p || c.book.groupOf[id] === undefined) { c.stale.push(p ? p.pick + ' (' + id + ')' : id); continue; }
      let cand = sameBuild ? p.cand : undefined;
      if (cand === undefined || !c.doc.groups[c.book.groupOf[id]].cands.includes(cand)) {
        cand = c.doc.groups[c.book.groupOf[id]].cands.find(x => JSON.stringify(c.doc.cands[x].path) === JSON.stringify(p.path));
      }
      if (cand === undefined) { c.stale.push(p.pick + ' for ' + (p.name || id)); continue; }
      c.st.bank(id, cand);
      c.vals = c.vals || {};
      c.vals[id] = p.value;
    }
    save(c);
  }

  function save(c) {
    const picks = {};
    for (const id of c.st.order) {
      const cand = c.st.picks[id];
      const e = c.book.entries.find(x => x.id === id);
      picks[id] = { cand, pick: c.doc.cands[cand].pick, path: c.doc.cands[cand].path,
        name: e ? e.name : id, value: (c.vals || {})[id] };
    }
    lsSet(lsKey(c.doc), { built: c.doc.built, name: c.doc.name, slug: c.doc.slug, pot: c.doc.pot,
      order: c.st.order, picks, summary: c.st.summary(), saved: new Date().toISOString() });
  }

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
    paint(c);
  }

  function paint(c) {
    const { doc, book, st } = c;
    const sec = $('#main .contest');
    const sm = st.summary();
    const exp = Object.entries(sm.exposure).sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `<span class="chip">${esc(t)} ${n}</span>`).join('') || '<span class="muted small">nothing banked</span>';
    $('.cards', sec).innerHTML = `
      <div class="card"><div class="k">Book, expected</div><div class="v">${money(sm.dollars)}</div></div>
      <div class="card"><div class="k">Banked</div><div class="v">${sm.banked} / ${sm.total}</div></div>
      <div class="card"><div class="k">Any of ours standing at the end</div><div class="v">${pct(sm.any)}</div></div>
      <div class="card"><div class="k">This week's exposure</div><div class="chips">${exp}</div></div>`;
    const rows = st.worthNow();
    const todo = $('.todo', sec), done = $('.done', sec);
    todo.innerHTML = rows.length ? rows.map(r => `
      <li data-id="${esc(r.entry.id)}"><div><div class="n">${esc(r.entry.name)}</div>
      <div class="b">burned ${esc(r.entry.burned.join(' '))}${doc.groups[r.entry.group].alt_flip ? ' · <b>leans on the pins</b>' : ''}</div></div>
      <div class="r"><div>${r.best ? money(r.best.mean) : '—'}</div>
      <div class="b">${r.best ? esc(doc.cands[r.best.cand].pick) : 'no option'}</div></div></li>`).join('')
      : '<li class="empty">Every entry is banked.</li>';
    done.innerHTML = st.order.length ? st.order.map((id, i) => {
      const e = book.entries.find(x => x.id === id);
      const v = (c.vals || {})[id];
      return `<li data-id="${esc(id)}"><div><div class="n">${i + 1}. ${esc(e.name)}</div>
        <div class="b">burned ${esc(e.burned.join(' '))}</div></div>
        <div class="r"><div class="pick">${esc(doc.cands[st.picks[id]].pick)}</div>
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

  function pathText(doc, cand) {
    const p = doc.cands[cand].path;
    return Object.keys(p).map(Number).filter(w => w > doc.week).sort((a, b) => a - b)
      .map(w => `<b>${w}</b> ${esc(p[w].join('+'))}`).join(' · ');
  }

  function detail(c, id) {
    const { doc, book, st } = c;
    const box = $('#main .detail');
    if (!id) { box.innerHTML = ''; return; }
    const e = book.entries.find(x => x.id === id);
    const opts = st.options(id, true);
    const best = opts[0];
    c.surv = c.surv || {};
    const cur = st.picks[id];
    const hasAlt = doc.cands.some(x => x.alt !== undefined && x.alt !== null);
    const flip = doc.groups[book.groupOf[id]].alt_flip;
    const rows = opts.map(o => {
      const tie = best && o !== best && (best.mean - o.mean) < 2 * o.seBest;
      if (c.surv[o.cand] === undefined) c.surv[o.cand] = book.survives(o.cand);
      const pick = doc.cands[o.cand].pick;
      const price = pick.split('+').map(t => doc.price[t] !== undefined ? (100 * doc.price[t]).toFixed(0) + '%' : '').join('<br>');
      return `<div class="orow opt ${o.cand === cur ? 'cur' : ''}">
        <div class="pk"><span class="pick">${esc(pick).replace(/\+/g, '+<wbr>')}</span>${o === best ? ' <span class="tie">best</span>' : tie ? ' <span class="tie">tie</span>' : ''}
          <div>${o.cand === cur ? '<button class="btn small ghost" data-unbank="1">Unbank</button>'
            : `<button class="btn small" data-bank="${o.cand}" data-val="${o.mean}">Bank</button>`}</div></div>
        <div class="num">${price}</div>
        <div class="num">${money(o.mean)}<div class="se">${o === best ? '±' + gap(o.se) : '−' + gap(best.mean - o.mean) + '<br>±' + gap(o.seBest)}</div></div>
        <div class="num">${money(o.alone)}</div>
        ${hasAlt ? `<div class="num">${doc.cands[o.cand].alt === null || doc.cands[o.cand].alt === undefined ? '—' : money(doc.cands[o.cand].alt)}</div>` : ''}
        <div class="num">${pct(c.surv[o.cand])}</div>
        <div class="then path" title="spine ${esc(doc.cands[o.cand].spine)}"><span class="muted">Then</span> ${pathText(doc, o.cand)}</div></div>`;
    }).join('');
    box.innerHTML = `<div class="box">
      <h2 style="margin-top:0">${esc(e.name)} <span class="muted small">burned ${esc(e.burned.join(' '))}</span></h2>
      ${flip ? `<div class="note">Without the pins this week's board was built under, the base model's field makes <b>${esc(doc.cands[flip.to].pick)}</b> the better option alone for this burned set, by ${money(flip.gain)} ± ${flip.se.toFixed(2)} over ${esc(doc.cands[flip.frm].pick)}. The pick leans on the pins.</div>` : ''}
      <p class="muted small">Worth now is what this option adds to the book as it stands. Under the best option, ± is its standard error; under every other, the gap to the best and that gap's own standard error, measured on the same worlds. A tie is within two of those. Alone is the option with no other entry beside it. The path is the rest of the season the value map planned behind this pick.${hasAlt ? ' Base field is Alone again with the field the base model projects, without the pins.' : ''}</p>
      <div class="opts" style="--n:${hasAlt ? 5 : 4}"><div class="orow ohead"><div>Week ${doc.week}</div><div class="num">Win</div>
      <div class="num">Worth now</div><div class="num">Alone</div>${hasAlt ? '<div class="num">Base field</div>' : ''}<div class="num">Survives</div></div>
      ${rows}</div></div>`;
    box.querySelectorAll('[data-bank]').forEach(b => b.onclick = () => {
      c.history.push({ id, prev: st.picks[id] });
      c.vals = c.vals || {}; c.vals[id] = +b.dataset.val;
      st.bank(id, +b.dataset.bank);
      save(c);
      const next = st.worthNow()[0];
      app.sel[doc.slug] = next ? next.entry.id : id;
      paint(c);
    });
    box.querySelectorAll('[data-unbank]').forEach(b => b.onclick = () => {
      c.history.push({ id, prev: st.picks[id] });
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
        st.bank(r.entry.id, r.best.cand);
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
          return `<div>${esc(e.name)}: ${esc(doc.cands[s.from].pick)} → <b>${esc(doc.cands[s.to].pick)}</b>
            adds ${money(s.gain)} ± ${s.se.toFixed(2)} <button class="btn small" data-sw="${i}">Apply</button></div>`; }).join('')}</div>`;
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
      <div class="tablewrap"><table><thead><tr><th>Contest</th><th class="num">Pot</th><th class="num">Banked</th><th class="num">Book</th><th class="num">Any standing at the end</th></tr></thead><tbody>
      ${saved.map(({ r, s }) => `<tr><td><a href="#${app.week}/${r.slug}">${esc(r.name)}</a></td><td class="num">${money(r.pot)}</td>
        <td class="num">${s && s.summary ? s.summary.banked : 0} / ${r.entries}</td><td class="num">${s && s.summary ? money(s.summary.dollars) : '—'}</td>
        <td class="num">${s && s.summary ? pct(s.summary.any) : '—'}</td></tr>`).join('')}</tbody></table></div>
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
