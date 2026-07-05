// =============================================================================
// Aurum Music — Cloudflare Worker v6.0 — 2026 BULLETPROOF ENGINE
// =============================================================================
//
// YT Resolution Stack (in order of priority):
//
//   STAGE 1 — android_sdkless client (v20.10.38)
//             PoToken nahi chahiye — yt-dlp confirmed working Jan 2026
//             clientName: ANDROID, no SDK, fastest resolution
//
//   STAGE 2 — ios_downgraded client (v19.29.1)
//             Fallback iOS client, still works without PoToken
//
//   STAGE 3 — WEB_EMBEDDED_PLAYER client
//             Embedded context = looser bot detection, HLS available
//
//   STAGE 4 — Piped blast race (10 instances simultaneously)
//
//   STAGE 5 — Invidious blast race (6 instances simultaneously)
//
// All 5 stages run in parallel where possible. First valid URL wins.
// Instance health tracking skips dead endpoints automatically.
// KV + Edge cache = zero resolve cost on repeated plays.
// =============================================================================

const CACHE_TTL = {
  ytStream:  3000,   // 50 min edge cache
  ytKV:      2700,   // 45 min KV
  saavn:     120,
  song:      300,
  lyrics:    600,
  prewarm:   2400,
};

const SAAVN_API = 'https://www.jiosaavn.com/api.php';

// ─── visitorData ─────────────────────────────────────────────────────────
// PREVIOUSLY MISSING from every client context below. YouTube's innertube
// API uses this field as a session-identity token — a request with no
// visitorData looks anonymous/scripted in a way a real client's request
// never would (real clients always carry one, assigned on first contact
// with YouTube). Confirmed present in every working client context used
// by ViMusic (github.com/vfsfitvnm/ViMusic, an actively-maintained YT
// Music client with a good reliability track record). This is a static
// placeholder value, not tied to any real session — it's not meant to
// authenticate anything, just to make the request shape match what a
// real client sends instead of omitting the field entirely.
const YT_VISITOR_DATA = 'CgtEUlRINDFjdm1YayjX1pSaBg%3D%3D';

// ─── X-Goog-Api-Key ──────────────────────────────────────────────────────
// PREVIOUSLY MISSING. This is the public API key that YouTube Music's own
// web client (music.youtube.com) sends on every innertube request —
// confirmed present in ViMusic's Innertube.kt (defaultRequest block,
// header "X-Goog-Api-Key"). Requests to the innertube endpoint without
// this header are missing a piece every real client includes, which is
// one more small signal (on top of visitorData) that distinguishes a
// scripted request from a real client's request.
const YT_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

// ─── Piped instances (verified live via status.piped.video, 2026-07) ────────
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://piped-api.lunar.icu',
  'https://yapi.vyper.me',
  'https://api.looleh.xyz',
];

// ─── Invidious instances (from official api.invidious.io list, 2026-07) ────
const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://iv.melmac.space',
  'https://yewtu.be',
  'https://yt.artemislena.eu',
  'https://invidious.flokinet.to',
  'https://invidious.privacydev.net',
];

// =============================================================================
// STAGE 1: android_sdkless — No PoToken required (yt-dlp confirmed 2026)
// =============================================================================
async function ytAndroidSdkless(videoId) {
  try {
    const resp = await fetch('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: {
        'Content-Type':             'application/json',
        'X-Goog-Api-Key':           YT_API_KEY,
        'User-Agent':               'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
        'X-YouTube-Client-Name':    '3',
        'X-YouTube-Client-Version': '20.10.38',
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName:       'ANDROID',
            clientVersion:    '20.10.38',
            osName:           'Android',
            osVersion:        '11',
            androidSdkVersion: 30,
            hl: 'en', gl: 'US', visitorData: YT_VISITOR_DATA,
          },
        },
      }),
      signal: AbortSignal.timeout(7000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const result = _extractBestAudio(data, 'android_sdkless');
    if (result) return result;
    // NEW: this client's response can still carry usable muxed formats
    // even when adaptiveFormats comes back empty/blocked.
    return _extractMuxed(data, 'android_sdkless_muxed');
  } catch (_) { return null; }
}

// =============================================================================
// STAGE 2: ios_downgraded — Fallback iOS client without PoToken
// =============================================================================
async function ytIosDowngraded(videoId) {
  try {
    const resp = await fetch('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: {
        'Content-Type':             'application/json',
        'X-Goog-Api-Key':           YT_API_KEY,
        'User-Agent':               'com.google.ios.youtube/19.29.1 (iPhone14,3; U; CPU iOS 17_5_1 like Mac OS X)',
        'X-YouTube-Client-Name':    '5',
        'X-YouTube-Client-Version': '19.29.1',
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName:    'IOS',
            clientVersion: '19.29.1',
            deviceModel:   'iPhone14,3',
            osName:        'iPhone',
            osVersion:     '17.5.1.21F90',
            hl: 'en', gl: 'US', visitorData: YT_VISITOR_DATA,
          },
        },
      }),
      signal: AbortSignal.timeout(7000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const result = _extractBestAudio(data, 'ios_downgraded');
    if (result) return result;
    return _extractMuxed(data, 'ios_downgraded_muxed');
  } catch (_) { return null; }
}

