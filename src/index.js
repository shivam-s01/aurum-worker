// =============================================================================
// Aurum Music — Cloudflare Worker — YT resolution
// (Updated 2026-07-07 v2: fixes the resolve-time blowup from the previous
//  version. Root cause of "Resolve failed... page needs to be reloaded":
//  POT_FETCH_TIMEOUT_MS was 45000 (45s) and this ran as the FIRST, BLOCKING
//  step of every single resolve. Render's free tier cold-starts in 30-50s,
//  so on a cold PO Token provider, EVERY resolve waited up to 45s before
//  even trying android_vr — then still had android_vr(3 retries) + ios +
//  tv + piped(4 instances) stacked AFTER that. Worst case ~90+ seconds for
//  one song. The app-side timeout/reload was firing before the Worker even
//  finished, which is exactly the symptom in the screenshot.
//
//  Fixes in this version:
//   1. PO Token fetch is capped at POT_FETCH_TIMEOUT_MS = 3000 (3s), not
//      45s. If the provider is cold/asleep, we skip it for THIS request
//      and fall through to the no-PoToken chain immediately — a slow POT
//      provider degrades to "old behavior for this one request," not
//      "block everything."
//   2. A separate, fire-and-forget keepAlivePot() ping is sent on every
//      request (not awaited) purely to wake/keep the Render instance warm,
//      so subsequent requests are more likely to get a fast PO Token even
//      though the current request didn't wait for it.
//   3. resolveYtStream() now enforces a hard overall budget
//      (TOTAL_RESOLVE_BUDGET_MS) across the whole client chain using
//      withDeadline() — if we're out of budget, we stop trying further
//      clients/Piped instances and return whatever error we have, instead
//      of silently compounding timeouts to 90+ seconds.
//   4. Per-client timeouts trimmed slightly so 3x android_vr + ios + tv +
//      piped can realistically fit inside the overall budget.
// =============================================================================

const SAAVN_API = 'https://www.jiosaavn.com/api.php';

// Multiple Piped instances tried in order. Each one is independently
// operated and can go down without notice.
const PIPED_INSTANCES = [
  'https://pipedapi.adminforge.de',
  'https://api.piped.yt',
  'https://pipedapi.drgns.space',
  'https://pipedapi.reallyaweso.me',
];

const FETCH_TIMEOUT_MS = 5000;

// Overall hard cap for the ENTIRE resolveYtStream() call, across every
// client + Piped instance combined. This is the single most important
// number in this file: it guarantees the app never waits longer than this
// for a resolve to give up and move to the next song, no matter how many
// individual retries/instances are configured above.
const TOTAL_RESOLVE_BUDGET_MS = 15000;

// PO Token provider — self-hosted bgutil-ytdlp-pot-provider on Render.
// IMPORTANT: this timeout is intentionally SHORT now. We are not trying to
// wait out a cold start here — see keepAlivePot() below for how we handle
// that instead. If the provider doesn't answer in 3s, we proceed without
// a token for this request rather than blocking it.
const POT_PROVIDER_URL = 'https://aurum-pot.onrender.com/get_pot';
const POT_FETCH_TIMEOUT_MS = 3000;

async function fetchWithTimeout(url, options, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// A small deadline helper: wraps a promise so it never keeps the caller
// waiting past `msLeft`. Used to enforce TOTAL_RESOLVE_BUDGET_MS across the
// whole chain, not just per-request.
function withDeadline(promise, msLeft, fallbackValue = null) {
  if (msLeft <= 0) return Promise.resolve(fallbackValue);
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallbackValue), msLeft)),
  ]);
}

async function fetchPoToken() {
  try {
    const resp = await fetchWithTimeout(POT_PROVIDER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, POT_FETCH_TIMEOUT_MS);
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    if (data?.poToken) {
      return { poToken: data.poToken, visitorData: data.visitorData || null };
    }
    return null;
  } catch (_) {
    return null;
  }
}

