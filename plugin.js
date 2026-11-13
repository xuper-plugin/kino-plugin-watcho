// @ts-check
/// <reference path="./kino.d.ts" />
// WATCHO: películas, series y anime de Netflix, HBO Max, Disney+, Prime Video y Apple TV+.
// Puente directo al add-on Stremio de WATCHO (watcho3.rafaelzioneverest.workers.dev).
// El manifest se lee en cada sesión y se cachea 12 h: si WATCHO cambia sus catálogos,
// el plugin lo recoge solo. No hay configuración ni mantenimiento.
//   1. constants   2. texts   3. cache   4. fetch   5. manifest
//   6. items   7. home/browse/section   8. episodes/details   9. search   10. resolve   11. settings

const BASE = "https://watcho3.rafaelzioneverest.workers.dev";
const MANIFEST_TTL_MS = 12 * 60 * 60 * 1000;
const CATALOG_TTL_MS = 15 * 60 * 1000;
const META_TTL_MS = 60 * 60 * 1000;
const HARD_TTL_MS = 24 * 60 * 60 * 1000;
const ENTRY_MAX_CHARS = 48 * 1024;
const ROW_MAX = 60;
const HOME_BUDGET_MS = 14000;

// ---- 1. texts -------------------------------------------------------------------------------------------------

const TEXTS = {
  es: {
    unavailable: "WATCHO no responde ahora. Intenta de nuevo en un rato.",
    noStreams: "Este título no tiene video disponible ahora. Prueba otro o vuelve más tarde.",
    noEpisodes: "No se encontraron episodios para este título.",
    cacheCleared: "Listo: se vació la caché.",
    cacheStatus: "Caché: {n} entradas, {kb} KB",
    tabMovies: "Películas",
    tabSeries: "Series",
    tabAnime: "Anime",
  },
  en: {
    unavailable: "WATCHO is not responding right now. Try again in a moment.",
    noStreams: "This title has no video available right now. Try another or come back later.",
    noEpisodes: "No episodes found for this title.",
    cacheCleared: "Done: the cache is empty.",
    cacheStatus: "Cache: {n} entries, {kb} KB",
    tabMovies: "Movies",
    tabSeries: "Series",
    tabAnime: "Anime",
  },
};

function isSpanish() {
  return String(kino.lang || "").toLowerCase().startsWith("es");
}

function t(key, vars) {
  const template = TEXTS[isSpanish() ? "es" : "en"][key] || TEXTS.es[key] || key;
  return vars ? template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] != null ? vars[k] : "")) : template;
}

// ---- 2. cache -------------------------------------------------------------------------------------------------

const PREFIX = "w1:";

function cacheKeys() {
  return kino.storage.keys().filter((k) => k.startsWith(PREFIX));
}

function cacheRead(key) {
  const raw = kino.storage.get(PREFIX + key);
  if (!raw) return null;
  try {
    const e = JSON.parse(raw);
    return e && typeof e.at === "number" ? e : null;
  } catch {
    kino.storage.remove(PREFIX + key);
    return null;
  }
}

function evictOldest() {
  let victim = null;
  let oldest = Infinity;
  for (const k of cacheKeys()) {
    let at = 0;
    try { at = JSON.parse(kino.storage.get(k) || "{}").at || 0; } catch {}
    if (at < oldest) { oldest = at; victim = k; }
  }
  if (!victim) return false;
  kino.storage.remove(victim);
  return true;
}

function cacheWrite(key, v) {
  const raw = JSON.stringify({ at: Date.now(), v });
  if (raw.length > ENTRY_MAX_CHARS) return;
  for (let tries = 0; tries < 20; tries++) {
    try { kino.storage.set(PREFIX + key, raw, { ttlMs: HARD_TTL_MS }); return; }
    catch (e) { if (!e || e.code !== "too_large" || !evictOldest()) return; }
  }
}

async function cached(key, freshMs, load) {
  const hit = cacheRead(key);
  if (hit && Date.now() - hit.at < freshMs) return hit.v;
  try {
    const v = await load();
    cacheWrite(key, v);
    return v;
  } catch (e) {
    if (hit) { kino.log("serving stale " + key + ": " + (e && e.message)); return hit.v; }
    throw e;
  }
}

// ---- 3. fetch -------------------------------------------------------------------------------------------------

async function getJson(path, timeoutMs = 15000) {
  let r;
  try {
    r = await kino.fetch(BASE + path, { timeoutMs });
  } catch (e) {
    throw kino.error("unavailable", "WATCHO fetch failed: " + (e && e.message), { userMessage: t("unavailable") });
  }
  if (!r.ok) {
    throw kino.error("unavailable", "WATCHO answered " + r.status, { userMessage: t("unavailable") });
  }
  return r.json();
}

// ---- 4. manifest -----------------------------------------------------------------------------------------------