// =============================================================================
// STAGE 3: WEB_EMBEDDED_PLAYER — Looser bot detection, no PoToken for player
// =============================================================================
async function ytWebEmbedded(videoId) {
  try {
    const resp = await fetch('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: {
        'Content-Type':             'application/json',
        'X-Goog-Api-Key':           YT_API_KEY,
        'User-Agent':               'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'X-YouTube-Client-Name':    '56',
        'X-YouTube-Client-Version': '1.20240516.00.00',
        'Origin':                   'https://www.youtube.com',
        'Referer':                  `https://www.youtube.com/embed/${videoId}`,
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName:    'WEB_EMBEDDED_PLAYER',
            clientVersion: '1.20240516.00.00',
            hl: 'en', gl: 'US', visitorData: YT_VISITOR_DATA,
          },
          thirdParty: {
            embedUrl: 'https://www.youtube.com/',
          },
        },
      }),
      signal: AbortSignal.timeout(7000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    // WEB_EMBEDDED can return HLS (m3u8) — try that first, no PoToken needed for GVS
    const hlsUrl = data?.streamingData?.hlsManifestUrl;
    if (hlsUrl) {
      return { url: hlsUrl, quality: 'hls', source: 'web_embedded_hls', isHls: true };
    }
    const result = _extractBestAudio(data, 'web_embedded');
    if (result) return result;
    return _extractMuxed(data, 'web_embedded_muxed');
  } catch (_) { return null; }
}

// =============================================================================
// STAGE 4 (legacy): Old IOS client — kept as last innertube attempt
// =============================================================================
async function ytLegacyIos(videoId) {
  try {
    const resp = await fetch('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: {
        'Content-Type':             'application/json',
        'X-Goog-Api-Key':           YT_API_KEY,
        'User-Agent':               'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1 like Mac OS X)',
        'X-YouTube-Client-Name':    '5',
        'X-YouTube-Client-Version': '19.45.4',
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName:    'IOS',
            clientVersion: '19.45.4',
            deviceModel:   'iPhone16,2',
            osName:        'iPhone',
            osVersion:     '18.1',
            hl: 'en', gl: 'US', visitorData: YT_VISITOR_DATA,
          },
        },
      }),
      signal: AbortSignal.timeout(7000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const result = _extractBestAudio(data, 'ios_legacy');
    if (result) return result;
    return _extractMuxed(data, 'ios_legacy_muxed');
  } catch (_) { return null; }
}

// =============================================================================
// STAGE: ANDROID_VR — confirmed (yt-dlp, Jan-Mar 2026 maintenance commits) as
// one of the few clients that still works WITHOUT a PoToken.
// =============================================================================
async function ytAndroidVr(videoId) {
  try {
    const resp = await fetch('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: {
        'Content-Type':             'application/json',
        'X-Goog-Api-Key':           YT_API_KEY,
        'User-Agent':               'com.google.android.apps.youtube.vr.oculus/1.71.26 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
        'X-YouTube-Client-Name':    '28',
        'X-YouTube-Client-Version': '1.71.26',
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName:        'ANDROID_VR',
            clientVersion:     '1.71.26',
            deviceMake:        'Oculus',
            deviceModel:       'Quest 3',
            androidSdkVersion: 32,
            osName:            'Android',
            osVersion:         '12L',
            hl: 'en', gl: 'US', visitorData: YT_VISITOR_DATA,
          },
        },
      }),
      signal: AbortSignal.timeout(7000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const result = _extractBestAudio(data, 'android_vr');
    if (result) return result;
    return _extractMuxed(data, 'android_vr_muxed');
  } catch (_) { return null; }
}

// =============================================================================
// STAGE: TV_EMBEDDED — TVHTML5_SIMPLY_EMBEDDED_PLAYER client.
// Sourced from ViMusic (github.com/vfsfitvnm/ViMusic), where it's used
// specifically as an age-restriction/bot-detection bypass path — a
// genuinely different client identity from every other stage here (none
// of the above use the TV surface). Kept as an independent stage in the
// race rather than replacing anything, since no single client identity
// has proven permanently reliable — the point is more independent paths,
// not swapping one for another.
// =============================================================================
async function ytTvEmbedded(videoId) {
  try {
    const resp = await fetch('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: {
        'Content-Type':             'application/json',
        'X-Goog-Api-Key':           YT_API_KEY,
        'X-YouTube-Client-Name':    '85',
        'X-YouTube-Client-Version': '2.0',
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName:    'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
            clientVersion: '2.0',
            platform:      'TV',
            hl: 'en', gl: 'US', visitorData: YT_VISITOR_DATA,
          },
          thirdParty: {
            embedUrl: `https://www.youtube.com/watch?v=${videoId}`,
          },
        },
      }),
      signal: AbortSignal.timeout(7000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const result = _extractBestAudio(data, 'tv_embedded');
    if (result) return result;
    return _extractMuxed(data, 'tv_embedded_muxed');
  } catch (_) { return null; }
}

