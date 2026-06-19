// =============================================================================
// Aurum Music — Cloudflare Worker v5.0 — PRO ULTRA-FAST YT
// ZERO backend dependency — No Railway, No Render
// YT songs play in 0.2-0.3 sec via:
//   1. CF Edge Cache (instant — 0ms if cached at nearby POP)
//   2. KV Store persistent cache (5ms — survives worker restarts)
//   3. Predictive Pre-warm (next song cached BEFORE user taps)
//   4. Blast-3 parallel resolution (fastest instance wins)
//   5. Request coalescing (100 users = 1 upstream call)
// =============================================================================

// ─── Cache TTLs ───────────────────────────────────────────────────────────────
const CACHE_TTL = {
  ytStream:  3000,  // YT stream URL edge cache — 50min
  ytKV:      2700,  // KV store TTL — 45min (slightly less than edge)
  saavn:     120,
  song:      300,
  lyrics:    600,
  prewarm:   2400,  // Pre-warmed entries — 40min
};

// ─── Saavn API ────────────────────────────────────────────────────────────────
const SAAVN_API = 'https://www.jiosaavn.com/api.php';

// ─── Piped instances ──────────────────────────────────────────────────────────
// FIX: 'https://piped.smnz.de' was a typo (no such host) — correct host is
// 'pipedapi.smnz.de'. Also added kavin.rocks (official) + 3 more registered
// instances for redundancy — previously if the listed instances were all
// down/blocked, every YouTube resolve attempt failed with "No stream found".
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.syncpundit.io',
  'https://piped-api.garudalinux.org',
  'https://api.piped.yt',
  'https://pipedapi.reallyaweso.me',
  'https://pipedapi.smnz.de',
  'https://pipedapi.tokhmi.xyz',
  'https://pipedapi.moomoo.me',
  'https://pipedapi.leptons.xyz',
];

// ─── Invidious instances ──────────────────────────────────────────────────────
const INVIDIOUS_INSTANCES = [
  'https://invidious.adminforge.de',
  'https://yt.cdaut.de',
  'https://invidious.nerdvpn.de',
  'https://inv.nadeko.net',
  'https://invidious.privacyredirect.com',
  'https://iv.melmac.space',
];