async function getManifest() {
  return cached("manifest", MANIFEST_TTL_MS, () => getJson("/manifest.json"));
}

// ---- 5. items -------------------------------------------------------------------------------------------------

const MAX_ID = 128;
const IMDB_RE = /^tt\d{5,10}$/;

function kinoId(addonId) {
  const clean = String(addonId || "").replace(/:/g, "~").replace(/[^A-Za-z0-9._~-]/g, "-") || "unknown";
  if (clean.length <= MAX_ID) return clean;
  return clean.slice(0, MAX_ID - 9) + "-" + kino.crypto.hash("sha1", String(addonId)).slice(0, 8);
}

// WATCHO's types: "movie" → Kino "movie"; "series"/"anime" → Kino "series"
function kinoKind(type) {
  return type === "movie" ? "movie" : "series";
}

function metaToItem(m, type) {
  const id = String(m.id || "");
  if (!id) return null;
  const kind = kinoKind(type);
  const item = {
    id: kinoId(id),
    ref: (kind === "movie" ? "m:" : "i:") + id,
    title: String(m.name || m.title || "").trim().slice(0, 200) || "?",
    kind,
  };
  if (m.poster) item.poster = String(m.poster);
  if (m.year) item.year = String(m.year).slice(0, 4);
  if (m.description || m.overview) item.overview = String(m.description || m.overview).slice(0, 300);
  if (typeof m.imdbRating === "number" && m.imdbRating > 0) item.rating = m.imdbRating;
  return item;
}

function itemsOf(body, type) {
  return Array.isArray(body && body.metas)
    ? body.metas.map((m) => metaToItem(m, type)).filter(Boolean)
    : [];
}

// ---- 6. home, browse, section ---------------------------------------------------------------------------------

async function catalogPage(cat, skip = 0) {
  const url = `/catalog/${cat.type}/${cat.id}${skip > 0 ? "/skip=" + skip : ""}.json`;
  return itemsOf(await getJson(url, 12000), cat.type);
}

/** Runs jobs together and answers what has finished by `ms`. */
async function settleWithin(jobs, ms) {
  const out = new Array(jobs.length);
  const settled = jobs.map((job, i) => Promise.resolve().then(job).then((v) => { out[i] = v; }, () => {}));
  const all = Promise.all(settled).then(() => true);
  const deadline = Date.now() + ms;
  for (;;) {
    const left = Math.floor(deadline - Date.now());
    if (left <= 0) break;
    if (await Promise.race([all, kino.sleep(Math.min(5000, left)).then(() => false)])) break;
  }
  return out;
}

export async function home() {
  let catalogs;
  try { catalogs = (await getManifest()).catalogs || []; } catch { return []; }
  // First 6 catalogs go to Home (usually netflix_movies, hbo_max_movies, disney_movies, ...)
  const first = catalogs.slice(0, 6);
  const rows = (await settleWithin(first.map((cat) => async () => {
    try {
      const items = await cached(`cat:${cat.type}:${cat.id}`, CATALOG_TTL_MS, () => catalogPage(cat));
      if (!items.length) return null;
      return { id: `c-${cat.type}-${cat.id}`, title: cat.name, ref: `c:${cat.type}:${cat.id}`, items: items.slice(0, ROW_MAX) };
    } catch (e) {
      kino.log("home row " + cat.id + " failed: " + (e && e.message));
      return null;
    }
  }), HOME_BUDGET_MS)).filter(Boolean);
  return rows;
}

export async function browse(ref, cursor) {
  const m = /^c:(movie|series|anime|other):(.+)$/.exec(String(ref || ""));
  if (!m) throw kino.error("not_found", "unknown browse ref: " + String(ref).slice(0, 60));
  const [, type, id] = m;
  const skip = Math.max(0, parseInt(cursor || "0", 10) || 0);
  const items = skip === 0
    ? await cached(`cat:${type}:${id}`, CATALOG_TTL_MS, () => catalogPage({ type, id }))
    : await catalogPage({ type, id }, skip);
  const page = items.slice(0, 100);
  // If the page is full it likely has more; Stremio pages at 100-200 items typically
  return items.length >= 60 ? { items: page, next: String(skip + items.length) } : { items: page };
}