// Fire-and-forget ping to keep/wake the Render instance, WITHOUT the
// current request waiting on it. Callers should NOT await this — it's
// deliberately detached so a cold provider only costs future requests a
// warmer instance, never the current one extra latency. Cloudflare's
// `ctx.waitUntil` (passed in as `waitUntil`) lets this keep running after
// the response has already been sent back to the client.
function keepAlivePot(waitUntil) {
  const ping = fetch(POT_PROVIDER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }).catch(() => null);
  if (waitUntil) waitUntil(ping);
}

// =============================================================================
// ATTEMPT — PO-Token-backed WEB_EMBEDDED_PLAYER. Only used when a token
// was actually obtained within POT_FETCH_TIMEOUT_MS.
//
// PO Tokens are platform-bound — a bgutil (BotGuard/web) token is valid for
// WEB_EMBEDDED_PLAYER, not ANDROID_VR (DroidGuard) or IOS. This client is
// the one it's actually meant for.
// =============================================================================
async function ytWebEmbeddedWithPot(videoId, pot, timeoutMs) {
  if (!pot?.poToken) return null;
  try {
    const context = {
      client: {
        clientName: 'WEB_EMBEDDED_PLAYER',
        clientVersion: '1.20250101.00.00',
        hl: 'en',
        gl: 'US',
      },
      thirdParty: { embedUrl: `https://www.youtube.com/watch?v=${videoId}` },
    };
    if (pot.visitorData) context.client.visitorData = pot.visitorData;

    const resp = await fetchWithTimeout('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: JSON.stringify({
        videoId,
        context,
        serviceIntegrityDimensions: { poToken: pot.poToken },
      }),
    }, timeoutMs);
    const json = await resp.json().catch(() => null);
    if (json?.playabilityStatus?.status === 'OK') {
      const hasUsableAudio = (json?.streamingData?.adaptiveFormats || [])
        .some((f) => f.url && f.mimeType?.includes('audio'));
      if (hasUsableAudio) return json;
    }
    return null;
  } catch (_) {
    return null;
  }
}

// =============================================================================
// ATTEMPT — ANDROID_VR, retried a couple times for request-level flakiness
// (YouTube's SABR-only A/B experiment causes intermittent empty `url`
// fields on some requests for the same video). Trimmed to 2 attempts (was
// 3) so it fits comfortably inside the overall budget alongside everything
// else.
// =============================================================================
async function ytAndroidVr(videoId, attempts, perAttemptTimeoutMs) {
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetchWithTimeout('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'com.google.android.apps.youtube.vr.oculus/1.71.26 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
          'X-YouTube-Client-Name': '28',
          'X-YouTube-Client-Version': '1.71.26',
        },
        body: JSON.stringify({
          videoId,
          context: {
            client: {
              clientName: 'ANDROID_VR',
              clientVersion: '1.71.26',
              osVersion: '12L',
              hl: 'en',
              gl: 'US',
            },
          },
        }),
      }, perAttemptTimeoutMs);
      const json = await resp.json().catch(() => null);
      if (json?.playabilityStatus?.status === 'OK') {
        const hasUsableAudio = (json?.streamingData?.adaptiveFormats || [])
          .some((f) => f.url && f.mimeType?.includes('audio'));
        if (hasUsableAudio) return json;
      }
    } catch (_) {
      // fall through to next attempt
    }
  }
  return null;
}

// =============================================================================
// ATTEMPT — iOS client.
// =============================================================================
async function ytIos(videoId, timeoutMs) {
  try {
    const resp = await fetchWithTimeout('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)',
        'X-YouTube-Client-Name': '5',
        'X-YouTube-Client-Version': '19.29.1',
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: 'IOS',
            clientVersion: '19.29.1',
            deviceModel: 'iPhone16,2',
            hl: 'en',
            gl: 'US',
          },
        },
      }),
    }, timeoutMs);
    const json = await resp.json().catch(() => null);
    if (json?.playabilityStatus?.status === 'OK') {
      const hasUsableAudio = (json?.streamingData?.adaptiveFormats || [])
        .some((f) => f.url && f.mimeType?.includes('audio'));
      if (hasUsableAudio) return json;
    }
    return null;
  } catch (_) {
    return null;
  }
}

