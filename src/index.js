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

      // 10. API: Fetch recent GitHub Action ingestion runs
      if (path === '/api/runs') {
        return await handleGetRuns(env);
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
  let cached = null;
  if (env.VAULT_KV) {
    try {
      cached = await env.VAULT_KV.get('catalog', 'json');

      // Also check individual item keys to guarantee zero-latency discovery of items
      // added during concurrent bulk ingestion runs
      const itemKeys = await env.VAULT_KV.list({ prefix: 'item:' });
      if (itemKeys && Array.isArray(itemKeys.keys) && itemKeys.keys.length > 0) {
        const cachedFilenames = new Set(
          cached && Array.isArray(cached.items) ? cached.items.map((i) => i.filename) : []
        );
        const itemsMap = new Map();
        if (cached && Array.isArray(cached.items)) {
          for (const it of cached.items) {
            if (it && it.filename) itemsMap.set(it.filename, it);
          }
        }

        let hasMissingItems = false;
        for (const k of itemKeys.keys) {
          const fname = k.name.replace(/^item:/, '');
          if (!cachedFilenames.has(fname)) {
            hasMissingItems = true;
            if (k.metadata && k.metadata.filename) {
              itemsMap.set(k.metadata.filename, {
                id: k.metadata.id,
                imdb_id: null,
                title: k.metadata.title,
                filename: k.metadata.filename,
                direct_stream_url: k.metadata.direct_stream_url,
                poster: k.metadata.poster,
                description: `Uploaded to ${env.IA_ITEM_ID || 'nuvio-cloud-vault-2026'}`,
                duration: 0,
                duration_str: k.metadata.duration_str || 'Unknown',
                size_bytes: Math.round((k.metadata.size_mb || 0) * 1024 * 1024),
                size_mb: k.metadata.size_mb || 0,
                resolution: k.metadata.resolution || 'HD',
                added_at: k.metadata.added_at || new Date().toISOString(),
              });
            } else {
              const fullItem = await env.VAULT_KV.get(k.name, 'json');
              if (fullItem && fullItem.filename) {
                itemsMap.set(fullItem.filename, fullItem);
              }
            }
          }
        }

        if (hasMissingItems) {
          const mergedList = Array.from(itemsMap.values());
          mergedList.sort((a, b) => new Date(b.added_at || 0) - new Date(a.added_at || 0));
          cached = {
            version: 1,
            item_id: env.IA_ITEM_ID || 'nuvio-cloud-vault-2026',
            updated_at: new Date().toISOString(),
            items: mergedList,
          };
          await env.VAULT_KV.put('catalog', JSON.stringify(cached));
        }
      }

      if (!forceRefresh && cached && Array.isArray(cached.items) && cached.items.length > 0) {
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
    const itemsMap = new Map();

    // 1. Seed with existing KV items (KV is the permanent master state for uploaded videos)
    if (cached && Array.isArray(cached.items)) {
      for (const it of cached.items) {
        if (it && it.filename) {
          itemsMap.set(it.filename, it);
        }
      }
    }

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
        cf: { cacheTtl: 0, cacheEverything: false },
      }),
    ]);

    // 2. Discover any items on Archive.org metadata
    if (metaRes.status === 'fulfilled' && metaRes.value.ok) {
      try {
        const metaJson = await metaRes.value.json();
        if (Array.isArray(metaJson.files)) {
          const discovered = parseArchiveFiles(metaJson.files, itemId);
          for (const it of discovered.items) {
            if (it.filename && !itemsMap.has(it.filename)) {
              itemsMap.set(it.filename, it);
            }
          }
        }
      } catch (_) {}
    }

    // 3. Overlay any richer metadata from catalog_index.json
    if (catRes.status === 'fulfilled' && catRes.value.ok) {
      try {
        const data = await catRes.value.json();
        const rawItems = Array.isArray(data)
          ? data
          : data && Array.isArray(data.items)
          ? data.items
          : [];
        for (const it of rawItems) {
          if (it.filename) {
            const existing = itemsMap.get(it.filename) || {};
            itemsMap.set(it.filename, { ...existing, ...it });
          }
        }
      } catch (_) {}
    }

    let finalItems = Array.from(itemsMap.values());
    finalItems.sort((a, b) => new Date(b.added_at || 0) - new Date(a.added_at || 0));

    if (finalItems.length > 0) {
      const catalogResult = { version: 1, items: finalItems, itemId };
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

  if (cached && Array.isArray(cached.items) && cached.items.length > 0) {
    return cached;
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
  const fileNameSet = new Set(files.map((f) => f.name));

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
      const fname = f.name;
      const hashMatch = fname.match(/_([a-f0-9]{8})\.[a-zA-Z0-9]+$/);
      const safeId = hashMatch ? `ia_${hashMatch[1]}` : 'ia_' + encodeBase64Url(fname);
      const rawTitle = hashMatch ? fname.substring(0, hashMatch.index) : fname.replace(/\.[^/.]+$/, '');
      const cleanTitle = rawTitle.replace(/_+/g, ' ').trim();
      const sizeBytes = parseInt(f.size, 10) || 0;
      const sizeMb = sizeBytes > 0 ? parseFloat((sizeBytes / (1024 * 1024)).toFixed(2)) : null;

      const thumbName = `${fname}_thumb.jpg`;
      const poster = fileNameSet.has(thumbName)
        ? `https://archive.org/download/${itemId}/${encodeURIComponent(thumbName)}`
        : `https://archive.org/services/img/${itemId}`;

      return {
        id: safeId,
        title: cleanTitle,
        filename: fname,
        direct_stream_url: `https://archive.org/download/${itemId}/${encodeURIComponent(fname)}`,
        poster: poster,
        posterShape: 'landscape',
        description: `Uploaded to ${itemId}`,
        duration: 0,
        duration_str: 'Unknown',
        size_bytes: sizeBytes,
        size_mb: sizeMb,
        resolution: 'HD',
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
 * Helper to parse single or multiple video URLs from enqueue request
 */
function parseEnqueueItems(body) {
  const items = [];

  if (Array.isArray(body.urls) && body.urls.length > 0) {
    for (const u of body.urls) {
      if (typeof u === 'string' && u.trim()) {
        items.push({
          video_url: u.trim(),
          custom_title: '',
          imdb_id: '',
          poster_url: '',
        });
      } else if (typeof u === 'object' && u && typeof u.video_url === 'string' && u.video_url.trim()) {
        items.push({
          video_url: u.video_url.trim(),
          custom_title: (u.custom_title || '').trim(),
          imdb_id: (u.imdb_id || '').trim(),
          poster_url: (u.poster_url || '').trim(),
        });
      }
    }
  } else if (typeof body.video_url === 'string' || typeof body.video_urls === 'string') {
    const raw = (body.video_url || body.video_urls || '').trim();
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    for (const line of lines) {
      if (line.includes('|')) {
        const parts = line.split('|');
        const vUrl = parts[0].trim();
        const vTitle = parts.slice(1).join('|').trim();
        if (vUrl) {
          items.push({
            video_url: vUrl,
            custom_title: vTitle,
            imdb_id: (body.imdb_id || '').trim(),
            poster_url: (body.poster_url || '').trim(),
          });
        }
      } else {
        items.push({
          video_url: line,
          custom_title: lines.length === 1 ? (body.custom_title || '').trim() : '',
          imdb_id: lines.length === 1 ? (body.imdb_id || '').trim() : '',
          poster_url: lines.length === 1 ? (body.poster_url || '').trim() : '',
        });
      }
    }
  }

  return items;
}

/**
 * Handle API Enqueue: Trigger GitHub Action repository_dispatch (supports single & bulk URLs)
 */
async function handleEnqueue(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const { admin_pin } = body;

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

  const items = parseEnqueueItems(body);
  if (items.length === 0) {
    return jsonResponse({ success: false, error: 'At least one valid video URL is required' }, 400);
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

  try {
    const dispatchResults = await Promise.all(
      items.map(async (item) => {
        const payload = {
          event_type: 'ingest_video',
          client_payload: {
            video_url: item.video_url,
            custom_title: item.custom_title,
            imdb_id: item.imdb_id,
            poster_url: item.poster_url,
          },
        };

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

        const ok = ghRes.status === 204 || ghRes.status === 200;
        let err = null;
        if (!ok) {
          err = await ghRes.text();
        }

        return {
          video_url: item.video_url,
          custom_title: item.custom_title,
          ok,
          status: ghRes.status,
          error: err,
        };
      })
    );

    const failed = dispatchResults.filter((r) => !r.ok);
    if (failed.length > 0 && failed.length === items.length) {
      return jsonResponse(
        {
          success: false,
          error: `GitHub API error: Failed to dispatch ingestion jobs (${failed[0].status}): ${failed[0].error}`,
        },
        502
      );
    }

    return jsonResponse({
      success: true,
      count: items.length,
      dispatched_count: items.length - failed.length,
      message:
        items.length === 1
          ? 'Ingestion job dispatched to GitHub Actions successfully!'
          : `All ${items.length} ingestion jobs dispatched to GitHub Actions successfully!`,
      jobs: items.map((i) => ({ video_url: i.video_url, custom_title: i.custom_title })),
      target_item: env.IA_ITEM_ID || 'nuvio-cloud-vault-2026',
      repository: `${ghOwner}/${ghRepo}`,
    });
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
      await env.VAULT_KV.delete(`item:${targetFilename}`);
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
 * Handle Catalog Append: Appends newly ingested video to Cloudflare KV.
 * Writes each item under its own distinct 'item:<filename>' key to guarantee
 * zero-contention atomic safety during concurrent bulk ingestion runs, then
 * merges into the master catalog.
 */
async function handleCatalogAppend(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const { entry, entries, admin_pin } = body;
  const itemsToAppend = Array.isArray(entries) ? entries : (entry ? [entry] : []);
  if (itemsToAppend.length === 0 || !itemsToAppend[0].id) {
    return jsonResponse({ success: false, error: 'Valid entry or entries array is required' }, 400);
  }

  const configuredPin = env.ADMIN_PIN;
  if (!configuredPin || String(admin_pin) !== String(configuredPin)) {
    return jsonResponse({ success: false, error: 'Unauthorized: Invalid Admin PIN' }, 401);
  }

  // 1. Immediately store each item under its own individual KV key (atomic, race-condition free)
  if (env.VAULT_KV) {
    for (const item of itemsToAppend) {
      if (item && item.filename) {
        try {
          const meta = {
            id: item.id,
            title: item.title,
            filename: item.filename,
            direct_stream_url: item.direct_stream_url,
            poster: item.poster,
            size_mb: item.size_mb || 0,
            resolution: item.resolution || 'HD',
            duration_str: item.duration_str || 'Unknown',
            added_at: item.added_at || new Date().toISOString(),
          };
          await env.VAULT_KV.put(`item:${item.filename}`, JSON.stringify(item), { metadata: meta });
        } catch (e) {
          console.warn(`Failed to put individual item ${item.filename} in KV:`, e.message);
        }
      }
    }
  }

  // 2. Fetch fresh catalog and merge all items
  const catalog = await fetchCatalog(env, true);

  return jsonResponse({
    success: true,
    message: 'Video appended to catalog successfully!',
    count: catalog.items.length,
  });
}

/**
 * Enrich workflow run with real-time job step execution details & progress percentage
 */
async function enrichRunDetails(run, ghOwner, ghRepo, ghPat) {
  const base = {
    id: run.id,
    name: run.name,
    display_title: run.display_title || run.name,
    status: run.status,
    conclusion: run.conclusion,
    html_url: run.html_url,
    created_at: run.created_at,
    updated_at: run.updated_at,
    run_number: run.run_number,
    current_step: '',
    progress_pct: 0,
  };

  if (run.status === 'completed') {
    base.progress_pct = 100;
    if (run.conclusion === 'success') {
      base.current_step = '✅ Video ingested and catalog updated!';
    } else if (run.conclusion === 'cancelled') {
      base.current_step = '⚠️ Run was cancelled';
    } else {
      base.current_step = '❌ Ingestion failed in runner (check logs)';
    }
    return base;
  }

  // If status is 'queued', runner has not started execution yet
  if (run.status === 'queued') {
    base.current_step = '⏳ Queued in GitHub Actions, waiting for available runner...';
    base.progress_pct = 12;
    return base;
  }

  // If status is 'in_progress', query runner jobs to find exact executing step
  try {
    const jobsRes = await fetch(
      `https://api.github.com/repos/${ghOwner}/${ghRepo}/actions/runs/${run.id}/jobs`,
      {
        headers: {
          'Authorization': `Bearer ${ghPat}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Nuvio-Cloudflare-Worker/1.0',
        },
      }
    );

    if (!jobsRes.ok) {
      base.current_step = '⚡ Processing in GitHub runner...';
      base.progress_pct = 50;
      return base;
    }

    const jobsData = await jobsRes.json();
    const job = (jobsData.jobs || [])[0];

    if (!job) {
      base.current_step = '⏳ Waiting for runner assignment...';
      base.progress_pct = 15;
      return base;
    }

    if (job.status === 'queued') {
      base.current_step = '⏳ Assigned to runner, boot in progress...';
      base.progress_pct = 15;
      return base;
    }

    const steps = job.steps || [];
    const inProgressStep = steps.find((s) => s.status === 'in_progress');
    const stepName = inProgressStep
      ? inProgressStep.name
      : (steps.filter((s) => s.status === 'completed').pop()?.name || 'Initializing runner');

    if (stepName.includes('Set up job') || stepName.includes('Initializing runner')) {
      base.current_step = '⚙️ Initializing GitHub runner environment...';
      base.progress_pct = 18;
    } else if (stepName.includes('Checkout Repository')) {
      base.current_step = '📥 Checking out repository code...';
      base.progress_pct = 28;
    } else if (stepName.includes('Set up Python')) {
      base.current_step = '🐍 Configuring Python 3.11 environment...';
      base.progress_pct = 38;
    } else if (stepName.includes('Install System Dependencies')) {
      base.current_step = '📦 Installing aria2 16-connection accelerator & ffmpeg...';
      base.progress_pct = 52;
    } else if (stepName.includes('Install Python Dependencies')) {
      base.current_step = '📦 Installing yt-dlp & internetarchive tools...';
      base.progress_pct = 68;
    } else if (stepName.includes('Run Video Ingestion Engine')) {
      base.current_step = '⚡ Downloading video & uploading directly to Archive.org vault...';
      base.progress_pct = 86;
    } else if (stepName.includes('Complete job')) {
      base.current_step = '🎉 Finalizing catalog registration...';
      base.progress_pct = 96;
    } else {
      base.current_step = `⚙️ ${stepName}...`;
      base.progress_pct = inProgressStep ? 72 : 82;
    }

    return base;
  } catch (e) {
    base.current_step = '⚡ Processing in GitHub runner...';
    base.progress_pct = 50;
    return base;
  }
}

/**
 * Handle API Runs: Return recent GitHub Actions workflow runs with real-time steps
 */
async function handleGetRuns(env) {
  const ghOwner = env.GH_OWNER;
  const ghRepo = env.GH_REPO;
  const ghPat = env.GITHUB_PAT;

  if (!ghOwner || !ghRepo || !ghPat) {
    return jsonResponse({ runs: [] });
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${ghOwner}/${ghRepo}/actions/runs?per_page=10`,
      {
        headers: {
          'Authorization': `Bearer ${ghPat}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'Nuvio-Cloudflare-Worker/1.0',
        },
      }
    );

    if (!res.ok) {
      return jsonResponse({ runs: [] });
    }

    const data = await res.json();
    const runsList = (data.workflow_runs || [])
      .filter((r) =>
        r.workflow_id === 419200585 ||
        (r.path && r.path.includes('ingest_video.yml')) ||
        r.name === 'Ingest Video to Cloud Vault' ||
        (r.name && r.name.startsWith('Ingest'))
      )
      .slice(0, 10);

    const runs = await Promise.all(
      runsList.map((r) => enrichRunDetails(r, ghOwner, ghRepo, ghPat))
    );

    return jsonResponse({ runs });
  } catch (err) {
    return jsonResponse({ runs: [], error: err.message });
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

    input[type="text"], input[type="url"], input[type="password"], textarea {
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

    textarea {
      resize: vertical;
      min-height: 80px;
      line-height: 1.4;
    }

    input:focus, textarea:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
    }

    .progress-bar-container {
      width: 100%;
      height: 7px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 4px;
      overflow: hidden;
      margin-top: 8px;
    }
    .progress-bar-fill {
      height: 100%;
      background: linear-gradient(90deg, #6366f1, #a855f7);
      border-radius: 4px;
      transition: width 0.35s ease;
    }
    .progress-bar-fill.complete {
      background: linear-gradient(90deg, #10b981, #059669);
    }
    .progress-bar-fill.failed {
      background: linear-gradient(90deg, #ef4444, #dc2626);
    }
    .job-item {
      background: rgba(10, 12, 20, 0.7);
      border: 1px solid rgba(99, 102, 241, 0.25);
      border-radius: 10px;
      padding: 14px;
      margin-bottom: 12px;
      transition: all 0.2s ease;
    }
    .job-item:last-child {
      margin-bottom: 0;
    }
    .job-item.completed {
      border-color: rgba(16, 185, 129, 0.3);
      background: rgba(16, 185, 129, 0.04);
    }
    .job-item.failed {
      border-color: rgba(239, 68, 68, 0.3);
      background: rgba(239, 68, 68, 0.04);
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

    /* Live Ingestion Activity & Badges */
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 0.78rem;
      font-weight: 600;
    }
    .badge-progress {
      background: rgba(99, 102, 241, 0.2);
      color: #a5b4fc;
      border: 1px solid rgba(99, 102, 241, 0.4);
    }
    .badge-success {
      background: rgba(34, 197, 94, 0.2);
      color: #4ade80;
      border: 1px solid rgba(34, 197, 94, 0.4);
    }
    .badge-failed {
      background: rgba(239, 68, 68, 0.2);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.4);
    }
    .pulse-bar {
      width: 100%;
      height: 4px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 2px;
      overflow: hidden;
      margin-top: 10px;
    }
    .pulse-bar-fill {
      width: 45%;
      height: 100%;
      background: linear-gradient(90deg, #6366f1, #a855f7);
      border-radius: 2px;
      animation: pulseAnim 1.4s infinite ease-in-out;
    }
    @keyframes pulseAnim {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(250%); }
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
            <label for="videoUrls">Video Source URL(s) *</label>
            <textarea id="videoUrls" name="video_urls" required rows="3" placeholder="Paste one or multiple video URLs (one per line):&#10;https://example.com/video1.mp4&#10;https://example.com/video2.mp4 | Custom Title 2&#10;https://www.youtube.com/watch?v=..."></textarea>
            <div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 4px; display: flex; gap: 6px; align-items: center;">
              <span>💡</span>
              <span><strong>Bulk Upload Supported:</strong> Paste 1 or multiple URLs (one per line). Format as <code>URL</code> or <code>URL | Custom Title</code>.</span>
            </div>
          </div>

          <div class="form-group">
            <label for="customTitle">Custom Title (Optional for single URL)</label>
            <input type="text" id="customTitle" name="custom_title" placeholder="Override video title">
          </div>

          <div class="form-group">
            <label for="imdbId">IMDb ID (Optional for single URL)</label>
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

    <!-- SECTION 2.5: LIVE INGESTION ACTIVITY & PROGRESS -->
    <div class="card" id="activityCard" style="display: none;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
        <div class="card-title" style="margin-bottom: 0;">
          <span>⚡</span>
          <span>Ingestion Activity & Live Progress</span>
        </div>
        <button id="clearFinishedBtn" class="btn btn-secondary btn-sm" onclick="clearFinishedJobs()" style="display: none; width: auto; padding: 4px 10px; font-size: 0.75rem;">
          ✕ Clear Finished
        </button>
      </div>
      <div id="activityContent"></div>
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
    let pollTimer = null;
    let activeJobs = [];

    // Load active jobs from localStorage
    function loadActiveJobsFromStorage() {
      try {
        const stored = localStorage.getItem('nuvio_active_jobs');
        if (stored) {
          const parsed = JSON.parse(stored);
          const now = Date.now();
          activeJobs = parsed.filter(j => (now - (j.startedAt || 0)) < 2 * 3600 * 1000);
          saveActiveJobsToStorage();
        }
      } catch (_) {
        activeJobs = [];
      }
    }

    function saveActiveJobsToStorage() {
      try {
        localStorage.setItem('nuvio_active_jobs', JSON.stringify(activeJobs));
      } catch (_) {}
    }

    function clearFinishedJobs() {
      activeJobs = activeJobs.filter(j => j.status !== 'completed' && j.status !== 'failed');
      saveActiveJobsToStorage();
      renderActivityCard();
      checkActivity();
    }

    document.addEventListener('DOMContentLoaded', () => {
      const savedPin = localStorage.getItem('nuvio_admin_pin');
      if (savedPin) {
        document.getElementById('adminPin').value = savedPin;
      }
      loadActiveJobsFromStorage();
      loadCatalog();
      renderActivityCard();
      checkActivity();
    });

    function copyManifest() {
      const url = document.getElementById('manifestUrl').innerText;
      navigator.clipboard.writeText(url).then(() => {
        alert('Manifest URL copied to clipboard! Paste it into Nuvio or Stremio.');
      });
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function formatTimeAgo(isoStr) {
      if (!isoStr) return '';
      const diffMs = Date.now() - new Date(isoStr).getTime();
      const mins = Math.floor(diffMs / 60000);
      if (mins < 1) return 'just now';
      if (mins === 1) return '1 min ago';
      if (mins < 60) return mins + ' mins ago';
      const hours = Math.floor(mins / 60);
      return hours + 'h ago';
    }

    function extractNameFromUrl(url) {
      try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts.length > 0) {
          return decodeURIComponent(parts[parts.length - 1]);
        }
        return u.hostname;
      } catch (_) {
        return url.substring(0, 35) + '...';
      }
    }

    // Render the activity card based on activeJobs & remote runs
    function renderActivityCard(remoteRuns = []) {
      const card = document.getElementById('activityCard');
      const content = document.getElementById('activityContent');
      const clearBtn = document.getElementById('clearFinishedBtn');

      // Check if there are active client jobs
      const hasClientJobs = activeJobs && activeJobs.length > 0;
      const hasFinishedClientJobs = hasClientJobs && activeJobs.some(j => j.status === 'completed' || j.status === 'failed');

      if (clearBtn) {
        clearBtn.style.display = hasFinishedClientJobs ? 'inline-flex' : 'none';
      }

      if (hasClientJobs) {
        card.style.display = 'block';
        content.innerHTML = activeJobs.map(job => {
          let badgeClass = 'badge-progress';
          let badgeText = '⏳ Dispatching...';
          let fillClass = '';

          if (job.status === 'dispatching') {
            badgeText = '🚀 Dispatching...';
            badgeClass = 'badge-progress';
          } else if (job.status === 'queued') {
            badgeText = job.runNumber ? ('⏳ Queued #' + job.runNumber) : '⏳ Waiting for Runner...';
            badgeClass = 'badge-progress';
          } else if (job.status === 'in_progress') {
            badgeText = '⚡ Ingesting ' + (job.runNumber ? ('#' + job.runNumber) : '') + ' (' + job.progress + '%)';
            badgeClass = 'badge-progress';
          } else if (job.status === 'completed') {
            badgeText = '✅ Complete ' + (job.runNumber ? ('#' + job.runNumber) : '');
            badgeClass = 'badge-success';
            fillClass = 'complete';
          } else if (job.status === 'failed') {
            badgeText = '❌ Failed ' + (job.runNumber ? ('#' + job.runNumber) : '');
            badgeClass = 'badge-failed';
            fillClass = 'failed';
          }

          const consoleLink = job.htmlUrl ? 
            \`<a href="\${escapeHtml(job.htmlUrl)}" target="_blank" class="btn btn-secondary btn-sm" style="padding: 3px 9px; font-size: 0.73rem; width: auto;">🔗 Console Log</a>\` : '';

          const itemClass = (job.status === 'completed') ? 'job-item completed' : ((job.status === 'failed') ? 'job-item failed' : 'job-item');

          return \`
            <div class="\${itemClass}">
              <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; margin-bottom: 6px;">
                <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                  <span class="badge \${badgeClass}">\${badgeText}</span>
                  <strong style="font-size: 0.92rem; color: #f1f5f9;">\${escapeHtml(job.title)}</strong>
                </div>
                \${consoleLink}
              </div>
              <div style="font-size: 0.78rem; color: var(--text-muted); word-break: break-all; margin-bottom: 6px;">
                🔗 \${escapeHtml(job.url)}
              </div>
              <div style="display: flex; justify-content: space-between; font-size: 0.82rem; color: #cbd5e1; margin-top: 6px;">
                <span>\${escapeHtml(job.step || 'Processing...')}</span>
                <span style="font-weight: 700; color: #a5b4fc;">\${job.progress}%</span>
              </div>
              <div class="progress-bar-container">
                <div class="progress-bar-fill \${fillClass}" style="width: \${job.progress}%;"></div>
              </div>
            </div>
          \`;
        }).join('');
        return;
      }

      // If no client jobs stored locally, check remote runs from GitHub
      if (remoteRuns.length === 0) {
        card.style.display = 'none';
        return;
      }

      card.style.display = 'block';
      const activeRuns = remoteRuns.filter(r => r.status === 'in_progress' || r.status === 'queued');

      if (activeRuns.length > 0) {
        content.innerHTML = activeRuns.map(run => {
          const runNum = run.run_number ? ('#' + run.run_number) : '';
          const displayTitle = run.display_title || run.name || 'Video Ingestion';
          const pct = run.progress_pct || (run.status === 'queued' ? 12 : 50);
          const step = run.current_step || (run.status === 'queued' ? 'Queued in GitHub Actions...' : '⚡ Processing in GitHub runner...');
          
          return \`
            <div class="job-item">
              <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; margin-bottom: 6px;">
                <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                  <span class="badge badge-progress">⚡ Ingesting \${runNum} (\${pct}%)</span>
                  <strong style="font-size: 0.92rem; color: #f1f5f9;">\${escapeHtml(displayTitle)}</strong>
                </div>
                <a href="\${escapeHtml(run.html_url)}" target="_blank" class="btn btn-secondary btn-sm" style="padding: 3px 9px; font-size: 0.73rem; width: auto;">🔗 Console Log</a>
              </div>
              <div style="display: flex; justify-content: space-between; font-size: 0.82rem; color: #cbd5e1; margin-top: 6px;">
                <span>\${escapeHtml(step)}</span>
                <span style="font-weight: 700; color: #a5b4fc;">\${pct}%</span>
              </div>
              <div class="progress-bar-container">
                <div class="progress-bar-fill" style="width: \${pct}%;"></div>
              </div>
            </div>
          \`;
        }).join('');
      } else {
        const latest = remoteRuns[0];
        const isSuccess = latest.conclusion === 'success';
        const badgeClass = isSuccess ? 'badge-success' : 'badge-failed';
        const badgeIcon = isSuccess ? '✅ Ingest Complete' : '❌ Ingest Failed';
        const timeAgo = formatTimeAgo(latest.created_at);

        content.innerHTML = \`
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 0;">
            <div>
              <span class="badge \${badgeClass}">\${badgeIcon}</span>
              <span style="font-size: 0.85rem; font-weight: 600; color: #f1f5f9; margin-left: 8px;">Run #\${latest.run_number}</span>
              <span style="font-size: 0.8rem; color: var(--text-muted); margin-left: 6px;">(\${timeAgo})</span>
              <div style="font-size: 0.8rem; color: #94a3b8; margin-top: 4px;">\${escapeHtml(latest.current_step || 'Vault catalog synchronized.')}</div>
            </div>
            <a href="\${escapeHtml(latest.html_url)}" target="_blank" class="btn btn-secondary btn-sm" style="padding: 4px 10px; font-size: 0.75rem; width: auto;">Console Log</a>
          </div>
        \`;
      }
    }

    async function checkActivity() {
      try {
        const res = await fetch('/api/runs?_t=' + Date.now());
        const data = await res.json();
        const runs = data.runs || [];

        // Sync runs with active client jobs
        if (activeJobs.length > 0) {
          syncRunsWithJobs(runs);
        }

        renderActivityCard(runs);

        // Check if any jobs or runs are still active
        const hasPendingJobs = activeJobs.some(j => j.status === 'dispatching' || j.status === 'queued' || j.status === 'in_progress');
        const hasActiveRuns = runs.some(r => r.status === 'in_progress' || r.status === 'queued');

        if (hasPendingJobs || hasActiveRuns) {
          if (pollTimer) clearTimeout(pollTimer);
          pollTimer = setTimeout(checkActivity, 2500);
        } else {
          if (pollTimer) {
            clearTimeout(pollTimer);
            pollTimer = null;
          }
        }
      } catch (err) {
        console.warn('Check activity error:', err);
        if (activeJobs.some(j => j.status === 'dispatching' || j.status === 'queued' || j.status === 'in_progress')) {
          if (pollTimer) clearTimeout(pollTimer);
          pollTimer = setTimeout(checkActivity, 3500);
        }
      }
    }

    function syncRunsWithJobs(runs) {
      let catalogNeedsReload = false;

      // Group or match runs
      for (const job of activeJobs) {
        if (job.status === 'completed' || job.status === 'failed') continue;

        // Try to find matching run
        let matchedRun = null;
        if (job.runId) {
          matchedRun = runs.find(r => r.id === job.runId);
        } else {
          const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          const normTitle = norm(job.title);
          const normUrl = norm(job.url);

          matchedRun = runs.find(r => {
            const normDisp = norm(r.display_title || r.name);
            return (normTitle && (normDisp.includes(normTitle) || normTitle.includes(normDisp))) ||
                   (normUrl && normDisp.includes(normUrl));
          });

          if (!matchedRun && runs.length > 0) {
            // Find run created around or after job started
            const candidate = runs.find(r => {
              const runTime = new Date(r.created_at).getTime();
              return runTime >= (job.startedAt - 90000);
            });
            if (candidate && !activeJobs.some(j => j.runId === candidate.id)) {
              matchedRun = candidate;
            }
          }
        }

        if (matchedRun) {
          job.runId = matchedRun.id;
          job.runNumber = matchedRun.run_number;
          job.htmlUrl = matchedRun.html_url;

          if (matchedRun.status === 'completed') {
            job.status = matchedRun.conclusion === 'success' ? 'completed' : 'failed';
            job.progress = 100;
            job.step = matchedRun.current_step || (matchedRun.conclusion === 'success' ? '✅ Complete!' : '❌ Failed');
            if (matchedRun.conclusion === 'success' && !job.catalogRefreshed) {
              job.catalogRefreshed = true;
              catalogNeedsReload = true;
            }
          } else {
            job.status = matchedRun.status; // 'in_progress' or 'queued'
            job.progress = Math.max(job.progress || 20, matchedRun.progress_pct || 25);
            job.step = matchedRun.current_step || '⚡ Executing in GitHub runner...';
          }
        } else {
          // Still waiting for GitHub to instantiate the run (takes 3-10s)
          const elapsed = Date.now() - job.startedAt;
          if (elapsed > 10000 && job.progress < 22) {
            job.progress = 22;
            job.step = '⏳ Provisioning GitHub runner environment...';
          } else if (elapsed > 4000 && job.progress < 18) {
            job.progress = 18;
            job.step = '⏳ Dispatched! Waiting for GitHub runner to initialize...';
          }
        }
      }

      saveActiveJobsToStorage();

      if (catalogNeedsReload) {
        loadCatalog(true);
      }
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

      const rawUrls = document.getElementById('videoUrls').value.trim();
      const customTitleInput = document.getElementById('customTitle').value.trim();
      const imdbIdInput = document.getElementById('imdbId').value.trim();
      const posterUrlInput = document.getElementById('posterUrl').value.trim();

      const lines = rawUrls.split(String.fromCharCode(10)).map(l => l.trim()).filter(Boolean);
      if (lines.length === 0) {
        alertBox.className = 'alert error';
        alertBox.style.display = 'flex';
        alertBox.innerHTML = '❌ Please enter at least one valid video URL.';
        return;
      }

      // Parse items
      const itemsToEnqueue = [];
      for (const line of lines) {
        if (line.includes('|')) {
          const parts = line.split('|');
          itemsToEnqueue.push({
            video_url: parts[0].trim(),
            custom_title: parts.slice(1).join('|').trim(),
            imdb_id: imdbIdInput,
            poster_url: posterUrlInput,
          });
        } else {
          itemsToEnqueue.push({
            video_url: line,
            custom_title: lines.length === 1 ? customTitleInput : '',
            imdb_id: lines.length === 1 ? imdbIdInput : '',
            poster_url: lines.length === 1 ? posterUrlInput : '',
          });
        }
      }

      // 0-MILLISECOND INSTANT UI UPDATE: Create client jobs and render immediately
      const now = Date.now();
      const newJobs = itemsToEnqueue.map((item, idx) => ({
        id: 'job_' + now + '_' + idx + '_' + Math.random().toString(36).substr(2, 4),
        url: item.video_url,
        title: item.custom_title || extractNameFromUrl(item.video_url),
        status: 'dispatching',
        step: '🚀 Dispatching job to GitHub Actions...',
        progress: 10,
        startedAt: now,
        runId: null,
        runNumber: null,
        htmlUrl: null,
        catalogRefreshed: false,
      }));

      activeJobs = [...newJobs, ...activeJobs];
      saveActiveJobsToStorage();

      // Show activity card instantly
      renderActivityCard();

      // Update button state
      btn.disabled = true;
      btn.innerHTML = '⏳ Dispatching ' + itemsToEnqueue.length + ' video' + (itemsToEnqueue.length === 1 ? '' : 's') + '...';

      // Clear input form
      document.getElementById('videoUrls').value = '';
      document.getElementById('customTitle').value = '';
      document.getElementById('imdbId').value = '';
      document.getElementById('posterUrl').value = '';

      alertBox.className = 'alert success';
      alertBox.style.display = 'flex';
      alertBox.innerHTML = '✅ <strong>Ingestion Triggered!</strong> ' + 
        (itemsToEnqueue.length === 1 ? 'Video job dispatched' : itemsToEnqueue.length + ' video jobs dispatched') + 
        '. Track live runner progress below.';

      try {
        const res = await fetch('/api/enqueue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            urls: itemsToEnqueue,
            admin_pin: pin
          })
        });

        const data = await res.json();

        if (res.ok && data.success) {
          // Update newly added jobs
          for (const j of newJobs) {
            j.status = 'queued';
            j.step = '⚡ Dispatched! GitHub Actions runner is spinning up...';
            j.progress = 20;
          }
          saveActiveJobsToStorage();
          renderActivityCard();

          // Start aggressive polling loop
          if (pollTimer) clearTimeout(pollTimer);
          pollTimer = setTimeout(checkActivity, 1500);
        } else {
          for (const j of newJobs) {
            j.status = 'failed';
            j.step = '❌ ' + (data.error || 'Failed to dispatch');
            j.progress = 100;
          }
          saveActiveJobsToStorage();
          renderActivityCard();

          alertBox.className = 'alert error';
          alertBox.style.display = 'flex';
          alertBox.innerHTML = '❌ <strong>Error:</strong> ' + (data.error || 'Failed to trigger ingestion');
        }
      } catch (err) {
        for (const j of newJobs) {
          j.status = 'failed';
          j.step = '❌ Network Error: ' + err.message;
          j.progress = 100;
        }
        saveActiveJobsToStorage();
        renderActivityCard();

        alertBox.className = 'alert error';
        alertBox.style.display = 'flex';
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
          const poster = item.poster || ('https://archive.org/services/img/' + (data.itemId || '${itemId}'));
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
                  <button class="btn btn-danger btn-sm" onclick="onDeleteBtnClick(this)" data-id="\${encodeURIComponent(item.id)}" data-filename="\${encodeURIComponent(item.filename || '')}" data-title="\${encodeURIComponent(item.title || '')}" style="flex: 1;">🗑️ Delete</button>
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

    function onDeleteBtnClick(btn) {
      const id = decodeURIComponent(btn.getAttribute('data-id') || '');
      const filename = decodeURIComponent(btn.getAttribute('data-filename') || '');
      const title = decodeURIComponent(btn.getAttribute('data-title') || '');
      deleteVideo(id, filename, title);
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
          alertBox.style.display = 'flex';
          alertBox.innerHTML = '✅ ' + data.message;
          await loadCatalog();
        } else {
          alertBox.className = 'alert error';
          alertBox.style.display = 'flex';
          alertBox.innerHTML = '❌ Delete failed: ' + (data.error || 'Unknown error');
        }
      } catch (err) {
        alertBox.className = 'alert error';
        alertBox.style.display = 'flex';
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