export async function section({ tab }) {
  let catalogs;
  try { catalogs = (await getManifest()).catalogs || []; } catch { return { tabs: [], rows: [] }; }
  const tabs = [
    { id: "movie", label: t("tabMovies") },
    { id: "series", label: t("tabSeries") },
    { id: "anime", label: t("tabAnime") },
  ];
  const chosen = tabs.some((x) => x.id === tab) ? tab : tabs[0].id;
  // "anime" maps to both "anime" and "other" types in WATCHO's manifest
  const relevant = catalogs.filter((c) =>
    chosen === "anime" ? (c.type === "anime" || c.type === "other") : c.type === chosen
  );
  const rows = (await Promise.all(relevant.map(async (cat) => {
    try {
      const items = await cached(`cat:${cat.type}:${cat.id}`, CATALOG_TTL_MS, () => catalogPage(cat));
      if (!items.length) return null;
      return { id: `c-${cat.type}-${cat.id}`, title: cat.name, ref: `c:${cat.type}:${cat.id}`, items: items.slice(0, ROW_MAX) };
    } catch (e) {
      kino.log("section row " + cat.id + " failed: " + (e && e.message));
      return null;
    }
  }))).filter(Boolean);
  return { tabs, tab: chosen, rows };
}

export async function categories() {
  let catalogs;
  try { catalogs = (await getManifest()).catalogs || []; } catch { return []; }
  return catalogs.slice(0, 24).map((cat) => ({
    id: `${cat.type}:${cat.id}`,
    title: String(cat.name || cat.id).slice(0, 40),
    ref: `c:${cat.type}:${cat.id}`,
  }));
}

// ---- 7. episodes, details -------------------------------------------------------------------------------------

function idFromRef(ref, prefix) {
  const s = String(ref || "");
  return s.startsWith(prefix) && s.length > prefix.length ? s.slice(prefix.length) : null;
}

async function metaOf(kinoType, id) {
  return cached(`meta:${kinoType}:${id}`, META_TTL_MS, async () => {
    if (typeof kino.meta !== "function") return null;
    let ids;
    if (IMDB_RE.test(id)) {
      ids = { imdb: id };
    } else {
      const tmdbM = /^tmdb:(\d{1,9})$/.exec(String(id));
      if (tmdbM) ids = { tmdb: parseInt(tmdbM[1], 10) };
      else return null; // kitsu: not supported by kino.meta
    }
    const m = await kino.meta({ type: kinoType, ids, lang: kino.lang });
    if (!m) return null;
    return {
      title: m.title || "",
      poster: m.poster || "",
      backdrop: m.backdrop || "",
      overview: String(m.overview || "").slice(0, 2000),
      genres: Array.isArray(m.genres) ? m.genres.slice(0, 5) : [],
      year: m.year || "",
      runtimeMinutes: m.runtimeMinutes || 0,
      episodes: (Array.isArray(m.episodes) ? m.episodes : []).map((e) => [
        Math.max(0, parseInt(e.season, 10) || 0),
        Math.max(1, parseInt(e.number, 10) || 1),
        String(e.title || "").slice(0, 120),
        String(e.overview || "").slice(0, 300),
        e.still || "",
        String(e.airDate || "").slice(0, 10),
      ]),
    };
  });
}

export async function episodes(ref) {
  const id = idFromRef(ref, "i:");
  if (!id) throw kino.error("not_found", "not a series ref: " + String(ref).slice(0, 80));
  const kinoType = /^kitsu:/.test(id) ? "series" : "series"; // kino.meta uses "series" for all
  const meta = await metaOf(kinoType, id);
  if (!meta || !meta.episodes.length) {
    throw kino.error("not_found", "no episodes for " + id.slice(0, 80), { userMessage: t("noEpisodes") });
  }
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set();
  const eps = [];
  for (const [season, number, title, overview, still, date] of meta.episodes.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    if (season < 1 || (/^\d{4}-\d{2}-\d{2}$/.test(date) && date > today)) continue;
    const key = season + ":" + number;
    if (seen.has(key)) continue;
    seen.add(key);
    const ep = { season, number, ref: `e:${id}:${season}:${number}` };
    if (title) ep.title = title;
    if (overview) ep.overview = overview;
    if (still) ep.still = still;
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) ep.airDate = date;
    eps.push(ep);
  }
  if (!eps.length) throw kino.error("not_found", "no aired episodes for " + id.slice(0, 80), { userMessage: t("noEpisodes") });
  const info = {};
  if (meta.title) info.title = meta.title;
  if (meta.poster) info.poster = meta.poster;
  if (meta.backdrop) info.backdrop = meta.backdrop;
  return { series: info, episodes: eps };
}

export async function details(ref) {
  const movie = idFromRef(ref, "m:");
  const id = movie || idFromRef(ref, "i:");
  if (!id) return null;
  if (/^kitsu:/.test(id)) return null; // kino.meta does not support kitsu ids
  try {
    const meta = await metaOf(movie ? "movie" : "series", id);
    if (!meta) return null;
    const info = {};
    if (meta.title) info.title = meta.title;
    if (meta.poster) info.poster = meta.poster;
    if (meta.backdrop) info.backdrop = meta.backdrop;
    if (meta.overview) info.overview = meta.overview;
    if (meta.genres && meta.genres.length) info.genres = meta.genres;
    if (meta.year) info.year = meta.year;
    if (movie && meta.runtimeMinutes) info.runtimeMinutes = meta.runtimeMinutes;
    return info;
  } catch (e) {
    kino.log("details failed: " + (e && e.message));
    return null;
  }
}

