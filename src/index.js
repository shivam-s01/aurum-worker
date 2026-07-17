// =============================================================================
// Aurum Music — Cloudflare Worker — YT resolution + Saavn + Cashfree payments
// (Merged 2026-07-16: added Cashfree order-create/verify routes so the
//  Cashfree secret key lives ONLY here — server-side env vars — and never
//  inside the Flutter app. See CASHFREE section near the bottom.)
// =============================================================================

const SAAVN_API = 'https://www.jiosaavn.com/api.php';

const PIPED_INSTANCES = [
  'https://pipedapi.adminforge.de',
  'https://api.piped.yt',
  'https://pipedapi.drgns.space',
  'https://pipedapi.reallyaweso.me',
];

const FETCH_TIMEOUT_MS = 5000;
const TOTAL_RESOLVE_BUDGET_MS = 15000;

const POT_PROVIDER_URL = 'https://aurum-pot.onrender.com/get_pot';
const POT_FETCH_TIMEOUT_MS = 3000;

// ── CASHFREE CONFIG ─────────────────────────────────────────────────────────
// Production API base. Use https://sandbox.cashfree.com/pg while testing.
const CF_API_BASE = 'https://api.cashfree.com/pg';
const CF_API_VERSION = '2023-08-01';
// Plan pricing allowlist — keeps this endpoint from being abused to create
// orders for arbitrary amounts.
const CF_ALLOWED_AMOUNTS = { monthly: 19, sixMonths: 149, lifetime: 249 };

async function fetchWithTimeout(url, options, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

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

function keepAlivePot(waitUntil) {
  const ping = fetch(POT_PROVIDER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }).catch(() => null);
  if (waitUntil) waitUntil(ping);
}

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

async function ytPipedFallback(videoId, safePlayerResponse, perInstanceTimeoutMs, deadlineAt) {
  for (const instance of PIPED_INSTANCES) {
    if (Date.now() > deadlineAt) break;
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

async function resolveYtStream(videoId, waitUntil) {
  const startedAt = Date.now();
  const deadlineAt = startedAt + TOTAL_RESOLVE_BUDGET_MS;
  const remaining = () => Math.max(0, deadlineAt - Date.now());

  keepAlivePot(waitUntil);

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

async function handleDebugYt(videoId) {
  if (!videoId) return jsonResp({ success: false, error: 'id required' }, 400);
  const report = {};

  const potStart = Date.now();
  let pot = null;
  try {
    pot = await fetchPoToken();
    report.poToken = { ok: !!pot?.poToken, tookMs: Date.now() - potStart, hasVisitorData: !!pot?.visitorData };
  } catch (e) {
    report.poToken = { ok: false, tookMs: Date.now() - potStart, error: String(e) };
  }

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
    const renderResp = await fetch(`https://jiosaavn-op-c4oo.onrender.com/api/songs?ids=${songId}`);
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
// CASHFREE — order creation + status verification.
// The secret key (env.CASHFREE_SECRET_KEY) and app id (env.CASHFREE_APP_ID)
// are Cloudflare Worker environment variables/secrets — set via the
// dashboard (Settings -> Variables) or `wrangler secret put`. They are
// NEVER hardcoded here and NEVER sent to the Flutter app.
// =============================================================================
async function handleCreateCfOrder(request, env) {
  if (request.method !== 'POST') {
    return jsonResp({ success: false, error: 'method not allowed' }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonResp({ success: false, error: 'invalid json body' }, 400);
  }

  const { orderId, orderAmount, planId, customerEmail, customerName } = body || {};
  if (!orderId || !orderAmount) {
    return jsonResp({ success: false, error: 'orderId and orderAmount required' }, 400);
  }

  if (!planId || CF_ALLOWED_AMOUNTS[planId] !== Number(orderAmount)) {
    return jsonResp({ success: false, error: 'amount does not match known plan pricing' }, 400);
  }

  try {
    const resp = await fetch(`${CF_API_BASE}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-version': CF_API_VERSION,
        'x-client-id': env.CASHFREE_APP_ID,
        'x-client-secret': env.CASHFREE_SECRET_KEY,
      },
      body: JSON.stringify({
        order_id: orderId,
        order_amount: orderAmount,
        order_currency: 'INR',
        customer_details: {
          customer_id: `cust_${orderId}`,
          customer_email: customerEmail || 'guest@aurum.app',
          customer_name: customerName || 'Aurum User',
          customer_phone: '9999999999',
        },
        order_meta: {
          plan_id: planId,
        },
      }),
    });

    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data?.payment_session_id) {
      return jsonResp({ success: false, error: data?.message || 'order creation failed' }, 502);
    }

    return jsonResp({
      success: true,
      payment_session_id: data.payment_session_id,
      order_id: data.order_id,
    });
  } catch (e) {
    return jsonResp({ success: false, error: String(e) }, 500);
  }
}

async function handleVerifyCfOrder(searchParams, env) {
  const orderId = searchParams.get('orderId');
  if (!orderId) return jsonResp({ success: false, error: 'orderId required' }, 400);

  try {
    const resp = await fetch(`${CF_API_BASE}/orders/${encodeURIComponent(orderId)}`, {
      method: 'GET',
      headers: {
        'x-api-version': CF_API_VERSION,
        'x-client-id': env.CASHFREE_APP_ID,
        'x-client-secret': env.CASHFREE_SECRET_KEY,
      },
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data) {
      return jsonResp({ success: false, error: 'could not fetch order status' }, 502);
    }
    return jsonResp({ success: true, order_status: data.order_status, order_id: data.order_id });
  } catch (e) {
    return jsonResp({ success: false, error: String(e) }, 500);
  }
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

    // Cashfree payment routes
    if (pathname === '/api/create-cf-order') return handleCreateCfOrder(request, env);
    if (pathname === '/api/verify-cf-order') return handleVerifyCfOrder(searchParams, env);

    if (pathname === '/health') {
      return jsonResp({
        status: 'ok',
        worker: 'aurum-stable-v2-budgeted-cashfree',
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
        cashfreeConfigured: true,
      });
    }

    return jsonResp({ error: 'Not found', path: pathname }, 404);
  },
};