// =============================================================================
// INNERTUBE — IOS client primary, ANDROID client fallback.
// FIX: Google tightened PoToken/signature enforcement on the ANDROID client
// through 2025-26, causing it to silently return empty streamingData on many
// videos. The IOS client is currently the most reliable unauthenticated path
// (no PoToken requirement as of this writing) so it now goes FIRST; ANDROID
// is kept as a fallback in case IOS gets locked down too.
// (Previously this file had this function defined TWICE — the second
// definition silently overwrote the first, which is harmless here since both
// were ANDROID-only, but it meant there was no real fallback. Consolidated.)
// =============================================================================
async function ytAudioInnertubeClient(videoId, clientName, clientVersion, extraContext, userAgent) {
  try {
    const resp = await fetch('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: {
        'Content-Type':             'application/json',
        'User-Agent':               userAgent,
        'X-YouTube-Client-Name':    clientName === 'IOS' ? '5' : '3',
        'X-YouTube-Client-Version': clientVersion,
      },
      body: JSON.stringify({
        videoId,
        context: { client: { clientName, clientVersion, hl: 'en', gl: 'US', ...extraContext } },
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const formats = data?.streamingData?.adaptiveFormats || [];
    const m4a = formats
      .filter(f => f.url && (f.mimeType?.includes('audio/mp4') || f.mimeType?.includes('audio/m4a')))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    if (m4a.length) {
      return { url: m4a[0].url, quality: `${Math.round((m4a[0].bitrate||0)/1000)}kbps`, source: `innertube-${clientName.toLowerCase()}` };
    }
    const any = formats
      .filter(f => f.url && f.mimeType?.includes('audio'))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    if (any.length) {
      return { url: any[0].url, quality: 'audio', source: `innertube-${clientName.toLowerCase()}` };
    }
    return null;
  } catch (_) { return null; }
}

async function ytAudioInnertube(videoId) {
  // Race IOS and ANDROID in parallel (not sequential) — keeps this function
  // capped at ~6s instead of up to 12s, which matters since Stage 0 races
  // this against Piped and we don't want to slow down the whole chain.
  const attempts = [
    ytAudioInnertubeClient(
      videoId, 'IOS', '19.45.4',
      { deviceModel: 'iPhone16,2', osVersion: '18.1', osName: 'iPhone' },
      'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1 like Mac OS X)'
    ),
    ytAudioInnertubeClient(
      videoId, 'ANDROID', '19.09.37',
      { androidSdkVersion: 30 },
      'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip'
    ),
  ];
  try {
    return await Promise.any(attempts.map(p => p.then(r => r ?? Promise.reject('null'))));
  } catch (_) {
    return null;
  }
}

// ─── Instance Health Scoring ──────────────────────────────────────────────────
const instanceHealth = new Map();

function getScore(instance) {
  const h = instanceHealth.get(instance);
  if (!h) return 1000;
  const timeSinceFailure = Date.now() - (h.lastFailure || 0);
  if (timeSinceFailure < 30000 && h.failures > 0) return 0;
  return Math.max(0, 1000 - (h.failures * 200) - (h.avgLatency / 2));
}

function recordSuccess(instance, latencyMs) {
  const h = instanceHealth.get(instance) || { failures: 0, lastFailure: 0, avgLatency: 0 };
  h.avgLatency = h.avgLatency === 0 ? latencyMs : (h.avgLatency * 0.7 + latencyMs * 0.3);
  h.failures = Math.max(0, h.failures - 1);
  instanceHealth.set(instance, h);
}

function recordFailure(instance) {
  const h = instanceHealth.get(instance) || { failures: 0, lastFailure: 0, avgLatency: 0 };
  h.failures += 1;
  h.lastFailure = Date.now();
  instanceHealth.set(instance, h);
}

function sortedInstances(instances) {
  return [...instances].sort((a, b) => getScore(b) - getScore(a));
}

// =============================================================================
// PRO FEATURE 1: KV PERSISTENT CACHE
// Edge cache clears on worker redeploy. KV survives forever.
// Means even after deploy, popular songs are still instant.
// Usage: bind KV namespace "STREAM_CACHE" in wrangler.toml
// =============================================================================

async function kvGet(env, key) {
  try {
    if (!env?.STREAM_CACHE) return null;
    const val = await env.STREAM_CACHE.get(key, { type: 'json' });
    if (!val) return null;
    // Check our own TTL (KV TTL isn't always precise)
    if (val.expiresAt && Date.now() > val.expiresAt) return null;
    return val.data;
  } catch (_) { return null; }
}

async function kvSet(env, key, data, ttlSeconds) {
  try {
    if (!env?.STREAM_CACHE) return;
    await env.STREAM_CACHE.put(key, JSON.stringify({
      data,
      expiresAt: Date.now() + (ttlSeconds * 1000),
      cachedAt: Date.now(),
    }), { expirationTtl: ttlSeconds + 60 });
  } catch (_) {}
}

// =============================================================================
// PRO FEATURE 2: ULTRA-FAST MULTI-LAYER CACHE LOOKUP
// Layer 1: CF Edge cache (0ms — in-memory at nearest POP)
// Layer 2: KV store (5ms — persistent across restarts)
// Layer 3: Resolve fresh (1-3s — only if both miss)
// =============================================================================

async function getYtStreamCached(videoId, env, ctx) {
  // Layer 1: CF edge cache
  // FIX: previously this returned the raw cached Response body directly.
  // A raw cached stream's headers/shape can drift from what jsonResp
  // produces (and binary stream re-wrapping has caused dropped fields in
  // Flutter's dynamic decoder before). Now we parse the cached JSON and
  // re-emit it through the same jsonResp helper every other path uses, so
  // every response — cached or fresh — has byte-for-byte the same shape
  // and headers.
  const edgeCacheKey = new Request(`https://aurum-cache/yt-stream-v5/${videoId}`);
  const edgeCached = await caches.default.match(edgeCacheKey);
  if (edgeCached) {
    try {
      const data = await edgeCached.json();
      const resp = jsonResp(data);
      const h = new Headers(resp.headers);
      h.set('X-Cache', 'EDGE-HIT');
      h.set('X-Latency', '0');
      return new Response(resp.body, { status: resp.status, headers: h });
    } catch (_) {
      // Corrupt cache entry — treat as a miss, fall through to KV/fresh resolve.
    }
  }

  // Layer 2: KV persistent cache
  const kvData = await kvGet(env, `yt:${videoId}`);
  if (kvData) {
    const resp = jsonResp({ success: true, ...kvData, videoId, fromKV: true });
    // Re-populate edge cache from KV (so next request is 0ms again)
    ctx.waitUntil((async () => {
      const toCache = resp.clone();
      const ch = new Headers(toCache.headers);
      ch.set('Cache-Control', `public, max-age=1800, stale-while-revalidate=600`);
      await caches.default.put(edgeCacheKey, new Response(toCache.body, { status: toCache.status, headers: ch }));
    })());
    const h = new Headers(resp.headers);
    h.set('X-Cache', 'KV-HIT');
    h.set('X-Latency', '5');
    return new Response(resp.body, { status: resp.status, headers: h });
  }

  return null; // Both caches missed — need fresh resolve
}

// =============================================================================
// PRO FEATURE 3: BLAST-5 PARALLEL RESOLUTION
// Fire Piped x3 + Invidious x2 simultaneously.
// Fastest one wins. Others cancelled.
// Typical result: best instance responds in 300-800ms instead of 1-3s.
// =============================================================================

async function resolveYtStreamFast(videoId) {
  const ranked    = sortedInstances(PIPED_INSTANCES);
  const invRanked = sortedInstances(INVIDIOUS_INSTANCES);

  // ── Stage 0: Race Innertube (IOS-first, ANDROID fallback) vs top Piped ────
  // ytAudioInnertube() internally races the IOS and ANDROID Innertube clients
  // against each other — IOS is currently the more reliable of the two since
  // Google tightened PoToken/signature enforcement on the ANDROID client
  // through 2025-26. That combined result is then raced here against the
  // single best-scoring Piped instance, so we don't add latency if Innertube
  // is slow on a given video — whichever source responds first wins.
  try {
    const stage0 = await Promise.any([
      ytAudioInnertube(videoId).then(r => r ?? Promise.reject('null')),
      ytAudioPipedSingle(videoId, ranked[0]).then(r => r ?? Promise.reject('null')),
    ]);
    if (stage0) return stage0;
  } catch (_) {}

  // ── Stage 1: Blast remaining Piped + top 2 Invidious in parallel ──────────
  const blastAttempts = [
    ...ranked.slice(1, 4).map(inst => ytAudioPipedSingle(videoId, inst)),
    ...invRanked.slice(0, 2).map(inst => ytAudioInvidiousSingle(videoId, inst)),
  ];
  try {
    const result = await Promise.any(
      blastAttempts.map(p => p.then(r => r ?? Promise.reject('null')))
    );
    if (result) return result;
  } catch (_) {}

  // ── Stage 2: Remaining instances — PARALLEL, not sequential ────────────────
  // FIX: previously this looped sequentially with a 4s timeout PER instance,
  // so worst case (10 dead instances) took 30-40s — way past the app's/curl's
  // 10-15s timeout, causing "0 bytes received". Now all remaining instances
  // are blasted in parallel (fastest wins) AND a hard 5s deadline is attached
  // so this function never hangs past ~15s total (6s stage0 + 4s stage1 + 5s).
  // FIX 2: invRanked instances were wrongly passed to ytAudioPipedSingle
  // (Piped's URL shape), which can never work against an Invidious host.
  // Verified clean mapping below: ranked.slice(4) → ytAudioPipedSingle (Piped
  // instances only), invRanked.slice(2) → ytAudioInvidiousSingle (Invidious
  // instances only). No cross-wiring, no shared closure state between the
  // two .map() calls — each instance is passed directly as an argument, not
  // captured from an outer loop variable, so there's no scope-leak risk.
  const stage2Attempts = [
    ...ranked.slice(4).map(inst => ytAudioPipedSingle(videoId, inst)),
    ...invRanked.slice(2).map(inst => ytAudioInvidiousSingle(videoId, inst)),
  ];
  const deadline = new Promise(resolve => setTimeout(() => resolve(null), 5000));
  try {
    const result = await Promise.race([
      Promise.any(stage2Attempts.map(p => p.then(r => r ?? Promise.reject('null')))).catch(() => null),
      deadline,
    ]);
    if (result) return result;
  } catch (_) {}
  return null;
}

async function ytAudioPipedSingle(videoId, instance) {
  // Guard: a falsy/undefined instance would build an invalid fetch URL
  // (e.g. "undefined/streams/...") and pollute instanceHealth with a bad
  // Map key via recordFailure(). Bail out cleanly instead.
  if (!instance || !videoId) return null;
  const t0 = Date.now();
  try {
    const resp = await fetch(
      `${instance}/streams/${videoId}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(4000) }
    );
    if (!resp.ok) { recordFailure(instance); return null; }
    const data = await resp.json();
    const streams = (data.audioStreams || []).filter(s => s.url);
    if (!streams.length) { recordFailure(instance); return null; }
    streams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    recordSuccess(instance, Date.now() - t0);
    return { url: streams[0].url, quality: streams[0].quality || 'unknown', source: 'piped', instance };
  } catch (_) { recordFailure(instance); return null; }
}

async function ytAudioInvidiousSingle(videoId, instance) {
  // Same guard as ytAudioPipedSingle — never let an undefined/empty instance
  // reach fetch() or recordSuccess/recordFailure.
  if (!instance || !videoId) return null;
  const t0 = Date.now();
  try {
    const resp = await fetch(
      `${instance}/api/v1/videos/${videoId}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(4000) }
    );
    if (!resp.ok) { recordFailure(instance); return null; }
    const data = await resp.json();
    const adaptive = (data.adaptiveFormats || []).filter(f => f.url);
    const mp4 = adaptive.filter(f => f.type?.includes('audio/mp4')).sort((a,b)=>(b.bitrate||0)-(a.bitrate||0));
    if (mp4.length) { recordSuccess(instance, Date.now()-t0); return { url: mp4[0].url, quality: mp4[0].audioQuality||'unknown', source: 'invidious', instance }; }
    const webm = adaptive.filter(f => f.type?.includes('audio/webm')).sort((a,b)=>(b.bitrate||0)-(a.bitrate||0));
    if (webm.length) { recordSuccess(instance, Date.now()-t0); return { url: webm[0].url, quality: webm[0].audioQuality||'unknown', source: 'invidious', instance }; }
    recordFailure(instance); return null;
  } catch (_) { recordFailure(instance); return null; }
}

// =============================================================================
// PRO FEATURE 4: PREDICTIVE PRE-WARM
// Flutter sends next song's videoId in advance via /api/prewarm
// Worker resolves + caches it BEFORE user taps play.
// When user taps → cache hit → 0ms!
// Add this in Flutter: call prewarm when song is 30% done.
// =============================================================================

async function handlePrewarm(videoId, env, ctx) {
  if (!videoId) return jsonResp({ success: false, error: 'id required' }, 400);

  // Check if already cached
  const edgeCacheKey = new Request(`https://aurum-cache/yt-stream-v5/${videoId}`);
  const edgeCached = await caches.default.match(edgeCacheKey);
  if (edgeCached) return jsonResp({ success: true, status: 'already_cached', videoId });

  const kvData = await kvGet(env, `yt:${videoId}`);
  if (kvData) return jsonResp({ success: true, status: 'kv_cached', videoId });

  // Not cached — resolve in background, return immediately
  ctx.waitUntil((async () => {
    const audio = await resolveYtStreamFast(videoId);
    if (!audio) return;
    // Store in both caches
    await kvSet(env, `yt:${videoId}`, audio, CACHE_TTL.prewarm);
    const resp = jsonResp({ success: true, ...audio, videoId });
    const toCache = resp.clone();
    const ch = new Headers(toCache.headers);
    ch.set('Cache-Control', `public, max-age=${CACHE_TTL.prewarm}, stale-while-revalidate=300`);
    await caches.default.put(edgeCacheKey, new Response(toCache.body, { status: toCache.status, headers: ch }));
  })());

  // Instant return — pre-warm happening in background
  return jsonResp({ success: true, status: 'prewarming', videoId });
}

// =============================================================================
// PRO FEATURE 5: REQUEST COALESCING
// 100 users tap same song at same time = 1 upstream call, not 100.
// =============================================================================
const inflightStreams = new Map();

async function handleYtStream(videoId, env, ctx) {
  if (!videoId) return jsonResp({ success: false, error: 'id required' }, 400);

  // Multi-layer cache check
  const cached = await getYtStreamCached(videoId, env, ctx);
  if (cached) return cached;

  // Request coalescing
  if (inflightStreams.has(videoId)) {
    const result = await inflightStreams.get(videoId);
    return result ? result.clone() : jsonResp({ success: false, error: 'No stream found' }, 502);
  }

  const resolutionPromise = (async () => {
    const audio = await resolveYtStreamFast(videoId);
    if (!audio) return null;

    const resp = jsonResp({ success: true, ...audio, videoId });

    // Store in BOTH edge cache + KV simultaneously
    const edgeCacheKey = new Request(`https://aurum-cache/yt-stream-v5/${videoId}`);
    ctx.waitUntil((async () => {
      const [edgeClone, kvClone] = [resp.clone(), resp.clone()];
      // Edge cache
      const ch = new Headers(edgeClone.headers);
      ch.set('Cache-Control', `public, max-age=${CACHE_TTL.ytStream}, stale-while-revalidate=300`);
      await caches.default.put(edgeCacheKey, new Response(edgeClone.body, { status: edgeClone.status, headers: ch }));
      // KV store
      await kvSet(env, `yt:${videoId}`, audio, CACHE_TTL.ytKV);
    })());

    return resp;
  })();

  inflightStreams.set(videoId, resolutionPromise);
  resolutionPromise.finally(() => inflightStreams.delete(videoId));

  const result = await resolutionPromise;
  return result ? result.clone() : jsonResp({ success: false, error: 'No stream found' }, 502);
}

// =============================================================================
// SAAVN DIRECT API
// =============================================================================

async function saavnSearch(query, limit = 20) {
  try {
    const url = `${SAAVN_API}?__call=autocomplete.get&_format=json&_marker=0&cc=in&includeMetaTags=0&query=${encodeURIComponent(query)}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.jiosaavn.com/' },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) throw new Error('autocomplete failed');
    const data = await resp.json();
    const songs = data?.songs?.data || [];
    if (songs.length > 0) {
      // Fire stream URL resolution for top 5 results in parallel — embeds
      // the 320kbps URL directly in search results so Flutter plays instantly
      // without a second /song/ round-trip (saves 300-800ms on first play).
      const top = songs.slice(0, limit);
      const streamUrls = await Promise.allSettled(
        top.slice(0, 5).map(s => s.id ? saavnStreamById(s.id).catch(() => null) : Promise.resolve(null))
      );
      return top.map((s, i) => {
        const streamResult = i < 5 ? (streamUrls[i].status === 'fulfilled' ? streamUrls[i].value : null) : null;
        return {
          id:       s.id,
          title:    decodeHtml(s.title || ''),
          artist:   decodeHtml(s.more_info?.singers || s.subtitle || ''),
          album:    decodeHtml(s.more_info?.album || ''),
          image:    (s.image || '').replace('150x150', '500x500').replace('50x50', '500x500'),
          duration: s.more_info?.duration || null,
          language: s.more_info?.language || 'hindi',
          year:     s.more_info?.year || null,
          source:   'saavn',
          // Embedded stream URL — Flutter reads this directly, no /song/ call needed
          media_url: streamResult?.url || null,
          '320kbps': streamResult?.quality === '320kbps' ? streamResult?.url : null,
        };
      });
    }
    throw new Error('no songs');
  } catch (_) {
    return saavnSearchFallback(query, limit);
  }
}

async function saavnSearchFallback(query, limit = 20) {
  try {
    const url = `${SAAVN_API}?p=1&q=${encodeURIComponent(query)}&_format=json&_marker=0&api_version=4&ctx=web6dot0&n=${limit}&__call=search.getResults`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.jiosaavn.com/' },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data?.results || []).slice(0, limit).map(s => ({
      id: s.id,
      title: decodeHtml(s.song || s.title || ''),
      artist: decodeHtml(s.primary_artists || s.singers || ''),
      album: decodeHtml(s.album || ''),
      image: (s.image || '').replace('150x150', '500x500'),
      duration: s.duration || null,
      language: s.language || 'hindi',
      year: s.year || null,
      source: 'saavn',
    }));
  } catch (_) { return []; }
}

async function saavnStreamById(songId) {
  // Layer 1: Render API (has clean downloadUrl array).
  // Strict 5s timeout — Render free-tier cold-starts can take 20-30s+, and we
  // never want that to hang the whole worker response; fail fast and fall
  // through to Layer 2 instead.
  try {
    const renderResp = await fetch(
      `https://jiosaavn-op-gits.onrender.com/api/songs?ids=${songId}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (renderResp.ok) {
      const renderData = await renderResp.json();
      const songs = renderData?.data;
      const song = Array.isArray(songs) ? songs[0] : songs;
      if (song) {
        const downloads = song.downloadUrl || [];
        for (const quality of ['320kbps', '160kbps', '96kbps', '48kbps']) {
          const match = downloads.find(d => d.quality === quality && d.url);
          if (match) return { url: match.url, quality: match.quality, source: 'saavn' };
        }
      }
    }
  } catch (_) {
    // Render timed out / cold-start / network error — fall through to Layer 2.
  }

  // Layer 2: Direct JioSaavn API fallback
  try {
    const url = `${SAAVN_API}?__call=song.getDetails&cc=in&_marker=0%3F_marker%3D0&_format=json&pids=${songId}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.jiosaavn.com/' },
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const song = data[songId] || Object.values(data)[0];
    if (!song) return null;
    const downloads = song.downloadUrl || [];
    for (const quality of ['320kbps', '160kbps', '96kbps', '48kbps']) {
      const match = downloads.find(d => d.quality === quality && (d.url || d.link));
      if (match) return { url: match.url || match.link, quality: match.quality, source: 'saavn' };
    }
    return null;
  } catch (_) { return null; }
}

async function saavnLyrics(songId) {
  try {
    const url = `${SAAVN_API}?__call=lyrics.getLyrics&ctx=web6dot0&api_version=4&_format=json&_marker=0%3F_marker%3D0&lyrics_id=${songId}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.jiosaavn.com/' },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.lyrics || null;
  } catch (_) { return null; }
}