// ---- 8. search ------------------------------------------------------------------------------------------------

export async function search(query) {
  const q = kino.rank.shortQuery(String(query.q || "").trim());
  if (!q || typeof kino.tmdb !== "function") return [];
  const lang = isSpanish() ? "es-MX" : "en-US";
  const searches =
    query.type === "movie" ? [["movie", "movie"]] :
    query.type === "series" ? [["series", "tv"]] :
    [["movie", "movie"], ["series", "tv"]];
  const results = await Promise.all(searches.map(async ([stremioType, tmdbPath]) => {
    try {
      const body = await kino.tmdb("/search/" + tmdbPath, { query: q, language: lang, page: 1 });
      return (body.results || []).map((m) => {
        const tmdbId = "tmdb:" + m.id;
        const kind = kinoKind(stremioType);
        const item = {
          id: kinoId(tmdbId),
          ref: (kind === "movie" ? "m:" : "i:") + tmdbId,
          title: String(m.title || m.name || "").trim().slice(0, 200),
          kind,
        };
        if (m.poster_path) item.poster = "https://image.tmdb.org/t/p/w342" + m.poster_path;
        const year = /^(\d{4})/.exec(String(m.release_date || m.first_air_date || ""));
        if (year) item.year = year[1];
        if (m.overview) item.overview = String(m.overview).slice(0, 300);
        return item;
      }).filter((x) => x.title);
    } catch {
      return [];
    }
  }));
  // Interleave results (movie at index 0, series at index 0, movie at index 1, ...)
  const merged = [];
  const seen = new Set();
  const maxLen = Math.max(0, ...results.map((r) => r.length));
  for (let i = 0; i < maxLen; i++) {
    for (const r of results) {
      if (r[i] && !seen.has(r[i].id)) { seen.add(r[i].id); merged.push(r[i]); }
    }
  }
  return kino.rank.sortBySimilarity(merged, [query.q, query.originalTitle].filter((x) => typeof x === "string"));
}

// ---- 9. resolve -----------------------------------------------------------------------------------------------

const enc = encodeURIComponent;

export async function resolve(ref) {
  const movieId = idFromRef(ref, "m:");
  let path;
  if (movieId) {
    path = `/stream/movie/${enc(movieId)}.json`;
  } else {
    // episode ref: "e:{id}:{season}:{number}" where id may contain ":"
    const m = /^e:(.+):(\d{1,3}):(\d{1,5})$/.exec(String(ref || ""));
    if (!m) throw kino.error("not_found", "not a playable ref: " + String(ref).slice(0, 80));
    path = `/stream/series/${enc(`${m[1]}:${m[2]}:${m[3]}`)}.json`;
  }
  let body;
  try { body = await getJson(path, 15000); }
  catch (e) { throw kino.error("not_found", "WATCHO stream request failed: " + (e && e.message), { userMessage: t("noStreams") }); }
  const streams = Array.isArray(body.streams)
    ? body.streams.filter((s) => s && typeof s.url === "string" && /^https?:\/\//.test(s.url))
    : [];
  if (!streams.length) throw kino.error("not_found", "no streams for " + String(ref).slice(0, 80), { userMessage: t("noStreams") });
  const pick = streams[0];
  const result = { url: pick.url, expiresInSeconds: 1800 };
  // Forward proxy headers if present (Referer, Origin, User-Agent)
  const reqHeaders = (pick.behaviorHints && pick.behaviorHints.proxyHeaders && pick.behaviorHints.proxyHeaders.request) || {};
  const headers = {};
  for (const k of ["Referer", "Origin", "User-Agent"]) {
    if (typeof reqHeaders[k] === "string" && reqHeaders[k]) headers[k] = reqHeaders[k];
  }
  if (Object.keys(headers).length) result.headers = headers;
  if (streams.length > 1) {
    result.alternatives = streams.slice(1, 9).map((s) => {
      const alt = { url: s.url };
      if (s.title || s.name) alt.label = String(s.title || s.name).slice(0, 48);
      return alt;
    });
  }
  return result;
}

// ---- 10. settings ---------------------------------------------------------------------------------------------

export async function settingsStatus() {
  const keys = cacheKeys();
  let chars = 0;
  for (const k of keys) chars += k.length + (kino.storage.get(k) || "").length;
  return { info: t("cacheStatus", { n: keys.length, kb: Math.ceil(chars / 1024) }) };
}

export async function action(key) {
  if (key === "clearCache") {
    for (const k of cacheKeys()) kino.storage.remove(k);
    return { message: t("cacheCleared") };
  }
  throw kino.error("not_found", "unknown action: " + String(key).slice(0, 40));
}
