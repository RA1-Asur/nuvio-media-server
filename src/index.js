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
  types: ['movie', 'other', 'series'],
  idPrefixes: ['ia_', 'tt'],
  catalogs: [
    {
      type: 'movie',
      id: 'ia_vault',
      name: 'Cloud Vault Archive',
      posterShape: 'landscape',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false },
      ],
    },
    {
      type: 'other',
      id: 'ia_vault_other',
      name: 'Cloud Vault Videos',
      posterShape: 'landscape',
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
        const urlObj = new URL(request.url);
        const forceRefresh = urlObj.searchParams.get('refresh') === '1';
        const catalog = await fetchCatalog(env, forceRefresh);
        return jsonResponse(catalog);
      }

      // 8. API: Delete Video from Archive.org Vault & Sync Catalog
      if (path === '/api/delete' && request.method === 'POST') {
        return await handleDelete(request, env);
      }

      // 9. API: Append Video to Catalog (called by ingestion engine)
      if (path === '/api/catalog/append' && request.method === 'POST') {
        return await handleCatalogAppend(request, env);
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
      'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

/**
 * Fetch catalog index from Cloudflare KV (instant) or Internet Archive item
 * Cross-references with live Archive.org metadata so if a file is deleted
 * from Archive.org, it automatically disappears from the Nuvio catalogue!
 */
async function fetchCatalog(env, forceRefresh = false) {
  // 1. Check Cloudflare KV for ultra-fast instant catalog
  if (!forceRefresh && env.VAULT_KV) {
    try {
      const cached = await env.VAULT_KV.get('catalog', 'json');
      if (cached && Array.isArray(cached.items)) {
        return cached;
      }
    } catch (e) {
      console.warn('KV read error:', e.message);
    }
  }

  const itemId = env.IA_ITEM_ID || 'nuvio-cloud-vault-2026';
  const catalogUrl = `https://archive.org/download/${itemId}/catalog_index.json?_t=${Date.now()}`;
  const metadataUrl = `https://archive.org/metadata/${itemId}`;

  try {
    const [catRes, metaRes] = await Promise.allSettled([
      fetch(catalogUrl, {
        headers: {
          'User-Agent': 'Nuvio-Cloudflare-Worker/1.0',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
        },
        cf: { cacheTtl: 0, cacheEverything: false },
      }),
      fetch(metadataUrl, {
        headers: { 'User-Agent': 'Nuvio-Cloudflare-Worker/1.0' },
        cf: { cacheTtl: 10, cacheEverything: false },
      }),
    ]);

    let activeFilenames = null;
    let fallbackFiles = [];

    if (metaRes.status === 'fulfilled' && metaRes.value.ok) {
      try {
        const metaJson = await metaRes.value.json();
        if (Array.isArray(metaJson.files)) {
          activeFilenames = new Set(metaJson.files.map((f) => f.name));
          fallbackFiles = metaJson.files;
        }
      } catch (_) {}
    }

    let catalogResult = null;
    if (catRes.status === 'fulfilled' && catRes.value.ok) {
      const data = await catRes.value.json();
      let rawItems = Array.isArray(data)
        ? data
        : data && Array.isArray(data.items)
        ? data.items
        : [];

      // If live file list is available, filter out any files deleted from Archive.org!
      if (activeFilenames && activeFilenames.size > 0) {
        rawItems = rawItems.filter((item) => activeFilenames.has(item.filename));
      }

      catalogResult = { version: 1, items: rawItems, itemId };
    } else if (fallbackFiles.length > 0) {
      catalogResult = parseArchiveFiles(fallbackFiles, itemId);
    }

    if (catalogResult) {
      if (env.VAULT_KV) {
        try {
          await env.VAULT_KV.put('catalog', JSON.stringify(catalogResult));
        } catch (_) {}
      }
      return catalogResult;
    }
  } catch (e) {
    console.warn('fetchCatalog error:', e.message);
  }

  const fallback = await fetchArchiveMetadataFallback(itemId);
  if (env.VAULT_KV && fallback) {
    try {
      await env.VAULT_KV.put('catalog', JSON.stringify(fallback));
    } catch (_) {}
  }
  return fallback;
}

/**
 * Build catalog items directly from Archive.org file list
 */
function parseArchiveFiles(files, itemId) {
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
        posterShape: 'landscape',
        description: `Direct archive stream of ${f.name} from item ${itemId}`,
        size_bytes: sizeBytes,
        size_mb: sizeMb ? parseFloat(sizeMb) : null,
        added_at: f.mtime ? new Date(parseInt(f.mtime, 10) * 1000).toISOString() : new Date().toISOString(),
      };
    });

  return { version: 1, items, itemId };
}

