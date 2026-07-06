// =============================================================================
// Aurum Music — Cloudflare Worker — YT resolution
// (Updated 2026-07-07: android_vr is confirmed still the primary
//  PoToken-free client as of yt-dlp 2026.07.04, but it has become
//  ERRATIC — YouTube is randomly A/B-testing a "SABR-only" experiment
//  that makes android_vr's adaptiveFormats come back with no `url` field
//  on some requests and a valid one on the very next request for the
//  SAME video. Source: yt-dlp issues #16150, #15780, VRChat feedback
//  threads, confirmed as of March-July 2026. This is not fixable by
//  switching clients — it's request-level flakiness, so the fix is
//  RETRYING the same client a couple of times before giving up on it,
//  not just falling through once.)
//
// ATTEMPT 1 — ANDROID_VR client, up to 3 tries (handles the SABR-only
//   flakiness described above; each retry is a fresh request, YouTube's
//   experiment bucketing is per-request, not per-session).
//
// ATTEMPT 2 (only if attempt 1 never got a usable audio URL) — iOS
//   client. Still commonly PoToken-free/unobfuscated as of early-mid
//   2026 per YoutubeExplode/yt-dlp community tracking, and represents a
//   genuinely different client fingerprint than ANDROID_VR, so it is
//   not just "trying the same broken thing again."
//
// ATTEMPT 3 (only if attempt 2 also fails) — TVHTML5_SIMPLY_EMBEDDED_PLAYER
//   bypass client, as before.
//
// ATTEMPT 4 (only if attempt 3 succeeds OR as a last resort if nothing
//   above produced a URL) — Piped, tried across MULTIPLE instances in
//   sequence (not just one), each with its own short timeout, matched
//   by CLOSEST bitrate. If every instance fails/times out, we surface
//   a clear error instead of silently returning nothing.
//
// No caching, no coalescing — same minimal shape as before, just each
// stage is now retry/multi-instance hardened instead of single-shot.
// =============================================================================

const SAAVN_API = 'https://www.jiosaavn.com/api.php';

// Multiple Piped instances tried in order. Each one is independently
// operated and can go down without notice — trying only one (as before)
// meant a single volunteer server's downtime took out the entire last
// line of defense. List sourced from the actively-maintained
// TeamPiped/Piped instance wiki (checked 2026-07-07).
const PIPED_INSTANCES = [
  'https://pipedapi.adminforge.de',
  'https://api.piped.yt',
  'https://pipedapi.drgns.space',
  'https://pipedapi.reallyaweso.me',
];

const FETCH_TIMEOUT_MS = 6000;

// PO Token provider — self-hosted bgutil-ytdlp-pot-provider on Render.
// This is what actually gets past YouTube's bot-check consistently;
// everything else in this file (client rotation, retries, Piped) was the
// best available approach WITHOUT a PO Token, which is why it still failed
// on most videos. A PO Token proves the request came from a real BotGuard
// attestation flow instead of a bare HTTP client.
//
// IMPORTANT — this is a free-tier Render service: it spins down after
// inactivity and the first request after idle can take 30-50s to wake up.
// POT_FETCH_TIMEOUT_MS is intentionally longer than the YT-client timeout
// to give a cold-started instance a chance, but if it's still not up in
// time, we fall through to the existing no-PoToken chain rather than
// failing the whole request — a slow/asleep POT provider should degrade
// to "old behavior," not "total failure."
const POT_PROVIDER_URL = 'https://aurum-pot.onrender.com/get_pot';
const POT_FETCH_TIMEOUT_MS = 45000;

async function fetchPoToken() {
  try {
    const resp = await fetchWithTimeout(POT_PROVIDER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, POT_FETCH_TIMEOUT_MS);
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    // The server returns { poToken, visitorData } per the documented
    // /get_pot contract — this shape has been stable across the 1.x
    // TypeScript server releases used here (as opposed to the newer Rust
    // rewrite, which this Docker image is NOT — brainicism/bgutil-ytdlp-
    // pot-provider:latest is the TypeScript/Node implementation).
    if (data?.poToken) {
      return { poToken: data.poToken, visitorData: data.visitorData || null };
    }
    return null;
  } catch (_) {
    return null;
  }
}

async function fetchWithTimeout(url, options, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// =============================================================================
// ATTEMPT 1 — ANDROID_VR, retried up to 3x for the SABR-only flakiness.
// Returns the full playerResponse json, or null if all retries failed
// to produce a response with an actually-usable audio URL.
// =============================================================================
async function ytAndroidVr(videoId, attempts = 3, pot = null) {
  for (let i = 0; i < attempts; i++) {
    try {
      const context = {
        client: {
          clientName: 'ANDROID_VR',
          clientVersion: '1.71.26',
          osVersion: '12L',
          hl: 'en',
          gl: 'US',
        },
      };
      // Attach visitorData if the POT provider gave us one — InnerTube
      // uses this to correlate the session the PO Token was minted for.
      if (pot?.visitorData) {
        context.client.visitorData = pot.visitorData;
      }

      const body = { videoId, context };
      // serviceIntegrityDimensions.poToken is where YouTube's InnerTube
      // player endpoint expects the PO Token (per the yt-dlp POT-provider
      // integration this server implements the other half of). This is
      // an undocumented Google-internal field name, so it can change
      // without notice — if requests start failing again after working,
      // this is the first thing to re-verify against a current yt-dlp
      // debug log (yt-dlp -v with bgutil configured shows the exact
      // request shape it sends).
      if (pot?.poToken) {
        body.serviceIntegrityDimensions = { poToken: pot.poToken };
      }

      const resp = await fetchWithTimeout('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'com.google.android.apps.youtube.vr.oculus/1.71.26 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
          'X-YouTube-Client-Name': '28',
          'X-YouTube-Client-Version': '1.71.26',
        },
        body: JSON.stringify(body),
      });
      const json = await resp.json().catch(() => null);
      if (json?.playabilityStatus?.status === 'OK') {
        // Confirm this attempt actually gave us a usable audio URL —
        // the SABR-only experiment returns status "OK" but with
        // adaptiveFormats entries that have no `url` field at all, which
        // extractAudioUrl() would otherwise silently treat as "no audio
        // formats" without us knowing WHY this attempt failed.
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
// ATTEMPT 2 — iOS client (only reached if ANDROID_VR exhausted its retries).
// =============================================================================
async function ytIos(videoId) {
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
    });
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
// ATTEMPT 3 — TVHTML5_SIMPLY_EMBEDDED_PLAYER bypass.
// =============================================================================
async function ytTvEmbeddedBypass(videoId) {
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
          thirdParty: {
            embedUrl: `https://www.youtube.com/watch?v=${videoId}`,
          },
        },
      }),
    });
    return await resp.json().catch(() => null);
  } catch (_) {
    return null;
  }
}