// =============================================================================
// ATTEMPT — TVHTML5_SIMPLY_EMBEDDED_PLAYER bypass.
// =============================================================================
async function ytTvEmbeddedBypass(videoId, timeoutMs) {
  try {
    const resp = await fetchWithTimeout('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (PlayStation; PlayStation 4/12.02) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Safari/605.1.15',
        'X-YouTube-Client-Name': '85',
        'X-YouTube-Client-Version': '2.0',
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
            clientVersion: '2.0',
            platform: 'TV',
            hl: 'en',
            gl: 'US',
          },
          thirdParty: { embedUrl: `https://www.youtube.com/watch?v=${videoId}` },
        },
      }),
    }, timeoutMs);
    return await resp.json().catch(() => null);
  } catch (_) {
    return null;
  }
}

// =============================================================================
// ATTEMPT — Piped, tried across multiple instances in sequence until one
// responds with usable audio streams.
// =============================================================================
async function ytPipedFallback(videoId, safePlayerResponse, perInstanceTimeoutMs, deadlineAt) {
  for (const instance of PIPED_INSTANCES) {
    if (Date.now() > deadlineAt) break; // out of overall budget — stop trying more instances
    try {
      const resp = await fetchWithTimeout(`${instance}/streams/${videoId}`, {
        headers: { 'Content-Type': 'application/json' },
      }, perInstanceTimeoutMs);
      if (!resp.ok) continue;
      const pipedData = await resp.json().catch(() => null);
      const audioStreams = pipedData?.audioStreams || [];
      if (!audioStreams.length) continue;

      const closestMatch = (bitrate) => {
        const target = bitrate || 0;
        if (target === 0) return null;
        return audioStreams.reduce((best, s) => {
          const diff = Math.abs((s.bitrate || 0) - target);
          const bestDiff = best ? Math.abs((best.bitrate || 0) - target) : Infinity;
          return diff < bestDiff ? s : best;
        }, null);
      };

      const merged = safePlayerResponse ? { ...safePlayerResponse } : { streamingData: {} };
      if (merged?.streamingData?.adaptiveFormats) {
        merged.streamingData.adaptiveFormats = merged.streamingData.adaptiveFormats.map((f) => {
          const match = closestMatch(f.bitrate);
          return { ...f, url: match ? match.url : f.url };
        });
      } else {
        merged.streamingData = merged.streamingData || {};
        merged.streamingData.adaptiveFormats = audioStreams
          .filter((s) => s.url)
          .map((s) => ({ url: s.url, bitrate: s.bitrate, mimeType: s.mimeType || 'audio/mp4' }));
      }
      if (merged?.streamingData?.formats) {
        merged.streamingData.formats = merged.streamingData.formats.map((f) => {
          const match = closestMatch(f.bitrate);
          return { ...f, url: match ? match.url : f.url };
        });
      }
      return merged;
    } catch (_) {
      continue;
    }
  }
  return safePlayerResponse;
}