/**
 * Fallback parser using archive.org/metadata/<itemId>
 */
async function fetchArchiveMetadataFallback(itemId) {
  const metaUrl = `https://archive.org/metadata/${itemId}`;
  try {
    const res = await fetch(metaUrl, {
      headers: { 'User-Agent': 'Nuvio-Cloudflare-Worker/1.0' },
      cf: { cacheTtl: 10, cacheEverything: false },
    });

    if (!res.ok) {
      return { version: 1, items: [], itemId };
    }

    const data = await res.json();
    return parseArchiveFiles(data.files || [], itemId);
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
 * Handle Catalog Request (/catalog/:type/:id.json or with extra parameters)
 */
async function handleCatalog(path, url, env) {
  const catalog = await fetchCatalog(env);
  let items = [...catalog.items];

  // Parse path parameters
  let search = url.searchParams.get('search') || '';
  let skip = parseInt(url.searchParams.get('skip') || '0', 10);

  // Clean path removes /catalog/<type>/<id> prefix
  const cleanPath = path.replace(/^\/catalog\/[^/]+\/[^/.]+\/?/, '').replace(/\.json$/, '');
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

  // Format into Nuvio MetaPreview format with explicit landscape shape
  const itemId = env.IA_ITEM_ID || 'nuvio-cloud-vault-2026';
  const metas = paginated.map((item) => ({
    id: item.id,
    type: item.type || 'movie',
    name: item.title,
    poster: resolvePoster(item, itemId),
    posterShape: 'landscape',
    description: item.description || '',
    releaseInfo: item.releaseInfo || (item.added_at ? item.added_at.slice(0, 4) : ''),
  }));

  return jsonResponse({ metas });
}

/**
 * Handle Meta Request (/meta/:type/:id.json)
 */
async function handleMeta(path, env) {
  const match = path.match(/^\/meta\/[^/]+\/(.+?)\.json$/);
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
    type: item.type || 'movie',
    name: item.title,
    poster: posterUrl,
    background: posterUrl,
    posterShape: 'landscape',
    description: item.description || `Vault item: ${item.filename}`,
    runtime: item.duration_str || (item.duration ? `${Math.round(item.duration / 60)} min` : undefined),
    releaseInfo: item.releaseInfo || (item.added_at ? item.added_at.slice(0, 4) : ''),
  };

  return jsonResponse({ meta });
}

/**
 * Handle Stream Request (/stream/:type/:id.json)
 */
async function handleStream(path, env) {
  const match = path.match(/^\/stream\/[^/]+\/(.+?)\.json$/);
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
 * Archive.org S3 Fetch Helper
 * Follows HTTP 307 TemporaryRedirect with S3 authorization headers
 */
async function s3Fetch(url, options = {}) {
  const res = await fetch(url, { ...options, redirect: 'manual' });
  if (res.status === 307 || res.status === 301 || res.status === 302) {
    const loc = res.headers.get('Location');
    if (loc) {
      return await fetch(loc, options);
    }
  }
  return res;
}

/**
 * Handle API Delete: Deletes video and thumbnail from Archive.org S3
 * and syncs catalog_index.json
 */
async function handleDelete(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const { id, filename, admin_pin } = body;

  if (!filename && !id) {
    return jsonResponse({ success: false, error: 'filename or id is required' }, 400);
  }

  // Security Check: Verify ADMIN_PIN
  const configuredPin = env.ADMIN_PIN;
  if (!configuredPin) {
    return jsonResponse({ success: false, error: 'ADMIN_PIN is not set in Worker' }, 500);
  }
  if (!admin_pin || String(admin_pin) !== String(configuredPin)) {
    return jsonResponse({ success: false, error: 'Unauthorized: Invalid Admin PIN' }, 401);
  }

  const itemId = env.IA_ITEM_ID || 'nuvio-cloud-vault-2026';
  const accessKey = env.IA_ACCESS_KEY;
  const secretKey = env.IA_SECRET_KEY;

  if (!accessKey || !secretKey) {
    return jsonResponse(
      { success: false, error: 'IA_ACCESS_KEY or IA_SECRET_KEY not configured in Worker' },
      500
    );
  }

  const catalog = await fetchCatalog(env);
  const targetItem = catalog.items.find((i) => i.id === id || i.filename === filename);
  const targetFilename = filename || (targetItem ? targetItem.filename : null);

  if (!targetFilename) {
    return jsonResponse({ success: false, error: 'Could not resolve target filename to delete' }, 404);
  }

  const updatedItems = catalog.items.filter(
    (i) => i.id !== id && i.filename !== targetFilename
  );
  const newCatalog = {
    version: 1,
    item_id: itemId,
    updated_at: new Date().toISOString(),
    items: updatedItems,
  };

  // 1. Instantly update Cloudflare KV so Nuvio and Dashboard reflect deletion with 0ms lag
  if (env.VAULT_KV) {
    try {
      await env.VAULT_KV.put('catalog', JSON.stringify(newCatalog));
    } catch (e) {
      console.warn('Failed to update KV after delete:', e.message);
    }
  }

  const s3Auth = `LOW ${accessKey}:${secretKey}`;
  const s3Headers = {
    'Authorization': s3Auth,
    'x-archive-cascade-delete': '1',
    'x-archive-keep-old-version': '0',
  };

  // 2. Delete video file from S3 using redirect-aware s3Fetch
  const videoDeleteUrl = `https://s3.us.archive.org/${itemId}/${encodeURIComponent(targetFilename)}`;
  try {
    await s3Fetch(videoDeleteUrl, {
      method: 'DELETE',
      headers: s3Headers,
    });
  } catch (err) {
    console.warn('Failed to delete video file:', err.message);
  }

  // 3. Delete companion thumbnail if present
  const thumbFilename = `${targetFilename}_thumb.jpg`;
  try {
    await s3Fetch(`https://s3.us.archive.org/${itemId}/${encodeURIComponent(thumbFilename)}`, {
      method: 'DELETE',
      headers: s3Headers,
    });
  } catch (_) {}

  // 4. Update and re-upload catalog_index.json using redirect-aware s3Fetch
  try {
    const catalogStr = JSON.stringify(newCatalog, null, 2);
    const catalogBytes = new TextEncoder().encode(catalogStr);

    await s3Fetch(`https://s3.us.archive.org/${itemId}/catalog_index.json`, {
      method: 'PUT',
      headers: {
        'Authorization': s3Auth,
        'x-archive-no-derive': '1',
        'Content-Type': 'application/json',
        'Content-Length': String(catalogBytes.byteLength),
      },
      body: catalogBytes,
    });
  } catch (err) {
    console.warn('Failed to update catalog_index.json after delete:', err.message);
  }

  return jsonResponse({
    success: true,
    message: `Video successfully deleted from Archive.org vault!`,
    deleted_filename: targetFilename,
  });
}

/**
 * Handle Catalog Append: Appends newly ingested video to Cloudflare KV
 */
async function handleCatalogAppend(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const { entry, admin_pin } = body;
  if (!entry || !entry.id) {
    return jsonResponse({ success: false, error: 'Valid entry is required' }, 400);
  }

  const configuredPin = env.ADMIN_PIN;
  if (!configuredPin || String(admin_pin) !== String(configuredPin)) {
    return jsonResponse({ success: false, error: 'Unauthorized: Invalid Admin PIN' }, 401);
  }

  const catalog = await fetchCatalog(env);
  const updatedItems = [
    entry,
    ...catalog.items.filter((i) => i.id !== entry.id && i.filename !== entry.filename),
  ];

  const newCatalog = {
    version: 1,
    item_id: env.IA_ITEM_ID || 'nuvio-cloud-vault-2026',
    updated_at: new Date().toISOString(),
    items: updatedItems,
  };

  if (env.VAULT_KV) {
    try {
      await env.VAULT_KV.put('catalog', JSON.stringify(newCatalog));
    } catch (e) {
      console.warn('Failed to update KV on append:', e.message);
    }
  }

  return jsonResponse({
    success: true,
    message: 'Video appended to catalog successfully!',
    count: updatedItems.length,
  });
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

    .btn-danger {
      background: rgba(239, 68, 68, 0.15);
      color: #fca5a5;
      border: 1px solid rgba(239, 68, 68, 0.3);
    }
    .btn-danger:hover {
      background: rgba(239, 68, 68, 0.35);
      color: #ffffff;
      box-shadow: 0 4px 14px rgba(239, 68, 68, 0.4);
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
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
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
      aspect-ratio: 16 / 9;
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
      display: flex;
      gap: 8px;
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
      .catalog-grid { grid-template-columns: 1fr; }
      .video-poster { aspect-ratio: 16 / 9; }
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
        <button class="btn btn-secondary btn-sm" onclick="loadCatalog(true)" style="width: auto;">🔄 Refresh</button>
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

    async function loadCatalog(refresh = false) {
      const grid = document.getElementById('catalogGrid');
      const countSpan = document.getElementById('itemCount');
      if (refresh) {
        countSpan.innerText = 'Refreshing...';
      }
      
      try {
        const res = await fetch('/api/catalog?_t=' + Date.now() + (refresh ? '&refresh=1' : ''));
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
                  <a href="\${streamUrl}" target="_blank" class="btn btn-secondary btn-sm" style="flex: 1;">▶ Stream</a>
                  <button class="btn btn-danger btn-sm" onclick="deleteVideo('\${item.id}', '\${(item.filename || \'\').replace(/\'/g, &quot;\\\\\'&quot;)}', '\${(item.title || \'\').replace(/\'/g, &quot;\\\\\'&quot;)}')" style="flex: 1;">🗑️ Delete</button>
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

    async function deleteVideo(id, filename, title) {
      if (!confirm('Are you sure you want to permanently delete "' + title + '" from your Cloud Vault?')) {
        return;
      }

      let pin = document.getElementById('adminPin').value;
      if (!pin) {
        pin = prompt('Enter your ADMIN_PIN to confirm deletion:');
        if (!pin) return;
      }

      const alertBox = document.getElementById('alertBox');
      alertBox.className = 'alert';
      alertBox.style.display = 'flex';
      alertBox.innerHTML = '⏳ Deleting "' + title + '" from Archive.org vault...';

      try {
        const res = await fetch('/api/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id, filename: filename, admin_pin: pin })
        });

        const data = await res.json();
        if (res.ok && data.success) {
          alertBox.className = 'alert success';
          alertBox.innerHTML = '✅ ' + data.message;
          await loadCatalog();
        } else {
          alertBox.className = 'alert error';
          alertBox.innerHTML = '❌ Delete failed: ' + (data.error || 'Unknown error');
        }
      } catch (err) {
        alertBox.className = 'alert error';
        alertBox.innerHTML = '❌ Network error: ' + err.message;
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
