/**
 * Nuvio Media Server - Cloudflare Worker
 * 
 * Provides:
 * 1. Nuvio / Stremio Addon Protocol Server (/manifest.json, /catalog/..., /meta/..., /stream/...)
 * 2. Lightweight Web Dashboard (/dashboard, /)
 * 3. Ingestion Trigger API (/api/enqueue) connected to GitHub Actions
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

const MANIFEST = {
  id: 'org.nuvio.iavault',
  version: '1.0.0',
  name: 'Nuvio Cloud Vault',
  description: 'Zero-Cost Automated Video Vault & Streaming Addon powered by Internet Archive',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie'],
  idPrefixes: ['ia_', 'tt'],
  catalogs: [
    {
      type: 'movie',
      id: 'ia_vault',
      name: 'Cloud Vault Archive',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false },
      ],
    },
  ],
  behaviorHints: {
    configurable: false,
    configurationRequired: false,
  },
};

/**
 * Helper to resolve high-quality poster URL:
 * 1. Stored poster
 * 2. Cinemeta official IMDb poster if IMDb ID present
 * 3. Internet Archive item banner fallback
 */
function resolvePoster(item, itemId) {
  if (item && item.poster) return item.poster;
  const imdbId = item ? (item.imdb_id || (item.id && item.id.startsWith('tt') ? item.id : null)) : null;
  if (imdbId) {
    return `https://images.metahub.space/poster/medium/${imdbId}/img`;
  }
  return `https://archive.org/services/img/${itemId || 'nuvio-cloud-vault-2026'}`;
}

/**
 * Handle incoming requests
 */
export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // 1. Root and Dashboard UI
      if (path === '/' || path === '/dashboard') {
        return handleDashboard(request, env);
      }

      // 2. Addon Manifest
      if (path === '/manifest.json') {
        return jsonResponse(MANIFEST);
      }

      // 3. Catalog Endpoint: /catalog/movie/ia_vault.json or /catalog/movie/ia_vault/...
      if (path.startsWith('/catalog/')) {
        return await handleCatalog(path, url, env);
      }

      // 4. Meta Endpoint: /meta/movie/:id.json
      if (path.startsWith('/meta/')) {
        return await handleMeta(path, env);
      }

      // 5. Stream Endpoint: /stream/movie/:id.json
      if (path.startsWith('/stream/')) {
        return await handleStream(path, env);
      }

      // 6. API: Enqueue Video Ingestion via GitHub Actions
      if (path === '/api/enqueue' && request.method === 'POST') {
        return await handleEnqueue(request, env);
      }

      // 7. API: Fetch Catalog items for dashboard
      if (path === '/api/catalog') {
        const catalog = await fetchCatalog(env);
        return jsonResponse(catalog);
      }

      // 404 Not Found
      return jsonResponse({ error: 'Endpoint not found' }, 404);
    } catch (err) {
      console.error('Unhandled Worker Error:', err);
      return jsonResponse({ error: 'Internal Server Error', details: err.message }, 500);
    }
  },
};

/**
 * Returns JSON Response with CORS headers
 */
function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

/**
 * Fetch catalog index from Internet Archive item
 * Falls back to Archive.org metadata API if catalog_index.json is missing
 */
async function fetchCatalog(env) {
  const itemId = env.IA_ITEM_ID || 'nuvio-cloud-vault-2026';
  const catalogUrl = `https://archive.org/download/${itemId}/catalog_index.json`;

  try {
    const res = await fetch(catalogUrl, {
      headers: { 'User-Agent': 'Nuvio-Cloudflare-Worker/1.0' },
      cf: { cacheTtl: 30, cacheEverything: true },
    });

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        return { version: 1, items: data, itemId };
      }
      if (data && Array.isArray(data.items)) {
        return { version: data.version || 1, items: data.items, itemId };
      }
    }
  } catch (e) {
    console.warn('catalog_index.json fetch failed, falling back to archive metadata:', e.message);
  }

  // Fallback: Parse Archive.org item metadata directly
  return await fetchArchiveMetadataFallback(itemId);
}

/**
 * Fallback parser using archive.org/metadata/<itemId>
 */