// ─── Audio extraction helper (adaptive, audio-only) ──────────────────────────
function _extractBestAudio(data, source) {
  const status = data?.playabilityStatus?.status;
  if (status === 'LOGIN_REQUIRED' || status === 'ERROR') return null;

  const formats = data?.streamingData?.adaptiveFormats || [];
  if (!formats.length) return null;

  const m4a = formats
    .filter(f => f.url && (f.mimeType?.includes('audio/mp4') || f.mimeType?.includes('audio/m4a')))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  if (m4a.length) {
    return {
      url:     m4a[0].url,
      quality: `${Math.round((m4a[0].bitrate || 0) / 1000)}kbps`,
      source,
      mime:    m4a[0].mimeType,
      isMuxed: false,
    };
  }

  const anyAudio = formats
    .filter(f => f.url && f.mimeType?.includes('audio'))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  if (anyAudio.length) {
    return {
      url:     anyAudio[0].url,
      quality: `${Math.round((anyAudio[0].bitrate || 0) / 1000)}kbps`,
      source,
      mime:    anyAudio[0].mimeType,
      isMuxed: false,
    };
  }
  return null;
}

// =============================================================================
// NEW: muxed (progressive, video+audio combined) format extraction.
//
// WHY THIS EXISTS: adaptiveFormats (audio-only) is the format YouTube's
// bot-detection scrutinizes hardest, because it's the format used almost
// exclusively by non-browser API clients (exactly what we are). Legacy
// muxed/progressive formats (itag 18 = 360p, itag 22 = 720p, both
// video+audio in ONE stream) are still served for basic/legacy playback
// compatibility and historically face looser scrutiny.
//
// This is a genuine fallback, not a guarantee — YouTube can and does
// throttle/restrict these too. It's an additional independent path to
// race alongside the audio-only ones, not a replacement for them.
//
// The client (ExoPlayer/Media3) is responsible for decoding audio-only
// out of this stream (disable the video track renderer) — see
// AurumAudioEngine.kt trackSelector config. We do NOT strip video here;
// stripping video server-side would mean re-muxing/transcoding on the
// Worker, which Cloudflare Workers cannot do (no ffmpeg, CPU-time limited).
// =============================================================================
function _extractMuxed(data, source) {
  const status = data?.playabilityStatus?.status;
  if (status === 'LOGIN_REQUIRED' || status === 'ERROR') return null;

  const muxed = data?.streamingData?.formats || [];
  if (!muxed.length) return null;

  // Prefer itag 22 (720p, better audio bitrate ~192kbps) then itag 18
  // (360p, ~96kbps) — both carry audio, fall back to whatever's biggest.
  const byItag = (itag) => muxed.find(f => f.itag === itag && f.url);
  const best = byItag(22) || byItag(18) ||
    [...muxed].filter(f => f.url).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

  if (!best) return null;
  return {
    url:     best.url,
    quality: `muxed-${best.qualityLabel || best.itag}`,
    source,
    mime:    best.mimeType,
    isMuxed: true,
  };
}

// =============================================================================
// Instance health tracker (in-memory, resets per worker instance)
// =============================================================================
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
  h.failures   = Math.max(0, h.failures - 1);
  instanceHealth.set(instance, h);
}

function recordFailure(instance) {
  const h = instanceHealth.get(instance) || { failures: 0, lastFailure: 0, avgLatency: 0 };
  h.failures++;
  h.lastFailure = Date.now();
  instanceHealth.set(instance, h);
}

function sortedInstances(instances) {
  return [...instances].sort((a, b) => getScore(b) - getScore(a));
}

// =============================================================================
// Piped + Invidious fetchers
// =============================================================================
async function ytAudioPipedSingle(videoId, instance) {
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
    return { url: streams[0].url, quality: streams[0].quality || 'unknown', source: 'piped', instance, isMuxed: false };
  } catch (_) { recordFailure(instance); return null; }
}