// =============================================================================
// MAIN resolve — every stage now runs against a shared deadline so the
// WHOLE function can never exceed TOTAL_RESOLVE_BUDGET_MS, regardless of
// how many clients/instances are configured above.
// =============================================================================
async function resolveYtStream(videoId, waitUntil) {
  const startedAt = Date.now();
  const deadlineAt = startedAt + TOTAL_RESOLVE_BUDGET_MS;
  const remaining = () => Math.max(0, deadlineAt - Date.now());

  // Kick off a detached keep-alive ping so future requests have a better
  // shot at a warm PO Token provider. Not awaited — costs this request
  // nothing.
  keepAlivePot(waitUntil);

  // PO Token fetch is capped hard at 3s and does NOT block beyond that,
  // regardless of provider cold-start time.
  const pot = await withDeadline(fetchPoToken(), Math.min(POT_FETCH_TIMEOUT_MS, remaining()));

  if (pot?.poToken && remaining() > 0) {
    const webResponse = await ytWebEmbeddedWithPot(videoId, pot, Math.min(FETCH_TIMEOUT_MS, remaining()));
    if (webResponse) return extractAudioUrl(webResponse);
  }

  if (remaining() > 0) {
    const androidVrResponse = await ytAndroidVr(videoId, 2, Math.min(FETCH_TIMEOUT_MS, Math.max(1500, remaining() / 3)));
    if (androidVrResponse) return extractAudioUrl(androidVrResponse);
  }

  if (remaining() > 0) {
    const iosResponse = await ytIos(videoId, Math.min(FETCH_TIMEOUT_MS, remaining()));
    if (iosResponse) return extractAudioUrl(iosResponse);
  }

  let safePlayerResponse = null;
  if (remaining() > 0) {
    safePlayerResponse = await ytTvEmbeddedBypass(videoId, Math.min(FETCH_TIMEOUT_MS, remaining()));
  }

  if (remaining() > 0) {
    const withPiped = await ytPipedFallback(
      videoId,
      safePlayerResponse?.playabilityStatus?.status === 'OK' ? safePlayerResponse : null,
      Math.min(4000, remaining()),
      deadlineAt
    );
    const result = extractAudioUrl(withPiped);
    if (result) return result;
  }

  return null;
}

function extractAudioUrl(playerResponse) {
  const formats = playerResponse?.streamingData?.adaptiveFormats || [];
  const audioFormats = formats
    .filter((f) => f.url && f.mimeType?.includes('audio'))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  if (audioFormats.length) {
    return {
      url: audioFormats[0].url,
      bitrate: audioFormats[0].bitrate,
      mimeType: audioFormats[0].mimeType,
    };
  }
  const muxed = playerResponse?.streamingData?.formats || [];
  const muxedSorted = muxed.filter((f) => f.url).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  if (muxedSorted.length) {
    return {
      url: muxedSorted[0].url,
      bitrate: muxedSorted[0].bitrate,
      mimeType: muxedSorted[0].mimeType,
      isMuxed: true,
    };
  }
  return null;
}

