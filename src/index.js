// =============================================================================
// Aurum Music — Cloudflare Worker — YT resolution matching music-you fork
// (github.com/[fork of vfsfitvnm/ViMusic], actively maintained, Jan 2026
// client versions — ViMusic itself is archived/dead as of its last release).
// =============================================================================
//
// ATTEMPT 1 — ANDROID_VR client (confirmed PoToken-free by yt-dlp/
//   YoutubeExplode maintainers as of Jan 2026).
//
// ATTEMPT 2 (only if attempt 1's playabilityStatus != "OK") —
//   TVHTML5_SIMPLY_EMBEDDED_PLAYER bypass client.
//
// ATTEMPT 3 (only if attempt 2 succeeds) — Piped fallback
//   (pipedapi.adminforge.de), matched by CLOSEST bitrate (not exact-only
//   like the old ViMusic logic), applied to both adaptiveFormats AND
//   formats (muxed).
//
// No caching, no coalescing, no extra clients, no parallel racing —
// same minimal raw-sequential shape as before, just swapped to the
// currently-maintained fork's exact client choices.
// =============================================================================

const SAAVN_API = 'https://www.jiosaavn.com/api.php';

const PIPED_INSTANCE = 'https://pipedapi.adminforge.de';

// =============================================================================
// ATTEMPT 1 — ANDROID_VR (music-you's primary client)
// =============================================================================
async function ytAndroidVr(videoId) {
  try {
    const resp = await fetch('https://www.youtube.com/youtubei/v1/player', {
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
    });
    return await resp.json();
  } catch (_) {
    return null;
  }
}

// =============================================================================
// ATTEMPT 2 — TVHTML5_SIMPLY_EMBEDDED_PLAYER bypass (only if attempt 1 fails)
// =============================================================================
async function ytTvEmbeddedBypass(videoId) {
  try {
    const resp = await fetch('https://www.youtube.com/youtubei/v1/player', {
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
    return await resp.json();
  } catch (_) {
    return null;
  }
}

// =============================================================================
// ATTEMPT 3 — Piped fallback, CLOSEST-bitrate match (music-you's improvement
// over ViMusic's exact-match-only, which returned null on no exact match).
// Applied to both adaptiveFormats and formats (muxed), matching music-you.
// =============================================================================
async function ytPipedFallback(videoId, safePlayerResponse) {
  try {
    const resp = await fetch(`${PIPED_INSTANCE}/streams/${videoId}`, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (!resp.ok) return safePlayerResponse;
    const pipedData = await resp.json();
    const audioStreams = pipedData.audioStreams || [];
    if (!audioStreams.length) return safePlayerResponse;

    const closestMatch = (bitrate) => {
      const target = bitrate || 0;
      if (target === 0) return null;
      return audioStreams.reduce((best, s) => {
        const diff = Math.abs((s.bitrate || 0) - target);
        const bestDiff = best ? Math.abs((best.bitrate || 0) - target) : Infinity;
        return diff < bestDiff ? s : best;
      }, null);
    };

    if (safePlayerResponse?.streamingData?.adaptiveFormats) {
      safePlayerResponse.streamingData.adaptiveFormats =
        safePlayerResponse.streamingData.adaptiveFormats.map((f) => {
          const match = closestMatch(f.bitrate);
          return { ...f, url: match ? match.url : f.url };
        });
    }
    if (safePlayerResponse?.streamingData?.formats) {
      safePlayerResponse.streamingData.formats =
        safePlayerResponse.streamingData.formats.map((f) => {
          const match = closestMatch(f.bitrate);
          return { ...f, url: match ? match.url : f.url };
        });
    }
    return safePlayerResponse;
  } catch (_) {
    return safePlayerResponse;
  }
}

// =============================================================================
// MAIN resolve — same shape as before, updated client sequence.
// =============================================================================
async function resolveYtStream(videoId) {
  const response = await ytAndroidVr(videoId);

  if (response?.playabilityStatus?.status === 'OK') {
    return extractAudioUrl(response);
  }

  const safePlayerResponse = await ytTvEmbeddedBypass(videoId);

  if (safePlayerResponse?.playabilityStatus?.status !== 'OK') {
    return extractAudioUrl(response);
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
        ytClients: ['ANDROID_VR', 'TVHTML5_SIMPLY_EMBEDDED_PLAYER (bypass)', 'Piped closest-bitrate (pipedapi.adminforge.de)'],
        resolutionStrategy: 'music-you fork pattern — sequential, no cache, no coalescing',
      });
    }

    return jsonResp({ error: 'Not found', path: pathname }, 404);
  },
};