async function ytAudioInvidiousSingle(videoId, instance) {
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
    const mp4 = adaptive.filter(f => f.type?.includes('audio/mp4')).sort((a, b) => (b.bitrate||0) - (a.bitrate||0));
    if (mp4.length) { recordSuccess(instance, Date.now()-t0); return { url: mp4[0].url, quality: mp4[0].audioQuality||'unknown', source: 'invidious', instance, isMuxed: false }; }
    const webm = adaptive.filter(f => f.type?.includes('audio/webm')).sort((a, b) => (b.bitrate||0) - (a.bitrate||0));
    if (webm.length) { recordSuccess(instance, Date.now()-t0); return { url: webm[0].url, quality: webm[0].audioQuality||'unknown', source: 'invidious', instance, isMuxed: false }; }
    // NEW: Invidious also exposes formatStreams (muxed) — try before giving up
    const muxedList = (data.formatStreams || []).filter(f => f.url);
    if (muxedList.length) {
      muxedList.sort((a, b) => (parseInt(b.itag)||0) - (parseInt(a.itag)||0));
      recordSuccess(instance, Date.now()-t0);
      return { url: muxedList[0].url, quality: `muxed-${muxedList[0].quality||muxedList[0].itag}`, source: 'invidious_muxed', instance, isMuxed: true };
    }
    recordFailure(instance); return null;
  } catch (_) { recordFailure(instance); return null; }
}

// =============================================================================
// MAIN RESOLUTION ENGINE v6.1 — now races muxed formats alongside audio-only
// Parallel race — first valid, LIVE URL wins.
// =============================================================================
async function resolveYtStreamFast(videoId) {
  const ranked    = sortedInstances(PIPED_INSTANCES);
  const invRanked = sortedInstances(INVIDIOUS_INSTANCES);

  async function validated(p) {
    const r = await p;
    if (!r || !r.url) return null;
    const ok = await isUrlAlive(r.url);
    return ok ? r : null;
  }

  const allAttempts = [
    validated(ytAndroidSdkless(videoId)),
    validated(ytAndroidVr(videoId)),
    validated(ytIosDowngraded(videoId)),
    validated(ytWebEmbedded(videoId)),
    validated(ytLegacyIos(videoId)),
    validated(ytTvEmbedded(videoId)),
    ...ranked.map(inst => validated(ytAudioPipedSingle(videoId, inst))),
    ...invRanked.map(inst => validated(ytAudioInvidiousSingle(videoId, inst))),
  ].map(p => p.then(r => r ?? Promise.reject('null')).catch(e => Promise.reject(e)));

  try {
    return await Promise.any(allAttempts);
  } catch (_) {
    return null;
  }
}

async function isUrlAlive(url) {
  try {
    const head = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(2500),
    });
    if (head.ok) return true;
    if (head.status === 405 || head.status === 403) {
      const ranged = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-1023' },
        signal: AbortSignal.timeout(2500),
      });
      return ranged.ok || ranged.status === 206;
    }
    return false;
  } catch (_) {
    return false;
  }
}

// =============================================================================
// KV Cache helpers
// =============================================================================
async function kvGet(env, key) {
  try {
    if (!env?.STREAM_CACHE) return null;
    const val = await env.STREAM_CACHE.get(key, { type: 'json' });
    if (!val) return null;
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
      cachedAt:  Date.now(),
    }), { expirationTtl: ttlSeconds + 60 });
  } catch (_) {}
}

// =============================================================================
// Edge + KV cache lookup
// =============================================================================
async function getYtStreamCached(videoId, env, ctx) {
  const edgeCacheKey = new Request(`https://aurum-cache/yt-stream-v6/${videoId}`);
  const edgeCached = await caches.default.match(edgeCacheKey);
  if (edgeCached) {
    try {
      const data = await edgeCached.json();
      if (data?.url && await isUrlAlive(data.url)) {
        const resp = jsonResp(data);
        const h = new Headers(resp.headers);
        h.set('X-Cache', 'EDGE-HIT');
        h.set('X-Latency', '0');
        return new Response(resp.body, { status: resp.status, headers: h });
      }
      ctx.waitUntil(caches.default.delete(edgeCacheKey));
    } catch (_) {}
  }

  const kvData = await kvGet(env, `yt:${videoId}`);
  if (kvData?.url) {
    if (await isUrlAlive(kvData.url)) {
      const resp = jsonResp({ success: true, ...kvData, videoId, fromKV: true });
      const h = new Headers(resp.headers);
      h.set('X-Cache', 'KV-HIT');
      return new Response(resp.body, { status: resp.status, headers: h });
    }
    ctx.waitUntil(env?.STREAM_CACHE ? env.STREAM_CACHE.delete(`yt:${videoId}`) : Promise.resolve());
  }

  return null;
}

// =============================================================================
// Request coalescing — prevents thundering herd on cache miss
// =============================================================================
const inflightStreams = new Map();