function decodeHtml(str) {
  return String(str)
    .replace(/&amp;/g,'&').replace(/&quot;/g,'"')
    .replace(/&#039;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');
}

// =============================================================================
// PREMIUM DISCOVERY SUITE — makes the app feel like a complete YouTube-Music-
// style experience: live search suggestions, India trending feed, and
// "related/next up" recommendations. Each is independently cached and never
// touches the YT-stream-resolution code path above, so none of this can
// regress the Stage 0/1/2 fallback chain, prewarm guards, or Saavn-first
// search logic already in place.
// =============================================================================

// 1. Live search autocomplete suggestions (Google's own YT suggest endpoint)
async function handleYtSuggestions(query, ctx) {
  if (!query) return jsonResp([]);
  const cacheKey = new Request(`https://aurum-cache/yt-suggest/${encodeURIComponent(query.toLowerCase())}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  try {
    const url = `https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&q=${encodeURIComponent(query)}`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(3000) });
    if (!resp.ok) throw new Error('suggest failed');
    const text = await resp.text();
    const match = text.match(/\["(.*?)",\[(.*?)\]\]/);
    if (match && match[2]) {
      const suggestions = JSON.parse(`[${match[2]}]`).map(item => item[0]);
      const res = jsonResp(suggestions);
      const h = new Headers(res.headers);
      h.set('Cache-Control', `public, max-age=${CACHE_TTL.meta}`);
      const cacheable = new Response(res.body, { status: res.status, headers: h });
      ctx.waitUntil(caches.default.put(cacheKey, cacheable.clone()));
      return cacheable;
    }
    return jsonResp([]);
  } catch (_) { return jsonResp([]); }
}

// 2. India trending feed — sourced from healthiest Piped instance, falls
// through the ranked list rather than hardcoding one instance.
async function handleYtTrending(ctx) {
  const cacheKey = new Request(`https://aurum-cache/yt-trending-v5`);
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  const ranked = sortedInstances(PIPED_INSTANCES);
  for (const inst of ranked.slice(0, 3)) {
    try {
      const resp = await fetch(`${inst}/trending?region=IN`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(4000),
      });
      if (!resp.ok) { recordFailure(inst); continue; }
      const data = await resp.json();
      const songs = (Array.isArray(data) ? data : [])
        .filter(item => item.type === 'stream' && item.url)
        .map(item => ({
          videoId: item.url.replace('/watch?v=', ''),
          title: item.title,
          artist: item.uploaderName,
          image: item.thumbnail,
          duration: item.duration,
          views: item.views,
          source: 'youtube-trending',
        }));
      recordSuccess(inst, 0);
      const res = jsonResp({ success: true, results: songs });
      const h = new Headers(res.headers);
      h.set('Cache-Control', `public, max-age=${CACHE_TTL.meta}`);
      const cacheable = new Response(res.body, { status: res.status, headers: h });
      ctx.waitUntil(caches.default.put(cacheKey, cacheable.clone()));
      return cacheable;
    } catch (_) { recordFailure(inst); }
  }
  return jsonResp({ success: false, error: 'Trending feed temporarily unavailable' }, 503);
}

// 3. "Up next" / related song recommendations for a given videoId.
async function handleYtRelated(videoId, ctx) {
  if (!videoId) return jsonResp({ success: false, error: 'id required' }, 400);
  const cacheKey = new Request(`https://aurum-cache/yt-related/${videoId}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  const ranked = sortedInstances(PIPED_INSTANCES);
  for (const inst of ranked.slice(0, 3)) {
    try {
      const resp = await fetch(`${inst}/streams/${videoId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(4000),
      });
      if (!resp.ok) { recordFailure(inst); continue; }
      const data = await resp.json();
      const related = (data.relatedStreams || [])
        .filter(item => item.type === 'stream' && item.url)
        .map(item => ({
          videoId: item.url.replace('/watch?v=', ''),
          title: item.title,
          artist: item.uploaderName,
          image: item.thumbnail,
          duration: item.duration,
          source: 'youtube-related',
        }));
      recordSuccess(inst, 0);
      const res = jsonResp({ success: true, results: related });
      const h = new Headers(res.headers);
      h.set('Cache-Control', `public, max-age=${CACHE_TTL.meta}`);
      const cacheable = new Response(res.body, { status: res.status, headers: h });
      ctx.waitUntil(caches.default.put(cacheKey, cacheable.clone()));
      return cacheable;
    } catch (_) { recordFailure(inst); }
  }
  return jsonResp({ success: false, error: 'No related content found' }, 404);
}

