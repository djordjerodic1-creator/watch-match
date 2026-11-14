// Builds data/catalog.json from TVmaze (shows) + Wikidata/Wikipedia (movies). No API keys.
// Run: node scripts/build-catalog.mjs
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
const UA = { 'User-Agent': 'movie-match-catalog-builder/1.0 (personal project)' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const strip = s => (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const clip = (s, n = 320) => s.length > n ? s.slice(0, s.lastIndexOf(' ', n)) + '…' : s;

async function getJSON(url, opts = {}, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { ...UA, ...(opts.headers || {}) } });
    if (r.status === 404) return null;
    if (r.ok) return r.json();
    const wait = Math.max(+(r.headers.get('retry-after') || 0) * 1000, 5000 * 2 ** i);
    process.stdout.write(` [${r.status}, waiting ${wait / 1000}s]`);
    await sleep(Math.min(wait, 120000));
  }
  throw new Error('failed ' + url);
}

async function shows() {
  const all = [];
  for (let p = 0; ; p++) {
    const page = await getJSON(`https://api.tvmaze.com/shows?page=${p}`);
    if (!page || !page.length) break;
    for (const s of page) {
      if (!s.image || !s.rating?.average) continue;
      if ((s.weight ?? 0) < 85 || s.rating.average < 6.8) continue;
      if (!['Scripted', 'Animation', 'Documentary', 'Reality'].includes(s.type)) continue;
      all.push({
        id: 'tv' + s.id, kind: 'show', title: s.name,
        year: s.premiered ? +s.premiered.slice(0, 4) : null,
        genres: s.genres, rating: s.rating.average,
        poster: s.image.original || s.image.medium,
        overview: clip(strip(s.summary)),
        meta: [s.network?.name || s.webChannel?.name, s.status === 'Running' ? 'Still running' : s.ended ? `Ended ${s.ended.slice(0, 4)}` : null].filter(Boolean).join(' · '),
        link: s.url, score: s.weight * 10 + s.rating.average * 20
      });
    }
    process.stdout.write(`\rshows page ${p}, kept ${all.length}`);
    await sleep(550);
  }
  console.log();
  return all.sort((a, b) => b.score - a.score).slice(0, 700);
}

async function movies() {
  const sparql = q => getJSON('https://query.wikidata.org/sparql?query=' + encodeURIComponent(q), { headers: { Accept: 'application/sparql-results+json' } });
  const base = await sparql(`SELECT ?f ?title ?sl ?date WHERE { ?f wdt:P31 wd:Q11424; wikibase:sitelinks ?sl. FILTER(?sl >= 40)
    ?a schema:about ?f; schema:isPartOf <https://en.wikipedia.org/>; schema:name ?title. ?f wdt:P577 ?date. }`);
  const byQ = {};
  for (const b of base.results.bindings) {
    const q = b.f.value.split('/').pop(), y = +b.date.value.slice(0, 4);
    const m = byQ[q] ??= { q, title: b.title.value, sl: +b.sl.value, year: y, genres: [] };
    if (y < m.year) m.year = y;
  }
  let list = Object.values(byQ).filter(m => m.year >= 1975).sort((a, b) => b.sl - a.sl).slice(0, 900);
  for (let i = 0; i < list.length; i += 150) {
    const chunk = list.slice(i, i + 150);
    const r = await sparql(`SELECT ?f ?imdb ?dur ?gl WHERE { VALUES ?f { ${chunk.map(m => 'wd:' + m.q).join(' ')} }
      OPTIONAL { ?f wdt:P345 ?imdb } OPTIONAL { ?f wdt:P2047 ?dur }
      OPTIONAL { ?f wdt:P136 ?g. ?g rdfs:label ?gl. FILTER(LANG(?gl)="en") } }`);
    for (const b of r.results.bindings) {
      const m = byQ[b.f.value.split('/').pop()];
      if (b.imdb) m.imdb = b.imdb.value;
      if (b.dur && !m.runtime) m.runtime = Math.round(+b.dur.value);
      if (b.gl) { const g = b.gl.value.replace(/ film$/, '').replace(/^(.)/, c => c.toUpperCase()); if (g.length < 22 && !m.genres.includes(g) && m.genres.length < 3) m.genres.push(g); }
    }
    process.stdout.write(`movie details ${i + chunk.length}/${list.length}`);
  }
  console.log();
  console.log('movies from wikidata:', list.length);
  const out = [];
  for (let i = 0; i < list.length; i += 20) {
    const batch = list.slice(i, i + 20);
    const url = 'https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=pageimages|extracts&piprop=thumbnail&pithumbsize=600&pilicense=any&exintro=1&explaintext=1&exsentences=3&exlimit=20&titles=' + encodeURIComponent(batch.map(m => m.title).join('|'));
    const r = await getJSON(url);
    const norm = {};
    for (const n of [...(r.query.normalized || []), ...(r.query.redirects || [])]) norm[n.to] = n.from;
    for (const p of Object.values(r.query.pages || {})) {
      const m = batch.find(x => x.title === p.title || x.title === norm[p.title] || x.title === norm[norm[p.title]]);
      if (!m || !p.thumbnail) continue;
      const w = p.thumbnail.width, h = p.thumbnail.height;
      if (h < w * 1.2) continue; // keep portrait posters only
      out.push({
        id: 'mv' + (m.imdb || m.title.replace(/\W+/g, '').toLowerCase()), kind: 'movie',
        title: m.title.replace(/ \((\d{4} )?(American |British )?(film|movie)\)$/, ''),
        year: m.year, genres: m.genres, rating: null, poster: p.thumbnail.source,
        overview: clip(p.extract || ''),
        meta: m.runtime ? `${Math.floor(m.runtime / 60)}h ${m.runtime % 60}m` : '',
        link: m.imdb ? `https://www.imdb.com/title/${m.imdb}/` : `https://en.wikipedia.org/wiki/${encodeURIComponent(m.title)}`,
        score: m.sl
      });
    }
    process.stdout.write(`\rmovies ${i + batch.length}/${list.length}, kept ${out.length}`);
    await sleep(1500);
  }
  console.log();
  return out;
}

const cache = new URL('../data/shows.cache.json', import.meta.url);
let s; try { s = JSON.parse(readFileSync(cache)); console.log('using cached shows'); } catch { s = await shows(); writeFileSync(cache, JSON.stringify(s)); }
const m = await movies();
const items = [...m, ...s].map(({ score, ...x }) => x);
writeFileSync(new URL('../data/catalog.json', import.meta.url), JSON.stringify({ built: new Date().toISOString().slice(0, 10), items }));

console.log(`wrote ${m.length} movies + ${s.length} shows`);