async function handleYtStream(videoId, env, ctx) {
  if (!videoId) return jsonResp({ success: false, error: 'id required' }, 400);

  const cached = await getYtStreamCached(videoId, env, ctx);
  if (cached) return cached;

  if (inflightStreams.has(videoId)) {
    const result = await inflightStreams.get(videoId);
    return result ? result.clone() : jsonResp({ success: false, error: 'No stream found' }, 502);
  }

  const resolutionPromise = (async () => {
    let audio = await resolveYtStreamFast(videoId);

    if (!audio) {
      await new Promise(r => setTimeout(r, 400 + Math.floor(Math.random() * 200)));
      audio = await resolveYtStreamFast(videoId);
    }

    if (!audio) return null;

    const resp = jsonResp({ success: true, ...audio, videoId });

    const edgeCacheKey = new Request(`https://aurum-cache/yt-stream-v6/${videoId}`);
    ctx.waitUntil((async () => {
      const [edgeClone, kvClone] = [resp.clone(), resp.clone()];
      const ch = new Headers(edgeClone.headers);
      ch.set('Cache-Control', `public, max-age=${CACHE_TTL.ytStream}, stale-while-revalidate=300`);
      await caches.default.put(edgeCacheKey, new Response(edgeClone.body, { status: edgeClone.status, headers: ch }));
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
// Prewarm endpoint — called by Flutter app for next song
// =============================================================================
async function handlePrewarm(videoId, env, ctx) {
  if (!videoId) return jsonResp({ success: false, error: 'id required' }, 400);

  const edgeCacheKey = new Request(`https://aurum-cache/yt-stream-v6/${videoId}`);
  const edgeCached = await caches.default.match(edgeCacheKey);
  if (edgeCached) return jsonResp({ success: true, status: 'already_cached', videoId });

  const kvData = await kvGet(env, `yt:${videoId}`);
  if (kvData) return jsonResp({ success: true, status: 'kv_cached', videoId });

  ctx.waitUntil((async () => {
    const audio = await resolveYtStreamFast(videoId);
    if (!audio) return;
    await kvSet(env, `yt:${videoId}`, audio, CACHE_TTL.prewarm);
    const resp = jsonResp({ success: true, ...audio, videoId });
    const toCache = resp.clone();
    const ch = new Headers(toCache.headers);
    ch.set('Cache-Control', `public, max-age=${CACHE_TTL.prewarm}, stale-while-revalidate=300`);
    await caches.default.put(edgeCacheKey, new Response(toCache.body, { status: toCache.status, headers: ch }));
  })());

  return jsonResp({ success: true, status: 'prewarming', videoId });
}

// =============================================================================
// Saavn helpers (unchanged from v5.2)
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
      id:       s.id,
      title:    decodeHtml(s.song || s.title || ''),
      artist:   decodeHtml(s.primary_artists || s.singers || ''),
      album:    decodeHtml(s.album || ''),
      image:    (s.image || '').replace('150x150', '500x500'),
      duration: s.duration || null,
      language: s.language || 'hindi',
      year:     s.year || null,
      source:   'saavn',
    }));
  } catch (_) { return []; }
}

async function saavnStreamById(songId) {
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
  } catch (_) {}

  try {
    const url = `${SAAVN_API}?__call=song.getDetails&cc=in&_marker=0%3F_marker%3D0&_format=json&pids=${songId}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.jiosaavn.com/' },
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const songData = data?.[songId];
    if (!songData) return null;
    const downloads = songData.more_info?.['320kbps'] ? [
      { quality: '320kbps', url: songData.more_info['320kbps'] }
    ] : [];
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
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// =============================================================================
// YT Search, Suggestions, Trending, Related (unchanged from v5.2)
// =============================================================================
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
      h.set('Cache-Control', `public, max-age=300`);
      const cacheable = new Response(res.body, { status: res.status, headers: h });
      ctx.waitUntil(caches.default.put(cacheKey, cacheable.clone()));
      return cacheable;
    }
    return jsonResp([]);
  } catch (_) { return jsonResp([]); }
}

async function handleYtTrending(ctx) {
  const cacheKey = new Request(`https://aurum-cache/yt-trending-v6`);
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
          videoId:  item.url.replace('/watch?v=', ''),
          title:    item.title,
          artist:   item.uploaderName,
          image:    item.thumbnail,
          duration: item.duration,
          views:    item.views,
          source:   'youtube-trending',
        }));
      recordSuccess(inst, 0);
      const res = jsonResp({ success: true, results: songs });
      const h = new Headers(res.headers);
      h.set('Cache-Control', `public, max-age=300`);
      const cacheable = new Response(res.body, { status: res.status, headers: h });
      ctx.waitUntil(caches.default.put(cacheKey, cacheable.clone()));
      return cacheable;
    } catch (_) { recordFailure(inst); }
  }
  return jsonResp({ success: false, error: 'Trending feed temporarily unavailable' }, 503);
}

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
          videoId:  item.url.replace('/watch?v=', ''),
          title:    item.title,
          artist:   item.uploaderName,
          image:    item.thumbnail,
          duration: item.duration,
          source:   'youtube-related',
        }));
      recordSuccess(inst, 0);
      const res = jsonResp({ success: true, results: related });
      const h = new Headers(res.headers);
      h.set('Cache-Control', `public, max-age=300`);
      const cacheable = new Response(res.body, { status: res.status, headers: h });
      ctx.waitUntil(caches.default.put(cacheKey, cacheable.clone()));
      return cacheable;
    } catch (_) { recordFailure(inst); }
  }
  return jsonResp({ success: false, error: 'No related content found' }, 404);
}