async function fetchArchiveMetadataFallback(itemId) {
  const metaUrl = `https://archive.org/metadata/${itemId}`;
  try {
    const res = await fetch(metaUrl, {
      headers: { 'User-Agent': 'Nuvio-Cloudflare-Worker/1.0' },
      cf: { cacheTtl: 60, cacheEverything: true },
    });

    if (!res.ok) {
      return { version: 1, items: [], itemId };
    }

    const data = await res.json();
    const files = data.files || [];
    const validExts = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v'];

    const items = files
      .filter((f) => {
        const name = (f.name || '').toLowerCase();
        return (
          validExts.some((ext) => name.endsWith(ext)) &&
          !name.endsWith('_archive.torrent') &&
          !name.endsWith('_meta.xml')
        );
      })
      .map((f) => {
        const baseName = f.name.replace(/\.[^/.]+$/, '');
        const cleanTitle = baseName.replace(/_+/g, ' ').trim();
        const safeId = 'ia_' + encodeBase64Url(f.name);
        const sizeBytes = parseInt(f.size, 10) || 0;
        const sizeMb = sizeBytes > 0 ? (sizeBytes / (1024 * 1024)).toFixed(1) : undefined;

        return {
          id: safeId,
          title: cleanTitle,
          filename: f.name,
          direct_stream_url: `https://archive.org/download/${itemId}/${encodeURIComponent(f.name)}`,
          poster: `https://archive.org/services/img/${itemId}`,
          description: `Direct archive stream of ${f.name} from item ${itemId}`,
          size_bytes: sizeBytes,
          size_mb: sizeMb ? parseFloat(sizeMb) : null,
          added_at: f.mtime ? new Date(parseInt(f.mtime, 10) * 1000).toISOString() : new Date().toISOString(),
        };
      });

    return { version: 1, items, itemId };
  } catch (err) {
    console.error('Archive metadata fallback error:', err);
    return { version: 1, items: [], itemId };
  }
}

/**
 * URL-safe Base64 encoding
 */