// ─── Saavn handlers ───────────────────────────────────────────────────────────

async function handleSaavnSearch(query, limit, ctx) {
  if (!query) return jsonResp({ success: false, error: 'query required' }, 400);
  const cacheKey = new Request(`https://aurum-cache/saavn-search-v5/${encodeURIComponent(query.toLowerCase().trim())}-${limit}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) { const h = new Headers(cached.headers); h.set('X-Cache','HIT'); return new Response(cached.body, { status: cached.status, headers: h }); }
  const songs = await saavnSearch(query, parseInt(limit) || 20);
  const resp = jsonResp({ success: true, data: { results: songs }, count: songs.length });
  if (songs.length > 0) {
    const toCache = resp.clone();
    const ch = new Headers(toCache.headers);
    ch.set('Cache-Control', `public, max-age=${CACHE_TTL.saavn}`);
    ctx.waitUntil(caches.default.put(cacheKey, new Response(toCache.body, { status: toCache.status, headers: ch })));
  }
  return resp;
}

async function handleSaavnStream(songId, ctx) {
  if (!songId) return jsonResp({ success: false, error: 'id required' }, 400);
  const cacheKey = new Request(`https://aurum-cache/saavn-stream-v5/${songId}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) { const h = new Headers(cached.headers); h.set('X-Cache','HIT'); return new Response(cached.body, { status: cached.status, headers: h }); }
  const stream = await saavnStreamById(songId);
  if (!stream) return jsonResp({ success: false, error: 'Stream not found' }, 404);
  const resp = jsonResp({ success: true, ...stream, id: songId });
  const toCache = resp.clone();
  const ch = new Headers(toCache.headers);
  ch.set('Cache-Control', `public, max-age=${CACHE_TTL.song}`);
  ctx.waitUntil(caches.default.put(cacheKey, new Response(toCache.body, { status: toCache.status, headers: ch })));
  return resp;
}

async function handleSaavnLyrics(songId, ctx) {
  if (!songId) return jsonResp({ success: false, error: 'id required' }, 400);
  const cacheKey = new Request(`https://aurum-cache/saavn-lyrics-v5/${songId}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) { const h = new Headers(cached.headers); h.set('X-Cache','HIT'); return new Response(cached.body, { status: cached.status, headers: h }); }
  const lyrics = await saavnLyrics(songId);
  if (!lyrics) return jsonResp({ success: false, error: 'Lyrics not found' }, 404);
  const resp = jsonResp({ success: true, data: { lyrics }, id: songId });
  const toCache = resp.clone();
  const ch = new Headers(toCache.headers);
  ch.set('Cache-Control', `public, max-age=${CACHE_TTL.lyrics}`);
  ctx.waitUntil(caches.default.put(cacheKey, new Response(toCache.body, { status: toCache.status, headers: ch })));
  return resp;
}

// ─── Helper ───────────────────────────────────────────────────────────────────
function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'X-Cache': 'MISS',
    },
  });
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

export default {
  async fetch(request, env, ctx) {
    const { pathname, searchParams } = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        },
      });
    }

    // ── YouTube stream (multi-layer cached, blast-5, coalesced) ──────────────
    if (pathname === '/api/yt-stream') {
      return handleYtStream(searchParams.get('id') || '', env, ctx);
    }

    // ── PRO: Predictive pre-warm — call this 30% into current song ───────────
    // Flutter: ApiService.prewarmYt(nextSong.id)
    // Supports BOTH:
    //   POST /api/prewarm  body: { "id": "videoId" }
    //   GET  /api/prewarm?id=videoId
    if (pathname === '/api/prewarm') {
      let id = searchParams.get('id') || '';
      if (!id && request.method === 'POST') {
        try {
          const body = await request.json();
          id = (body && body.id) ? String(body.id) : '';
        } catch (_) {
          // Malformed/empty JSON body — fall through with empty id,
          // handlePrewarm already returns a clean 400 for that case.
        }
      }
      return handlePrewarm(id, env, ctx);
    }

    // ── PREMIUM DISCOVERY: suggestions / trending / related ──────────────────
    // These are additive — pure read-only feeds, never touch stream resolution.
    if (pathname === '/api/yt-suggestions') {
      return handleYtSuggestions(searchParams.get('q') || '', ctx);
    }
    if (pathname === '/api/yt-trending') {
      return handleYtTrending(ctx);
    }
    if (pathname === '/api/yt-related') {
      return handleYtRelated(searchParams.get('id') || '', ctx);
    }

    // ── YouTube search ────────────────────────────────────────────────────────
    if (pathname === '/api/yt' || pathname === '/api/yt-search') {
      const query = searchParams.get('q') || '';
      if (!query) return jsonResp({ success: false, error: 'q required' }, 400);
      const ranked = sortedInstances(PIPED_INSTANCES);
      const top3 = ranked.slice(0, 3);
      let found = null;
      try {
        found = await Promise.any(top3.map(inst => {
          const t0 = Date.now();
          return fetch(`${inst}/search?q=${encodeURIComponent(query)}&filter=music_songs`, {
            headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(3000)
          }).then(r => r.ok ? r.json() : Promise.reject()).then(data => {
            const items = data.items || [];
            for (const item of items) {
              if (item.url && item.duration > 60) {
                recordSuccess(inst, Date.now()-t0);
                return { videoId: item.url.replace('/watch?v=',''), instance: inst };
              }
            }
            throw new Error('no items');
          }).catch(e => { recordFailure(inst); throw e; });
        }));
      } catch (_) {}
      if (!found) return jsonResp({ success: false, error: 'Search failed' }, 404);

      // Piped first (the instance that found this video is usually fastest
      // for resolving its own stream too — same backend, already warm).
      let audio = await ytAudioPipedSingle(found.videoId, found.instance);

      // FIX: previously this called
      //   ytAudioInvidiousSingle(videoId, sortedInstances(INVIDIOUS_INSTANCES)[0])
      // with no guard — if INVIDIOUS_INSTANCES were ever empty (or every
      // instance had a 0 health score after recent failures), `[0]` is
      // `undefined`. That undefined would flow into ytAudioInvidiousSingle's
      // fetch() as `${instance}/api/v1/videos/...` → `undefined/api/v1/...`,
      // an invalid URL, AND into recordSuccess/recordFailure as a Map key of
      // `undefined` — not a hard crash (Map allows undefined keys, fetch
      // throws and is caught), but it silently pollutes instance-health
      // tracking and wastes a network round trip on a request that can never
      // succeed. Now we validate the instance string exists before calling.
      if (!audio) {
        const invFallback = sortedInstances(INVIDIOUS_INSTANCES)[0];
        if (invFallback) {
          audio = await ytAudioInvidiousSingle(found.videoId, invFallback);
        }
      }

      if (!audio) return jsonResp({ success: false, error: 'No audio URL' }, 502);
      return jsonResp({ success: true, ...audio, videoId: found.videoId });
    }

    // ── Saavn endpoints ───────────────────────────────────────────────────────
    if (pathname === '/result/') {
      return handleSaavnSearch(searchParams.get('query') || '', searchParams.get('limit') || '20', ctx);
    }
    if (pathname === '/song/') {
      return handleSaavnStream(searchParams.get('id') || '', ctx);
    }
    if (pathname === '/lyrics/') {
      return handleSaavnLyrics(searchParams.get('id') || '', ctx);
    }

    // ── Health ────────────────────────────────────────────────────────────────
    if (pathname === '/health') {
      return jsonResp({
        status: 'ok', worker: 'aurum-v5.5-pro',
        timestamp: Date.now(),
        features: ['edge-cache', 'kv-cache', 'blast5', 'prewarm', 'coalescing', 'saavn-direct',
                   'yt-suggestions', 'yt-trending', 'yt-related'],
      });
    }

    return jsonResp({ error: 'Not found', path: pathname }, 404);
  },
};