// =============================================================================
// DEBUG — runs every client independently (not budgeted, not short-circuited)
// and reports what each one actually returned/threw. Use this to see WHICH
// client is failing and why, since resolveYtStream() swallows all errors
// via catch(_) { return null } for the normal fast-path.
// =============================================================================
async function handleDebugYt(videoId) {
  if (!videoId) return jsonResp({ success: false, error: 'id required' }, 400);
  const report = {};

  // PO Token
  const potStart = Date.now();
  let pot = null;
  try {
    pot = await fetchPoToken();
    report.poToken = { ok: !!pot?.poToken, tookMs: Date.now() - potStart, hasVisitorData: !!pot?.visitorData };
  } catch (e) {
    report.poToken = { ok: false, tookMs: Date.now() - potStart, error: String(e) };
  }

  // WEB_EMBEDDED_PLAYER (only meaningful if we got a token)
  if (pot?.poToken) {
    const t0 = Date.now();
    try {
      const resp = await fetchWithTimeout('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: JSON.stringify({
          videoId,
          context: { client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '1.20250101.00.00', hl: 'en', gl: 'US', ...(pot.visitorData ? { visitorData: pot.visitorData } : {}) }, thirdParty: { embedUrl: `https://www.youtube.com/watch?v=${videoId}` } },
          serviceIntegrityDimensions: { poToken: pot.poToken },
        }),
      }, 6000);
      const json = await resp.json().catch(() => null);
      report.webEmbedded = {
        httpStatus: resp.status,
        playabilityStatus: json?.playabilityStatus?.status || null,
        reason: json?.playabilityStatus?.reason || null,
        formatCount: (json?.streamingData?.adaptiveFormats || []).length,
        tookMs: Date.now() - t0,
      };
    } catch (e) {
      report.webEmbedded = { error: String(e), tookMs: Date.now() - t0 };
    }
  } else {
    report.webEmbedded = { skipped: 'no PO token' };
  }

  // ANDROID_VR
  {
    const t0 = Date.now();
    try {
      const resp = await fetchWithTimeout('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'com.google.android.apps.youtube.vr.oculus/1.71.26 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
          'X-YouTube-Client-Name': '28',
          'X-YouTube-Client-Version': '1.71.26',
        },
        body: JSON.stringify({ videoId, context: { client: { clientName: 'ANDROID_VR', clientVersion: '1.71.26', osVersion: '12L', hl: 'en', gl: 'US' } } }),
      }, 6000);
      const json = await resp.json().catch(() => null);
      report.androidVr = {
        httpStatus: resp.status,
        playabilityStatus: json?.playabilityStatus?.status || null,
        reason: json?.playabilityStatus?.reason || null,
        formatCount: (json?.streamingData?.adaptiveFormats || []).length,
        tookMs: Date.now() - t0,
      };
    } catch (e) {
      report.androidVr = { error: String(e), tookMs: Date.now() - t0 };
    }
  }

  // IOS
  {
    const t0 = Date.now();
    try {
      const resp = await fetchWithTimeout('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)',
          'X-YouTube-Client-Name': '5',
          'X-YouTube-Client-Version': '19.29.1',
        },
        body: JSON.stringify({ videoId, context: { client: { clientName: 'IOS', clientVersion: '19.29.1', deviceModel: 'iPhone16,2', hl: 'en', gl: 'US' } } }),
      }, 6000);
      const json = await resp.json().catch(() => null);
      report.ios = {
        httpStatus: resp.status,
        playabilityStatus: json?.playabilityStatus?.status || null,
        reason: json?.playabilityStatus?.reason || null,
        formatCount: (json?.streamingData?.adaptiveFormats || []).length,
        tookMs: Date.now() - t0,
      };
    } catch (e) {
      report.ios = { error: String(e), tookMs: Date.now() - t0 };
    }
  }

  // TVHTML5_SIMPLY_EMBEDDED_PLAYER
  {
    const t0 = Date.now();
    try {
      const resp = await fetchWithTimeout('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (PlayStation; PlayStation 4/12.02) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Safari/605.1.15',
          'X-YouTube-Client-Name': '85',
          'X-YouTube-Client-Version': '2.0',
        },
        body: JSON.stringify({ videoId, context: { client: { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0', platform: 'TV', hl: 'en', gl: 'US' }, thirdParty: { embedUrl: `https://www.youtube.com/watch?v=${videoId}` } } }),
      }, 6000);
      const json = await resp.json().catch(() => null);
      report.tvEmbedded = {
        httpStatus: resp.status,
        playabilityStatus: json?.playabilityStatus?.status || null,
        reason: json?.playabilityStatus?.reason || null,
        formatCount: (json?.streamingData?.adaptiveFormats || []).length,
        tookMs: Date.now() - t0,
      };
    } catch (e) {
      report.tvEmbedded = { error: String(e), tookMs: Date.now() - t0 };
    }
  }

  // Piped instances
  report.piped = {};
  for (const instance of PIPED_INSTANCES) {
    const t0 = Date.now();
    try {
      const resp = await fetchWithTimeout(`${instance}/streams/${videoId}`, { headers: { 'Content-Type': 'application/json' } }, 6000);
      const data = await resp.json().catch(() => null);
      report.piped[instance] = {
        httpStatus: resp.status,
        audioStreamCount: (data?.audioStreams || []).length,
        error: data?.error || null,
        tookMs: Date.now() - t0,
      };
    } catch (e) {
      report.piped[instance] = { error: String(e), tookMs: Date.now() - t0 };
    }
  }

  return jsonResp({ videoId, report });
}

// =============================================================================
// Route handlers
// =============================================================================
async function handleYtStream(videoId, waitUntil) {
  if (!videoId) return jsonResp({ success: false, error: 'id required' }, 400);
  const audio = await resolveYtStream(videoId, waitUntil);
  if (!audio) return jsonResp({ success: false, error: 'No stream found' }, 502);
  return jsonResp({ success: true, ...audio, videoId });
}

async function handleYtProxy(videoId, request, waitUntil) {
  if (!videoId) return new Response('id required', { status: 400 });
  const audio = await resolveYtStream(videoId, waitUntil);
  if (!audio?.url) return new Response('Could not resolve stream', { status: 502 });

  const rangeHeader = request.headers.get('Range');
  const upstream = await fetch(audio.url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36',
      ...(rangeHeader ? { Range: rangeHeader } : {}),
    },
  }).catch(() => null);

  if (!upstream || (!upstream.ok && upstream.status !== 206)) {
    return new Response('Stream unavailable', { status: 502 });
  }
  return proxyAudioResponse(upstream);
}