function encodeBase64Url(str) {
  const b64 = btoa(unescape(encodeURIComponent(str)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * URL-safe Base64 decoding
 */
function decodeBase64Url(str) {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return decodeURIComponent(escape(atob(b64)));
}

/**
 * Handle Catalog Request (/catalog/movie/ia_vault.json or with extra parameters)
 */
async function handleCatalog(path, url, env) {
  // Stremio passes path like: /catalog/movie/ia_vault.json
  // or /catalog/movie/ia_vault/search=query.json
  // or /catalog/movie/ia_vault/skip=10.json
  const catalog = await fetchCatalog(env);
  let items = [...catalog.items];

  // Parse path parameters
  let search = url.searchParams.get('search') || '';
  let skip = parseInt(url.searchParams.get('skip') || '0', 10);

  const cleanPath = path.replace(/^\/catalog\/movie\/ia_vault\/?/, '').replace(/\.json$/, '');
  if (cleanPath) {
    const parts = cleanPath.split('&');
    for (const part of parts) {
      if (part.startsWith('search=')) {
        search = decodeURIComponent(part.replace('search=', ''));
      } else if (part.startsWith('skip=')) {
        skip = parseInt(part.replace('skip=', ''), 10) || 0;
      }
    }
  }

  // Filter search
  if (search) {
    const term = search.toLowerCase();
    items = items.filter(
      (item) =>
        (item.title && item.title.toLowerCase().includes(term)) ||
        (item.description && item.description.toLowerCase().includes(term)) ||
        (item.id && item.id.toLowerCase().includes(term))
    );
  }

  // Apply pagination
  const paginated = items.slice(skip, skip + 100);

  // Format into Nuvio MetaPreview format
  const itemId = env.IA_ITEM_ID || 'nuvio-cloud-vault-2026';
  const metas = paginated.map((item) => ({
    id: item.id,
    type: 'movie',
    name: item.title,
    poster: resolvePoster(item, itemId),
    description: item.description || '',
    releaseInfo: item.releaseInfo || (item.added_at ? item.added_at.slice(0, 4) : ''),
  }));

  return jsonResponse({ metas });
}

/**
 * Handle Meta Request (/meta/movie/:id.json)
 */
async function handleMeta(path, env) {
  // Expected path: /meta/movie/:id.json
  const match = path.match(/^\/meta\/movie\/(.+?)\.json$/);
  if (!match) {
    return jsonResponse({ meta: null }, 404);
  }

  const requestedId = decodeURIComponent(match[1]);
  const catalog = await fetchCatalog(env);
  const itemId = env.IA_ITEM_ID || 'nuvio-cloud-vault-2026';

  let item = catalog.items.find(
    (i) => i.id === requestedId || (i.imdb_id && i.imdb_id === requestedId)
  );

  // If item not found directly, check if it's an encoded filename
  if (!item && requestedId.startsWith('ia_')) {
    const rawEncoded = requestedId.slice(3);
    try {
      const decodedFilename = decodeBase64Url(rawEncoded);
      item = catalog.items.find((i) => i.filename === decodedFilename);
      if (!item) {
        // Construct ad-hoc item from decoded filename
        item = {
          id: requestedId,
          title: decodedFilename.replace(/\.[^/.]+$/, '').replace(/_+/g, ' ').trim(),
          filename: decodedFilename,
          direct_stream_url: `https://archive.org/download/${itemId}/${encodeURIComponent(decodedFilename)}`,
          poster: `https://archive.org/services/img/${itemId}`,
          description: `Direct archive stream of ${decodedFilename}`,
        };
      }
    } catch (_) {}
  }

  if (!item) {
    return jsonResponse({ meta: null }, 404);
  }

  const posterUrl = resolvePoster(item, itemId);
  const meta = {
    id: item.id,
    type: 'movie',
    name: item.title,
    poster: posterUrl,
    background: posterUrl,
    description: item.description || `Vault item: ${item.filename}`,
    runtime: item.duration_str || (item.duration ? `${Math.round(item.duration / 60)} min` : undefined),
    releaseInfo: item.releaseInfo || (item.added_at ? item.added_at.slice(0, 4) : ''),
  };

  return jsonResponse({ meta });
}

/**
 * Handle Stream Request (/stream/movie/:id.json)
 */
async function handleStream(path, env) {
  // Expected path: /stream/movie/:id.json
  const match = path.match(/^\/stream\/movie\/(.+?)\.json$/);
  if (!match) {
    return jsonResponse({ streams: [] }, 404);
  }

  const requestedId = decodeURIComponent(match[1]);
  const catalog = await fetchCatalog(env);
  const itemId = env.IA_ITEM_ID || 'nuvio-cloud-vault-2026';

  let item = catalog.items.find(
    (i) => i.id === requestedId || (i.imdb_id && i.imdb_id === requestedId)
  );

  // Attempt to decode if ia_ prefixed
  if (!item && requestedId.startsWith('ia_')) {
    try {
      const decodedFilename = decodeBase64Url(requestedId.slice(3));
      item = catalog.items.find((i) => i.filename === decodedFilename) || {
        id: requestedId,
        title: decodedFilename.replace(/\.[^/.]+$/, '').replace(/_+/g, ' ').trim(),
        filename: decodedFilename,
        direct_stream_url: `https://archive.org/download/${itemId}/${encodeURIComponent(decodedFilename)}`,
      };
    } catch (_) {}
  }

  if (!item) {
    return jsonResponse({ streams: [] });
  }

  const streamUrl =
    item.direct_stream_url ||
    `https://archive.org/download/${itemId}/${encodeURIComponent(item.filename)}`;

  const details = [];
  if (item.size_mb) details.push(`${item.size_mb} MB`);
  if (item.resolution) details.push(item.resolution);
  if (item.duration_str) details.push(item.duration_str);

  const titleSuffix = details.length > 0 ? `\n💾 ${details.join(' • ')}` : '\n💾 Archive.org Direct';

  const streams = [
    {
      name: 'Nuvio Vault',
      title: `${item.title}${titleSuffix} | ⚡ Byte-Range HTTP Stream`,
      url: streamUrl,
      behaviorHints: {
        notWebReady: false,
      },
    },
  ];

  return jsonResponse({ streams });
}

/**
 * Handle API Enqueue: Trigger GitHub Action repository_dispatch
 */
async function handleEnqueue(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const { video_url, custom_title, imdb_id, poster_url, admin_pin } = body;

  if (!video_url || typeof video_url !== 'string') {
    return jsonResponse({ success: false, error: 'video_url is required' }, 400);
  }

  // Security Check: Verify ADMIN_PIN
  const configuredPin = env.ADMIN_PIN;
  if (!configuredPin) {
    return jsonResponse(
      {
        success: false,
        error: 'ADMIN_PIN is not set in Cloudflare Worker secrets. Run: wrangler secret put ADMIN_PIN',
      },
      500
    );
  }

  if (!admin_pin || String(admin_pin) !== String(configuredPin)) {
    return jsonResponse({ success: false, error: 'Unauthorized: Invalid Admin PIN' }, 401);
  }

  // Verify GitHub configuration
  const ghOwner = env.GH_OWNER;
  const ghRepo = env.GH_REPO;
  const ghPat = env.GITHUB_PAT;

  if (!ghOwner || !ghRepo || !ghPat) {
    return jsonResponse(
      {
        success: false,
        error:
          'GitHub integration is not fully configured (GH_OWNER, GH_REPO, or GITHUB_PAT missing).',
      },
      500
    );
  }

  const dispatchUrl = `https://api.github.com/repos/${ghOwner}/${ghRepo}/dispatches`;

  const payload = {
    event_type: 'ingest_video',
    client_payload: {
      video_url: video_url.trim(),
      custom_title: (custom_title || '').trim(),
      imdb_id: (imdb_id || '').trim(),
      poster_url: (poster_url || '').trim(),
    },
  };

  try {
    const ghRes = await fetch(dispatchUrl, {
      method: 'POST',
      headers: {
        'User-Agent': 'Nuvio-Worker-Ingest/1.0',
        'Authorization': `Bearer ${ghPat}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (ghRes.status === 204) {
      return jsonResponse({
        success: true,
        message: 'Video successfully enqueued! GitHub Actions workflow triggered.',
        target_item: env.IA_ITEM_ID || 'nuvio-cloud-vault-2026',
        repository: `${ghOwner}/${ghRepo}`,
      });
    }

    const errText = await ghRes.text();
    return jsonResponse(
      {
        success: false,
        error: `GitHub API error (${ghRes.status}): ${errText}`,
      },
      ghRes.status
    );
  } catch (err) {
    return jsonResponse(
      {
        success: false,
        error: `Failed to contact GitHub API: ${err.message}`,
      },
      502
    );
  }
}

/**
 * Handle Dashboard HTML UI
 */
function handleDashboard(request, env) {
  const url = new URL(request.url);
  const host = url.host;
  const protocol = url.protocol;
  const manifestUrl = `${protocol}//${host}/manifest.json`;
  const stremioDeepLink = `stremio://${host}/manifest.json`;
  const itemId = env.IA_ITEM_ID || 'nuvio-cloud-vault-2026';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nuvio Cloud Vault — Zero-Cost Streaming & Ingestion</title>
  <link rel="icon" href="https://archive.org/favicon.ico">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090a0f;
      --card-bg: rgba(20, 24, 38, 0.7);
      --card-border: rgba(255, 255, 255, 0.08);
      --primary: #6366f1;
      --primary-hover: #4f46e5;
      --accent: #06b6d4;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --success: #10b981;
      --error: #ef4444;
      --radius: 14px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background-color: var(--bg);
      background-image: 
        radial-gradient(at 0% 0%, rgba(99, 102, 241, 0.15) 0px, transparent 50%),
        radial-gradient(at 100% 100%, rgba(6, 182, 212, 0.12) 0px, transparent 50%);
      background-attachment: fixed;
      color: var(--text);
      font-family: 'Plus Jakarta Sans', sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 32px 16px 64px;
    }

    .container {
      width: 100%;
      max-width: 940px;
      display: flex;
      flex-direction: column;
      gap: 28px;
    }

    header {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      gap: 10px;
    }

    .badge-bar {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(99, 102, 241, 0.15);
      border: 1px solid rgba(99, 102, 241, 0.3);
      padding: 6px 14px;
      border-radius: 9999px;
      font-size: 0.82rem;
      font-weight: 600;
      color: #a5b4fc;
      margin-bottom: 6px;
    }

    .badge-dot {
      width: 8px;
      height: 8px;
      background-color: var(--success);
      border-radius: 50%;
      box-shadow: 0 0 10px var(--success);
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
    }

    h1 {
      font-size: 2.4rem;
      font-weight: 800;
      letter-spacing: -0.03em;
      background: linear-gradient(135deg, #ffffff 40%, #a5b4fc 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    p.subtitle {
      color: var(--text-muted);
      font-size: 1.05rem;
      max-width: 620px;
    }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border-radius: var(--radius);
      padding: 24px 28px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
    }

    .card-title {
      font-size: 1.25rem;
      font-weight: 700;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .card-desc {
      color: var(--text-muted);
      font-size: 0.92rem;
      margin-bottom: 20px;
    }

    /* Addon URL bar */
    .url-bar {
      display: flex;
      gap: 10px;
      background: rgba(10, 12, 20, 0.85);
      border: 1px solid var(--card-border);
      padding: 6px 6px 6px 14px;
      border-radius: 10px;
      align-items: center;
      margin-bottom: 16px;
    }

    .url-text {
      flex: 1;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.88rem;
      color: #38bdf8;
      overflow-x: auto;
      white-space: nowrap;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 10px 18px;
      border-radius: 8px;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      border: none;
      text-decoration: none;
    }

    .btn-primary {
      background: linear-gradient(135deg, var(--primary) 0%, var(--primary-hover) 100%);
      color: white;
      box-shadow: 0 4px 14px rgba(99, 102, 241, 0.4);
    }
    .btn-primary:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(99, 102, 241, 0.6);
    }

    .btn-secondary {
      background: rgba(255, 255, 255, 0.08);
      color: var(--text);
      border: 1px solid rgba(255, 255, 255, 0.12);
    }
    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.14);
    }

    .btn-row {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }

    /* Form styling */
    .form-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 18px;
    }

    .full-width {
      grid-column: span 2;
    }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    label {
      font-size: 0.86rem;
      font-weight: 600;
      color: #cbd5e1;
    }

    input[type="text"], input[type="url"], input[type="password"] {
      background: rgba(10, 12, 20, 0.85);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 11px 14px;
      color: var(--text);
      font-size: 0.92rem;
      font-family: inherit;
      outline: none;
      transition: border-color 0.2s;
    }

    input:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
    }

    .pin-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 4px;
    }

    .remember-label {
      font-size: 0.82rem;
      color: var(--text-muted);
      display: inline-flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
    }

    .alert {
      padding: 14px 16px;
      border-radius: 8px;
      font-size: 0.9rem;
      display: none;
      align-items: center;
      gap: 10px;
      margin-top: 18px;
    }
    .alert.success {
      display: flex;
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.3);
      color: #6ee7b7;
    }
    .alert.error {
      display: flex;
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #fca5a5;
    }

    /* Catalog gallery */
    .catalog-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }

    .catalog-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 16px;
    }

    .video-card {
      background: rgba(10, 12, 20, 0.7);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      transition: transform 0.2s ease, border-color 0.2s ease;
    }

    .video-card:hover {
      transform: translateY(-4px);
      border-color: rgba(99, 102, 241, 0.4);
    }

    .video-poster {
      width: 100%;
      height: 240px;
      object-fit: cover;
      background: #1e1b4b;
    }

    .video-info {
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex: 1;
    }

    .video-title {
      font-size: 0.9rem;
      font-weight: 700;
      line-height: 1.3;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .video-meta {
      font-size: 0.76rem;
      color: var(--text-muted);
      margin-top: auto;
      display: flex;
      justify-content: space-between;
    }

    .video-actions {
      margin-top: 8px;
    }

    .btn-sm {
      padding: 6px 10px;
      font-size: 0.78rem;
      width: 100%;
    }

    footer {
      margin-top: auto;
      color: var(--text-muted);
      font-size: 0.82rem;
      text-align: center;
      padding-top: 24px;
    }

    footer a {
      color: #818cf8;
      text-decoration: none;
    }

    @media (max-width: 640px) {
      .form-grid { grid-template-columns: 1fr; }
      .full-width { grid-column: span 1; }
      .catalog-grid { grid-template-columns: repeat(2, 1fr); }
      .video-poster { height: 180px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="badge-bar">
        <span class="badge-dot"></span>
        Vault Item: <strong>${itemId}</strong>
      </div>
      <h1>Nuvio Cloud Vault</h1>
      <p class="subtitle">Zero-cost automated media ingestion pipeline & Stremio / Nuvio streaming protocol addon server.</p>
    </header>

    <!-- SECTION 1: ADDON INSTALLATION -->
    <div class="card">
      <div class="card-title">
        <span>🚀</span>
        <span>Install Streaming Addon</span>
      </div>
      <p class="card-desc">Paste this manifest URL into Nuvio, Stremio, or any compatible streaming player to browse and stream your archive.</p>
      
      <div class="url-bar">
        <span class="url-text" id="manifestUrl">${manifestUrl}</span>
        <button class="btn btn-secondary" onclick="copyManifest()">📋 Copy URL</button>
      </div>

      <div class="btn-row">
        <a href="${stremioDeepLink}" class="btn btn-primary">⚡ Install to Stremio</a>
        <a href="${manifestUrl}" target="_blank" class="btn btn-secondary">🔍 View Manifest JSON</a>
        <a href="https://archive.org/details/${itemId}" target="_blank" class="btn btn-secondary">📦 Open Archive.org Item</a>
      </div>
    </div>

    <!-- SECTION 2: ENQUEUE INGESTION -->
    <div class="card">
      <div class="card-title">
        <span>📥</span>
        <span>Enqueue Video for Ingestion</span>
      </div>
      <p class="card-desc">Trigger automated download, metadata extraction, and upload to Internet Archive via GitHub Actions background worker.</p>

      <form id="enqueueForm" onsubmit="handleEnqueueSubmit(event)">
        <div class="form-grid">
          <div class="form-group full-width">
            <label for="videoUrl">Video Source URL *</label>
            <input type="url" id="videoUrl" name="video_url" required placeholder="https://www.youtube.com/watch?v=... or direct MP4/MKV link">
          </div>

          <div class="form-group">
            <label for="customTitle">Custom Title (Optional)</label>
            <input type="text" id="customTitle" name="custom_title" placeholder="Override video title">
          </div>

          <div class="form-group">
            <label for="imdbId">IMDb ID (Optional)</label>
            <input type="text" id="imdbId" name="imdb_id" placeholder="e.g. tt0111161">
          </div>

          <div class="form-group full-width">
            <label for="posterUrl">Custom Poster / Thumbnail URL (Optional)</label>
            <input type="url" id="posterUrl" name="poster_url" placeholder="https://image.tmdb.org/.../poster.jpg">
          </div>

          <div class="form-group full-width">
            <label for="adminPin">Admin PIN *</label>
            <input type="password" id="adminPin" name="admin_pin" required placeholder="Enter your secret ADMIN_PIN">
            <div class="pin-row">
              <label class="remember-label">
                <input type="checkbox" id="rememberPin" checked> Remember PIN in browser
              </label>
            </div>
          </div>
        </div>

        <div id="alertBox" class="alert"></div>

        <div style="margin-top: 24px;">
          <button type="submit" id="submitBtn" class="btn btn-primary" style="width: 100%; padding: 14px; font-size: 1rem;">
            🚀 Trigger Cloud Ingestion
          </button>
        </div>
      </form>
    </div>

    <!-- SECTION 3: VAULT CATALOG PREVIEW -->
    <div class="card">
      <div class="catalog-header">
        <div class="card-title" style="margin-bottom: 0;">
          <span>🎬</span>
          <span>Vault Catalog (<span id="itemCount">Loading...</span>)</span>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="loadCatalog()" style="width: auto;">🔄 Refresh</button>
      </div>
      
      <div id="catalogGrid" class="catalog-grid">
        <div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); padding: 32px;">
          Fetching vault catalog...
        </div>
      </div>
    </div>

    <footer>
      Powered by Cloudflare Workers, GitHub Actions & Internet Archive. Zero-Cost, Permanent Streaming Infrastructure.
    </footer>
  </div>

  <script>
    // Load saved PIN on startup
    document.addEventListener('DOMContentLoaded', () => {
      const savedPin = localStorage.getItem('nuvio_admin_pin');
      if (savedPin) {
        document.getElementById('adminPin').value = savedPin;
      }
      loadCatalog();
    });

    function copyManifest() {
      const url = document.getElementById('manifestUrl').innerText;
      navigator.clipboard.writeText(url).then(() => {
        alert('Manifest URL copied to clipboard! Paste it into Nuvio or Stremio.');
      });
    }

    async function handleEnqueueSubmit(e) {
      e.preventDefault();
      const btn = document.getElementById('submitBtn');
      const alertBox = document.getElementById('alertBox');
      const pin = document.getElementById('adminPin').value;
      const remember = document.getElementById('rememberPin').checked;

      if (remember) {
        localStorage.setItem('nuvio_admin_pin', pin);
      } else {
        localStorage.removeItem('nuvio_admin_pin');
      }

      btn.disabled = true;
      btn.innerHTML = '⏳ Dispatching to GitHub Actions...';
      alertBox.className = 'alert';
      alertBox.style.display = 'none';

      const payload = {
        video_url: document.getElementById('videoUrl').value,
        custom_title: document.getElementById('customTitle').value,
        imdb_id: document.getElementById('imdbId').value,
        poster_url: document.getElementById('posterUrl').value,
        admin_pin: pin
      };

      try {
        const res = await fetch('/api/enqueue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (res.ok && data.success) {
          alertBox.className = 'alert success';
          alertBox.innerHTML = '✅ <strong>Queued!</strong> ' + data.message;
          document.getElementById('videoUrl').value = '';
          document.getElementById('customTitle').value = '';
          document.getElementById('imdbId').value = '';
          document.getElementById('posterUrl').value = '';
        } else {
          alertBox.className = 'alert error';
          alertBox.innerHTML = '❌ <strong>Error:</strong> ' + (data.error || 'Failed to trigger ingestion');
        }
      } catch (err) {
        alertBox.className = 'alert error';
        alertBox.innerHTML = '❌ <strong>Network Error:</strong> ' + err.message;
      } finally {
        btn.disabled = false;
        btn.innerHTML = '🚀 Trigger Cloud Ingestion';
      }
    }

    async function loadCatalog() {
      const grid = document.getElementById('catalogGrid');
      const countSpan = document.getElementById('itemCount');
      
      try {
        const res = await fetch('/api/catalog');
        const data = await res.json();
        const items = data.items || [];
        countSpan.innerText = items.length + ' item' + (items.length === 1 ? '' : 's');

        if (items.length === 0) {
          grid.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); padding: 40px;">No videos ingested yet. Enqueue your first video above!</div>';
          return;
        }

        grid.innerHTML = items.map(item => {
          const poster = item.poster || 'https://archive.org/services/img/' + (data.itemId || '${itemId}');
          const sizeStr = item.size_mb ? (item.size_mb + ' MB') : '';
          const streamUrl = item.direct_stream_url || ('https://archive.org/download/' + data.itemId + '/' + encodeURIComponent(item.filename));

          return \`
            <div class="video-card">
              <img src="\${poster}" alt="\${item.title}" class="video-poster" loading="lazy" onerror="this.src='https://archive.org/services/img/${itemId}'">
              <div class="video-info">
                <div class="video-title" title="\${item.title}">\${item.title}</div>
                <div class="video-meta">
                  <span>\${item.duration_str || 'Movie'}</span>
                  <span>\${sizeStr}</span>
                </div>
                <div class="video-actions">
                  <a href="\${streamUrl}" target="_blank" class="btn btn-secondary btn-sm">▶ Direct Stream</a>
                </div>
              </div>
            </div>
          \`;
        }).join('');
      } catch (e) {
        countSpan.innerText = 'Error';
        grid.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; color: var(--error); padding: 20px;">Failed to load catalog: ' + e.message + '</div>';
      }
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      ...CORS_HEADERS,
    },
  });
}