// =============================================================================
// ATTEMPT 4 — Piped, tried across multiple instances in sequence until one
// responds with usable audio streams. CLOSEST-bitrate match, applied to
// both adaptiveFormats and formats (muxed).
// =============================================================================
async function ytPipedFallback(videoId, safePlayerResponse) {
  for (const instance of PIPED_INSTANCES) {
    try {
      const resp = await fetchWithTimeout(`${instance}/streams/${videoId}`, {
        headers: { 'Content-Type': 'application/json' },
      }, 5000);
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
        // No prior playerResponse at all (every YT client attempt failed
        // outright) — build a minimal adaptiveFormats list straight from
        // Piped's own audio streams so extractAudioUrl() still has
        // something to pick from, instead of returning nothing just
        // because there was no earlier "safe" response to graft onto.
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
  // Every Piped instance failed or timed out — return whatever we had
  // before trying Piped (may be null), so the caller can still report a
  // clear "nothing worked" rather than throwing.
  return safePlayerResponse;
}

// =============================================================================
// MAIN resolve.
// =============================================================================
async function resolveYtStream(videoId) {
  // Fetch a PO Token first. If the provider is cold/asleep/down, this
  // returns null after its own timeout, and everything below proceeds
  // exactly as it did before the PO Token was introduced — this is an
  // enhancement layered on top of the existing chain, not a replacement
  // for it, so a POT-provider outage can't take down YouTube playback
  // entirely.
  const pot = await fetchPoToken();

  const androidVrResponse = await ytAndroidVr(videoId, 3, pot);
  if (androidVrResponse) {
    return extractAudioUrl(androidVrResponse);
  }

  const iosResponse = await ytIos(videoId);
  if (iosResponse) {
    return extractAudioUrl(iosResponse);
  }

  const safePlayerResponse = await ytTvEmbeddedBypass(videoId);
  if (safePlayerResponse?.playabilityStatus?.status !== 'OK') {
    // Nothing from any direct YT client worked — last resort is Piped,
    // built from scratch if needed (see ytPipedFallback's else-branch).
    const pipedOnly = await ytPipedFallback(videoId, null);
    return extractAudioUrl(pipedOnly);
  }

  const withPiped = await ytPipedFallback(videoId, safePlayerResponse);
  return extractAudioUrl(withPiped);
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
  // Fallback to muxed formats if no audio-only format resolved.
  const muxed = playerResponse?.streamingData?.formats || [];
  const muxedSorted = muxed
    .filter((f) => f.url)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
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
// Route handlers — no caching, no coalescing.
// =============================================================================
async function handleYtStream(videoId) {
  if (!videoId) return jsonResp({ success: false, error: 'id required' }, 400);
  const audio = await resolveYtStream(videoId);
  if (!audio) return jsonResp({ success: false, error: 'No stream found' }, 502);
  return jsonResp({ success: true, ...audio, videoId });
}

async function handleYtProxy(videoId, request) {
  if (!videoId) return new Response('id required', { status: 400 });
  const audio = await resolveYtStream(videoId);
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
  async fetch(request) {
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

    if (pathname === '/api/yt-stream') return handleYtStream(searchParams.get('id') || '');
    if (pathname === '/api/yt-proxy') return handleYtProxy(searchParams.get('id') || '', request);

    if (pathname === '/result/') return handleSaavnSearch(searchParams.get('query') || '', searchParams.get('limit') || '20');
    if (pathname === '/song/') return handleSaavnStream(searchParams.get('id') || '');
    if (pathname === '/lyrics/') return handleSaavnLyrics(searchParams.get('id') || '');
    if (pathname === '/stream-proxy') return handleStreamProxy(request, searchParams.get('url') || '');

    if (pathname === '/health') {
      return jsonResp({
        status: 'ok',
        worker: 'aurum-musicyou-pattern',
        potProvider: POT_PROVIDER_URL,
        ytClients: [
          'ANDROID_VR (up to 3 retries, PO-Token-attached when provider is up)',
          'IOS (middle fallback)',
          'TVHTML5_SIMPLY_EMBEDDED_PLAYER (bypass)',
          `Piped closest-bitrate (multi-instance: ${PIPED_INSTANCES.join(', ')})`,
        ],
        resolutionStrategy: 'PO-Token-first, retry-hardened sequential chain, no cache, no coalescing',
      });
    }

    return jsonResp({ error: 'Not found', path: pathname }, 404);
  },
};