function proxyAudioResponse(upstream) {
  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('Content-Type') || 'audio/mp4');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Access-Control-Allow-Origin', '*');
  const contentLength = upstream.headers.get('Content-Length');
  const contentRange = upstream.headers.get('Content-Range');
  if (contentLength) headers.set('Content-Length', contentLength);
  if (contentRange) headers.set('Content-Range', contentRange);
  return new Response(upstream.body, {
    status: upstream.status === 206 ? 206 : 200,
    headers,
  });
}

// =============================================================================
// Saavn helpers — unchanged.
// =============================================================================
async function saavnSearch(query, limit = 20) {
  try {
    const url = `${SAAVN_API}?__call=autocomplete.get&_format=json&_marker=0&cc=in&includeMetaTags=0&query=${encodeURIComponent(query)}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.jiosaavn.com/' },
    });
    if (!resp.ok) throw new Error('autocomplete failed');
    const data = await resp.json();
    const songs = data?.songs?.data || [];
    if (songs.length > 0) {
      const top = songs.slice(0, limit);
      const streamUrls = await Promise.allSettled(
        top.slice(0, 5).map((s) => (s.id ? saavnStreamById(s.id).catch(() => null) : Promise.resolve(null)))
      );
      return top.map((s, i) => {
        const streamResult = i < 5 ? (streamUrls[i].status === 'fulfilled' ? streamUrls[i].value : null) : null;
        return {
          id: s.id,
          title: decodeHtml(s.title || ''),
          artist: decodeHtml(s.more_info?.singers || s.subtitle || ''),
          album: decodeHtml(s.more_info?.album || ''),
          image: (s.image || '').replace('150x150', '500x500').replace('50x50', '500x500'),
          duration: s.more_info?.duration || null,
          language: s.more_info?.language || 'hindi',
          year: s.more_info?.year || null,
          source: 'saavn',
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
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data?.results || []).slice(0, limit).map((s) => ({
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
  } catch (_) {
    return [];
  }
}

async function saavnStreamById(songId) {
  try {
    const renderResp = await fetch(`https://jiosaavn-op-gits.onrender.com/api/songs?ids=${songId}`);
    if (renderResp.ok) {
      const renderData = await renderResp.json();
      const songs = renderData?.data;
      const song = Array.isArray(songs) ? songs[0] : songs;
      if (song) {
        const downloads = song.downloadUrl || [];
        for (const quality of ['320kbps', '160kbps', '96kbps', '48kbps']) {
          const match = downloads.find((d) => d.quality === quality && d.url);
          if (match) return { url: match.url, quality: match.quality, source: 'saavn' };
        }
      }
    }
  } catch (_) {}

  try {
    const url = `${SAAVN_API}?__call=song.getDetails&cc=in&_marker=0%3F_marker%3D0&_format=json&pids=${songId}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.jiosaavn.com/' },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const songData = data?.[songId];
    if (!songData) return null;
    const downloads = songData.more_info?.['320kbps'] ? [{ quality: '320kbps', url: songData.more_info['320kbps'] }] : [];
    for (const quality of ['320kbps', '160kbps', '96kbps', '48kbps']) {
      const match = downloads.find((d) => d.quality === quality && (d.url || d.link));
      if (match) return { url: match.url || match.link, quality: match.quality, source: 'saavn' };
    }
    return null;
  } catch (_) {
    return null;
  }
}

async function saavnLyrics(songId) {
  try {
    const url = `${SAAVN_API}?__call=lyrics.getLyrics&ctx=web6dot0&api_version=4&_format=json&_marker=0%3F_marker%3D0&lyrics_id=${songId}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.jiosaavn.com/' },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.lyrics || null;
  } catch (_) {
    return null;
  }
}