async function handleSaavnStream(songId, ctx) {
  if (!songId) return jsonResp({ success: false, error: 'id required' }, 400);
  const cacheKey = new Request(`https://aurum-cache/saavn-stream-v7/${songId}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const h = new Headers(cached.headers);
    h.set('X-Cache', 'HIT');
    return new Response(cached.body, { status: cached.status, headers: h });
  }
  const stream = await saavnStreamById(songId);
  if (!stream) return jsonResp({ success: false, error: 'Stream not found' }, 404);
  const resp = jsonResp({ success: true, ...stream, url: stream.url, id: songId });
  const toCache = resp.clone();
  const ch = new Headers(toCache.headers);
  ch.set('Cache-Control', `public, max-age=${CACHE_TTL.song}`);
  ctx.waitUntil(caches.default.put(cacheKey, new Response(toCache.body, { status: toCache.status, headers: ch })));
  return resp;
}

async function handleSaavnSearch(query, limit, ctx) {
  if (!query) return jsonResp({ success: false, error: 'query required' }, 400);
  const cacheKey = new Request(`https://aurum-cache/saavn-search-v5/${encodeURIComponent(query.toLowerCase().trim())}-${limit}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const h = new Headers(cached.headers);
    h.set('X-Cache', 'HIT');
    return new Response(cached.body, { status: cached.status, headers: h });
  }
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

async function handleSaavnLyrics(songId, ctx) {
  if (!songId) return jsonResp({ success: false, error: 'id required' }, 400);
  const cacheKey = new Request(`https://aurum-cache/saavn-lyrics-v5/${songId}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const h = new Headers(cached.headers);
    h.set('X-Cache', 'HIT');
    return new Response(cached.body, { status: cached.status, headers: h });
  }
  const lyrics = await saavnLyrics(songId);
  if (!lyrics) return jsonResp({ success: false, error: 'Lyrics not found' }, 404);
  const resp = jsonResp({ success: true, data: { lyrics }, id: songId });
  const toCache = resp.clone();
  const ch = new Headers(toCache.headers);
  ch.set('Cache-Control', `public, max-age=${CACHE_TTL.lyrics}`);
  ctx.waitUntil(caches.default.put(cacheKey, new Response(toCache.body, { status: toCache.status, headers: ch })));
  return resp;
}

async function handleStreamProxy(request, encodedUrl, ctx) {
  if (!encodedUrl) return jsonResp({ success: false, error: 'url required' }, 400);
  let upstreamUrl;
  try {
    upstreamUrl = decodeURIComponent(encodedUrl);
    const host = new URL(upstreamUrl).hostname;
    if (!host.endsWith('saavncdn.com')) {
      return jsonResp({ success: false, error: 'host not allowed' }, 403);
    }
  } catch (_) {
    return jsonResp({ success: false, error: 'invalid url' }, 400);
  }
  const rangeHeader = request.headers.get('Range');
  const upstream = await fetch(upstreamUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', ...(rangeHeader ? { 'Range': rangeHeader } : {}) },
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  if (!upstream || (!upstream.ok && upstream.status !== 206)) {
    return jsonResp({ success: false, error: `upstream ${upstream?.status ?? 'timeout'}` }, 502);
  }
  const contentType   = upstream.headers.get('Content-Type') || 'audio/mp4';
  const contentLength = upstream.headers.get('Content-Length');
  const contentRange  = upstream.headers.get('Content-Range');
  const headers = new Headers();
  headers.set('Content-Type', contentType);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Cache-Control', 'public, max-age=3600');
  if (contentLength) headers.set('Content-Length', contentLength);
  if (contentRange)  headers.set('Content-Range', contentRange);
  return new Response(upstream.body, { status: upstream.status === 206 ? 206 : 200, headers });
}

// =============================================================================
// Debug endpoint v6.1 — tests all resolution stages individually, incl. muxed
// =============================================================================
async function handleDebugYt(videoId) {
  const report = {};

  try {
    const t0 = Date.now();
    const r = await ytAndroidSdkless(videoId);
    report.android_sdkless = { ok: !!r, ms: Date.now() - t0, source: r?.source, quality: r?.quality, isMuxed: r?.isMuxed };
  } catch (e) { report.android_sdkless = { ok: false, error: String(e) }; }

  try {
    const t0 = Date.now();
    const r = await ytIosDowngraded(videoId);
    report.ios_downgraded = { ok: !!r, ms: Date.now() - t0, source: r?.source, quality: r?.quality, isMuxed: r?.isMuxed };
  } catch (e) { report.ios_downgraded = { ok: false, error: String(e) }; }

  try {
    const t0 = Date.now();
    const r = await ytWebEmbedded(videoId);
    report.web_embedded = { ok: !!r, ms: Date.now() - t0, source: r?.source, quality: r?.quality, isHls: r?.isHls, isMuxed: r?.isMuxed };
  } catch (e) { report.web_embedded = { ok: false, error: String(e) }; }

  try {
    const t0 = Date.now();
    const r = await ytLegacyIos(videoId);
    report.ios_legacy = { ok: !!r, ms: Date.now() - t0, source: r?.source, quality: r?.quality, isMuxed: r?.isMuxed };
  } catch (e) { report.ios_legacy = { ok: false, error: String(e) }; }

  try {
    const t0 = Date.now();
    const r = await ytAndroidVr(videoId);
    report.android_vr = { ok: !!r, ms: Date.now() - t0, source: r?.source, quality: r?.quality, isMuxed: r?.isMuxed };
  } catch (e) { report.android_vr = { ok: false, error: String(e) }; }

  try {
    const t0 = Date.now();
    const r = await ytTvEmbedded(videoId);
    report.tv_embedded = { ok: !!r, ms: Date.now() - t0, source: r?.source, quality: r?.quality, isMuxed: r?.isMuxed };
  } catch (e) { report.tv_embedded = { ok: false, error: String(e) }; }

  report.piped = [];
  for (const inst of PIPED_INSTANCES) {
    const t0 = Date.now();
    try {
      const resp = await fetch(`${inst}/streams/${videoId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000),
      });
      const status = resp.status;
      let streamCount = null;
      if (resp.ok) {
        const data = await resp.json();
        streamCount = (data.audioStreams || []).length;
      }
      report.piped.push({ instance: inst, status, ms: Date.now() - t0, audioStreams: streamCount });
    } catch (e) {
      report.piped.push({ instance: inst, error: String(e), ms: Date.now() - t0 });
    }
  }

  report.invidious = [];
  for (const inst of INVIDIOUS_INSTANCES) {
    const t0 = Date.now();
    try {
      const resp = await fetch(`${inst}/api/v1/videos/${videoId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000),
      });
      const status = resp.status;
      let formatCount = null;
      let muxedCount = null;
      if (resp.ok) {
        const data = await resp.json();
        formatCount = (data.adaptiveFormats || []).length;
        muxedCount  = (data.formatStreams || []).length;
      }
      report.invidious.push({ instance: inst, status, ms: Date.now() - t0, adaptiveFormats: formatCount, muxedFormats: muxedCount });
    } catch (e) {
      report.invidious.push({ instance: inst, error: String(e), ms: Date.now() - t0 });
    }
  }

  return jsonResp({ success: true, videoId, workerVersion: 'v6.1', report });
}

// =============================================================================
// YT Search endpoint
// =============================================================================
async function handleYtSearch(query, ctx) {
  if (!query) return jsonResp({ success: false, error: 'q required' }, 400);
  const ranked = sortedInstances(PIPED_INSTANCES);
  const top3 = ranked.slice(0, 3);
  let found = null;
  try {
    found = await Promise.any(top3.map(inst => {
      const t0 = Date.now();
      return fetch(`${inst}/search?q=${encodeURIComponent(query)}&filter=music_songs`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(3000),
      }).then(r => r.ok ? r.json() : Promise.reject()).then(data => {
        const items = data.items || [];
        for (const item of items) {
          if (item.url && item.duration > 60) {
            recordSuccess(inst, Date.now() - t0);
            return { videoId: item.url.replace('/watch?v=', ''), instance: inst };
          }
        }
        throw new Error('no items');
      }).catch(e => { recordFailure(inst); throw e; });
    }));
  } catch (_) {}
  if (!found) return jsonResp({ success: false, error: 'Search failed' }, 404);
  let audio = await ytAudioPipedSingle(found.videoId, found.instance);
  if (!audio) audio = await ytAndroidSdkless(found.videoId);
  if (!audio) audio = await ytIosDowngraded(found.videoId);
  if (!audio) {
    const invFallback = sortedInstances(INVIDIOUS_INSTANCES)[0];
    if (invFallback) audio = await ytAudioInvidiousSingle(found.videoId, invFallback);
  }
  if (!audio) return jsonResp({ success: false, error: 'No audio URL' }, 502);
  return jsonResp({ success: true, ...audio, videoId: found.videoId });
}

// =============================================================================
// Response helper
// =============================================================================
function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'X-Cache': 'MISS',
      'X-Worker-Version': 'v6.1',
    },
  });
}


// =============================================================================
// YT PROXY — pipes googlevideo bytes through Cloudflare edge
// =============================================================================
async function handleYtProxy(videoId, request, env, ctx) {
  if (!videoId) return new Response('id required', { status: 400 });

  let audioUrl = null;

  const kvData = await kvGet(env, `yt:${videoId}`);
  if (kvData?.url) {
    audioUrl = kvData.url;
  } else {
    const audio = await resolveYtStreamFast(videoId);
    if (!audio?.url) return new Response('Could not resolve stream', { status: 502 });
    audioUrl = audio.url;
    ctx.waitUntil(kvSet(env, `yt:${videoId}`, audio, CACHE_TTL.ytKV));
  }

  const rangeHeader = request.headers.get('Range');
  const upstream = await fetch(audioUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36',
      ...(rangeHeader ? { 'Range': rangeHeader } : {}),
    },
    signal: AbortSignal.timeout(30000),
  }).catch(() => null);

  if (!upstream || (!upstream.ok && upstream.status !== 206)) {
    const audio = await resolveYtStreamFast(videoId);
    if (!audio?.url) return new Response('Stream unavailable', { status: 502 });
    ctx.waitUntil(kvSet(env, `yt:${videoId}`, audio, CACHE_TTL.ytKV));
    const retry = await fetch(audio.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36',
        ...(rangeHeader ? { 'Range': rangeHeader } : {}),
      },
      signal: AbortSignal.timeout(30000),
    }).catch(() => null);
    if (!retry || (!retry.ok && retry.status !== 206)) {
      return new Response('Stream unavailable after retry', { status: 502 });
    }
    return proxyAudioResponse(retry, rangeHeader);
  }

  return proxyAudioResponse(upstream, rangeHeader);
}

function proxyAudioResponse(upstream, rangeHeader) {
  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('Content-Type') || 'audio/mp4');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Cache-Control', 'public, max-age=3600');
  const contentLength = upstream.headers.get('Content-Length');
  const contentRange  = upstream.headers.get('Content-Range');
  if (contentLength) headers.set('Content-Length', contentLength);
  if (contentRange)  headers.set('Content-Range', contentRange);
  return new Response(upstream.body, {
    status: upstream.status === 206 ? 206 : 200,
    headers,
  });
}

// =============================================================================
// Main router
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

    if (pathname === '/api/yt-stream')      return handleYtStream(searchParams.get('id') || '', env, ctx);
    if (pathname === '/api/yt-proxy')       return handleYtProxy(searchParams.get('id') || '', request, env, ctx);
    if (pathname === '/api/debug-yt')       return handleDebugYt(searchParams.get('id') || 'dQw4w9WgXcQ');
    if (pathname === '/api/prewarm') {
      let id = searchParams.get('id') || '';
      if (!id && request.method === 'POST') {
        try { const body = await request.json(); id = (body?.id) ? String(body.id) : ''; } catch (_) {}
      }
      return handlePrewarm(id, env, ctx);
    }
    if (pathname === '/api/yt-suggestions') return handleYtSuggestions(searchParams.get('q') || '', ctx);
    if (pathname === '/api/yt-trending')    return handleYtTrending(ctx);
    if (pathname === '/api/yt-related')     return handleYtRelated(searchParams.get('id') || '', ctx);
    if (pathname === '/api/yt' || pathname === '/api/yt-search') return handleYtSearch(searchParams.get('q') || '', ctx);

    if (pathname === '/result/')       return handleSaavnSearch(searchParams.get('query') || '', searchParams.get('limit') || '20', ctx);
    if (pathname === '/song/')         return handleSaavnStream(searchParams.get('id') || '', ctx);
    if (pathname === '/lyrics/')       return handleSaavnLyrics(searchParams.get('id') || '', ctx);
    if (pathname === '/stream-proxy')  return handleStreamProxy(request, searchParams.get('url') || '', ctx);

    if (pathname === '/health') {
      return jsonResp({
        status: 'ok',
        worker: 'aurum-v6.1-muxed-fallback',
        timestamp: Date.now(),
        ytClients: ['android_sdkless', 'android_vr', 'ios_downgraded', 'web_embedded', 'ios_legacy', 'tv_embedded', 'piped_blast', 'invidious_blast'],
        features: ['edge-cache', 'kv-cache', 'request-coalescing', 'prewarm', 'saavn-direct-cdn', 'yt-suggestions', 'yt-trending', 'yt-related', 'muxed-fallback', 'visitor-data'],
      });
    }

    return jsonResp({ error: 'Not found', path: pathname }, 404);
  },
};