function decodeHtml(str) {
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

async function handleSaavnStream(songId) {
  if (!songId) return jsonResp({ success: false, error: 'id required' }, 400);
  const stream = await saavnStreamById(songId);
  if (!stream) return jsonResp({ success: false, error: 'Stream not found' }, 404);
  return jsonResp({ success: true, ...stream, url: stream.url, id: songId });
}

async function handleSaavnSearch(query, limit) {
  if (!query) return jsonResp({ success: false, error: 'query required' }, 400);
  const songs = await saavnSearch(query, parseInt(limit) || 20);
  return jsonResp({ success: true, data: { results: songs }, count: songs.length });
}

async function handleSaavnLyrics(songId) {
  if (!songId) return jsonResp({ success: false, error: 'id required' }, 400);
  const lyrics = await saavnLyrics(songId);
  if (!lyrics) return jsonResp({ success: false, error: 'Lyrics not found' }, 404);
  return jsonResp({ success: true, data: { lyrics }, id: songId });
}

async function handleStreamProxy(request, encodedUrl) {
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
    headers: { 'User-Agent': 'Mozilla/5.0', ...(rangeHeader ? { Range: rangeHeader } : {}) },
  }).catch(() => null);
  if (!upstream || (!upstream.ok && upstream.status !== 206)) {
    return jsonResp({ success: false, error: `upstream ${upstream?.status ?? 'timeout'}` }, 502);
  }
  const contentType = upstream.headers.get('Content-Type') || 'audio/mp4';
  const contentLength = upstream.headers.get('Content-Length');
  const contentRange = upstream.headers.get('Content-Range');
  const headers = new Headers();
  headers.set('Content-Type', contentType);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Access-Control-Allow-Origin', '*');
  if (contentLength) headers.set('Content-Length', contentLength);
  if (contentRange) headers.set('Content-Range', contentRange);
  return new Response(upstream.body, { status: upstream.status === 206 ? 206 : 200, headers });
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// =============================================================================
// Main router
// =============================================================================
export default {
  async fetch(request, env, ctx) {
    const { pathname, searchParams } = new URL(request.url);
    const waitUntil = ctx?.waitUntil?.bind(ctx);

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

    if (pathname === '/api/yt-stream') return handleYtStream(searchParams.get('id') || '', waitUntil);
    if (pathname === '/api/yt-proxy') return handleYtProxy(searchParams.get('id') || '', request, waitUntil);
    if (pathname === '/api/debug-yt') return handleDebugYt(searchParams.get('id') || '');

    if (pathname === '/result/') return handleSaavnSearch(searchParams.get('query') || '', searchParams.get('limit') || '20');
    if (pathname === '/song/') return handleSaavnStream(searchParams.get('id') || '');
    if (pathname === '/lyrics/') return handleSaavnLyrics(searchParams.get('id') || '');
    if (pathname === '/stream-proxy') return handleStreamProxy(request, searchParams.get('url') || '');

    if (pathname === '/health') {
      return jsonResp({
        status: 'ok',
        worker: 'aurum-stable-v2-budgeted',
        potProvider: POT_PROVIDER_URL,
        totalResolveBudgetMs: TOTAL_RESOLVE_BUDGET_MS,
        potFetchTimeoutMs: POT_FETCH_TIMEOUT_MS,
        ytClients: [
          'WEB_EMBEDDED_PLAYER (PO-Token, only if token obtained within 3s)',
          'ANDROID_VR (2 retries)',
          'IOS',
          'TVHTML5_SIMPLY_EMBEDDED_PLAYER (bypass)',
          `Piped closest-bitrate (multi-instance: ${PIPED_INSTANCES.join(', ')})`,
        ],
        resolutionStrategy: 'budgeted sequential chain — hard 15s cap, PO Token non-blocking',
      });
    }

    return jsonResp({ error: 'Not found', path: pathname }, 404);
  },
};
