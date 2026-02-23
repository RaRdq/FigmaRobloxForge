/**
 * FigmaForge Image Pipeline
 * 
 * Resolves IMAGE fills from the IR by:
 * 1. Writing base64 PNG data to temp files
 * 2. Uploading via the existing roblox_upload.py script
 * 3. Caching imageHash → rbxassetid to avoid re-uploads
 * 4. Patching _resolvedImageId on matching IR nodes
 * 
 * Config priority: ROBLOX_API_KEY env → .env file → scripts/roblox-config.json
 */

import * as fs from 'fs';
import * as path from 'path';
import type { FigmaForgeNode, FigmaForgeManifest } from './figma-forge-ir';

// ─── Types ───────────────────────────────────────────────────────

interface ImageCacheEntry {
  imageHash: string;
  assetId: string;
  uploadedAt: string;
}

interface ImageCache {
  version: '1.0.0';
  entries: Record<string, ImageCacheEntry>; // keyed by imageHash
}

interface ResolveResult {
  resolved: number;
  cached: number;
  failed: number;
  errors: string[];
}

// ─── Config Loading ──────────────────────────────────────────────

/**
 * Load Roblox API config via file-based fallback chain.
 * NOTE: CLI args (--api-key, --creator-id) take highest priority via setConfig().
 * This function is only called if CLI args were NOT provided.
 * 
 * Fallback priority:
 * 1. Environment variables (ROBLOX_API_KEY, ROBLOX_CREATOR_ID)
 * 2. .env file in FigmaForge directory
 * 3. scripts/roblox-config.json (project root fallback)
 */
function loadConfig(): { apiKey: string; creatorId: string } {
  // Priority 1: Environment variables
  if (process.env.ROBLOX_API_KEY && process.env.ROBLOX_CREATOR_ID) {
    return {
      apiKey: process.env.ROBLOX_API_KEY,
      creatorId: process.env.ROBLOX_CREATOR_ID,
    };
  }

  // Priority 2: .env file
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const envVars: Record<string, string> = {};
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        envVars[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
      }
    }
    if (envVars.ROBLOX_API_KEY && envVars.ROBLOX_CREATOR_ID) {
      return {
        apiKey: envVars.ROBLOX_API_KEY,
        creatorId: envVars.ROBLOX_CREATOR_ID,
      };
    }
  }

  // Priority 3: scripts/roblox-config.json
  const configPaths = [
    path.resolve(__dirname, '..', '..', '..', 'scripts', 'roblox-config.json'),
    path.resolve(__dirname, '..', '..', 'scripts', 'roblox-config.json'),
    path.resolve(process.cwd(), '..', 'scripts', 'roblox-config.json'),
    path.resolve(process.cwd(), 'scripts', 'roblox-config.json'),
  ];
  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.apiKey && config.creatorId) {
        return {
          apiKey: config.apiKey,
          creatorId: config.creatorId,
        };
      }
    }
  }

  throw new Error(
    '[FigmaForge] No Roblox API config found.\n' +
    '  Set ROBLOX_API_KEY and ROBLOX_CREATOR_ID env vars,\n' +
    '  create a .env file in the FigmaForge directory,\n' +
    '  or ensure scripts/roblox-config.json exists.'
  );
}

/** Cached config — loaded once per process, not per upload */
let _cachedConfig: { apiKey: string; creatorId: string } | null = null;

/**
 * Inject config from CLI params — highest priority, skips all file-based loading.
 * Call this BEFORE any image uploads if CLI params are provided.
 */
export function setConfig(apiKey: string, creatorId: string): void {
  _cachedConfig = { apiKey, creatorId };
}

function getConfig(): { apiKey: string; creatorId: string } {
  if (!_cachedConfig) _cachedConfig = loadConfig();
  return _cachedConfig;
}

// ─── Image Cache ─────────────────────────────────────────────────

const CACHE_PATH = path.join(__dirname, '.figmaforge-image-cache.json');

function loadImageCache(): ImageCache {
  if (fs.existsSync(CACHE_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    } catch (err: any) {
      console.warn(`[FigmaForge] ⚠ Image cache corrupt, resetting: ${err.message}`);
    }
  }
  return { version: '1.0.0', entries: {} };
}

function saveImageCache(cache: ImageCache): void {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
}

// ─── Upload via Roblox Open Cloud API (native TypeScript) ────────

const ASSETS_API_URL = 'https://apis.roblox.com/assets/v1/assets';
const RATE_LIMIT_DELAY_MS = 1500;

/**
 * Poll an async operation until done.
 * Roblox may return an operation path instead of immediate result.
 */
async function pollOperation(operationPath: string, apiKey: string, maxAttempts: number = 60): Promise<any> {
  const url = operationPath.startsWith('http')
    ? operationPath
    : operationPath.includes('assets/v1/')
      ? `https://apis.roblox.com/${operationPath}`
      : `https://apis.roblox.com/assets/v1/${operationPath}`;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const resp = await fetch(url, {
        headers: { 'x-api-key': apiKey },
      });
      if (resp.ok) {
        const result = await resp.json() as any;
        if (result.done) return result;
      }
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Operation polling timed out after 120s');
}

/**
 * Removed resolveDecalToImageId since we now upload Images directly.
 */

/**
 * Upload a single PNG image buffer to Roblox as an Image via Open Cloud API.
 * Uses manual multipart construction with explicit Content-Length (Node.js native
 * FormData sends empty body to Roblox).
 * Returns the Image assetId string. Throws on failure.
 */
async function uploadToRoblox(imageBuffer: Buffer, displayName: string): Promise<string> {
  const config = getConfig();
  const boundary = `----FigmaForge${Date.now()}`;
  const CRLF = '\r\n';

  const requestBody = JSON.stringify({
    assetType: 'Image',
    displayName: displayName.slice(0, 50),
    description: 'Uploaded by FigmaForge image pipeline',
    creationContext: {
      creator: { userId: config.creatorId },
    },
  });

  // Build multipart body with proper CRLF and Buffer handling
  const preamble = Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="request"${CRLF}` +
    `Content-Type: application/json${CRLF}` +
    `${CRLF}` +
    requestBody +
    `${CRLF}` +
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="fileContent"; filename="${displayName}.png"${CRLF}` +
    `Content-Type: image/png${CRLF}` +
    `${CRLF}`
  );
  const epilogue = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
  const body = Buffer.concat([preamble, imageBuffer, epilogue]);


  const resp = await fetch(ASSETS_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': config.apiKey.trim(),
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Roblox API HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }

  const result = await resp.json() as any;
  let decalId: string | undefined;

  // Check if directly done
  if (result.done) {
    decalId = result.response?.assetId ? String(result.response.assetId) : undefined;
  }

  // Poll async operation
  if (!decalId && result.path) {
    const final = await pollOperation(result.path, config.apiKey);
    decalId = final?.response?.assetId ? String(final.response.assetId) : undefined;
  }

  // Direct assetId in response
  if (!decalId && result.assetId) {
    decalId = String(result.assetId);
  }

  if (!decalId) {
    throw new Error(`[FigmaForge] Could not extract Decal assetId from Roblox response: ${JSON.stringify(result).slice(0, 300)}`);
  }

  // Return the raw Decal ID — we use rbxthumb:// format in the URL builder
  // to resolve Decal assets for ImageLabel.Image display.
  // Open Cloud API Decal uploads: ID+1 does NOT exist, rbxassetid:// with
  // Decal ID shows blank. rbxthumb:// is the official Roblox solution.
  console.log(`[FigmaForge]   ✅ Decal asset ${decalId} (Approved)`);
  return decalId;
}

// ─── Tree Walker ─────────────────────────────────────────────────

/** Collect all nodes with unresolved IMAGE fills OR rasterized gradients */
function collectImageNodes(node: FigmaForgeNode, results: FigmaForgeNode[]): void {
  const hasImage = (node.fills ?? []).some(f => f.type === 'IMAGE' && f.visible && f.imageHash);
  const hasRasterizedGradient = !!node._rasterizedImageHash;
  if ((hasImage || hasRasterizedGradient) && !node._resolvedImageId) {
    results.push(node);
  }
  if (node.children) {
    for (const child of node.children) {
      collectImageNodes(child, results);
    }
  }
}

/** Apply resolved IDs to all nodes matching an imageHash or rasterizedImageHash */
function applyResolvedId(node: FigmaForgeNode, imageHash: string, assetId: string): void {
  const hasMatch = (node.fills ?? []).some(f => f.type === 'IMAGE' && f.visible && f.imageHash === imageHash);
  const hasRasterMatch = node._rasterizedImageHash === imageHash;
  if (hasMatch || hasRasterMatch) {
    node._resolvedImageId = `rbxassetid://${assetId}`;
  }
  if (node.children) {
    for (const child of node.children) {
      applyResolvedId(child, imageHash, assetId);
    }
  }
}

// ─── Raster Hash Backfill ────────────────────────────────────────

/**
 * Pre-pass: backfill `_rasterizedImageHash` on IR nodes whose IDs match
 * `raster_{nodeId}` keys in `unresolvedImages`.
 *
 * The extraction step generates `raster_52_480` keys (nodeId `52:480` with
 * `:` → `_`), but doesn't set `_rasterizedImageHash` on the IR node.
 * Without this, `applyResolvedId` can never match uploaded assets to nodes.
 */
function backfillRasterHashes(root: FigmaForgeNode, unresolvedImages: string[], verbose: boolean): number {
  // Build nodeId → rasterKey lookup from unresolvedImages
  const RASTER_PREFIX = 'raster_';
  const nodeIdToRasterKey = new Map<string, string>();
  for (const key of unresolvedImages) {
    if (!key.startsWith(RASTER_PREFIX)) continue;
    // raster_52_480 → nodeId 52:480 (first _ after prefix is the colon separator)
    const suffix = key.slice(RASTER_PREFIX.length); // "52_480"
    const underscoreIdx = suffix.indexOf('_');
    if (underscoreIdx === -1) continue;
    const nodeId = suffix.slice(0, underscoreIdx) + ':' + suffix.slice(underscoreIdx + 1);
    nodeIdToRasterKey.set(nodeId, key);
  }

  if (nodeIdToRasterKey.size === 0) return 0;

  let patched = 0;
  function walk(node: FigmaForgeNode): void {
    if (node.id && nodeIdToRasterKey.has(node.id) && !node._rasterizedImageHash) {
      node._rasterizedImageHash = nodeIdToRasterKey.get(node.id)!;
      patched++;
    }
    if (node.children) {
      for (const child of node.children) walk(child);
    }
  }
  walk(root);

  if (verbose) console.log(`[FigmaForge] ♻️  Backfilled _rasterizedImageHash on ${patched}/${nodeIdToRasterKey.size} nodes`);
  return patched;
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Resolve all unresolved IMAGE fills in a manifest.
 * 
 * Requires either:
 * - exportedImages map on manifest (base64 data keyed by imageHash)
 * - OR pre-exported PNG files in a temp directory
 * 
 * @param manifest - The FigmaForge manifest with unresolvedImages
 * @param exportedImages - Map of imageHash → base64 PNG data
 * @param verbose - Log progress
 */
export async function resolveImages(
  manifest: FigmaForgeManifest,
  exportedImages: Record<string, string>,
  verbose: boolean = false,
): Promise<ResolveResult> {
  const result: ResolveResult = { resolved: 0, cached: 0, failed: 0, errors: [] };

  if (manifest.unresolvedImages.length === 0) {
    if (verbose) console.log('[FigmaForge] No unresolved images — skipping image pipeline');
    return result;
  }

  // Backfill _rasterizedImageHash for raster_* keys (extraction doesn't set this)
  backfillRasterHashes(manifest.root, manifest.unresolvedImages, verbose);

  // Validate config exists before starting — fail fast, don't bury in result.errors
  getConfig();

  const cache = loadImageCache();

  for (const imageHash of manifest.unresolvedImages) {
    // Check cache first
    if (cache.entries[imageHash]) {
      const cached = cache.entries[imageHash];
      if (verbose) console.log(`[FigmaForge]   📦 Cached: ${imageHash.slice(0, 12)}... → rbxassetid://${cached.assetId}`);
      applyResolvedId(manifest.root, imageHash, cached.assetId);
      result.cached++;
      continue;
    }

    // Get base64 data
    const base64 = exportedImages[imageHash];
    if (!base64) {
      // FAIL FAST: Missing image data means the .rbxmx will have missing textures.
      throw new Error(`[FigmaForge] ❌ FAIL-FAST: Image hash ${imageHash.slice(0, 12)}... has no exported data. Run image export step first!`);
    }

    // Decode to buffer (no temp file needed)
    const imageBuffer = Buffer.from(base64, 'base64');
    const displayName = `figmaforge_${imageHash.slice(0, 8)}`;

    if (verbose) console.log(`[FigmaForge]   🔄 Uploading: ${imageHash.slice(0, 12)}... (${(imageBuffer.length / 1024).toFixed(1)}KB)`);

    try {
      const assetId = await uploadToRoblox(imageBuffer, displayName);
      cache.entries[imageHash] = {
        imageHash,
        assetId,
        uploadedAt: new Date().toISOString(),
      };
      applyResolvedId(manifest.root, imageHash, assetId);
      result.resolved++;
      if (verbose) console.log(`[FigmaForge]   ✅ rbxassetid://${assetId}`);

      // Rate limit between uploads
      if (result.resolved < manifest.unresolvedImages.length) {
        await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));
      }
    } catch (uploadErr: any) {
      // FAIL FAST: Abort the entire pipeline on upload failure to prevent broken RBXMX
      throw new Error(`[FigmaForge] ❌ FAIL-FAST: Image upload failed for ${imageHash.slice(0, 12)}...: ${uploadErr.message}`);
    }
  }

  // Save cache along the way (in case it fails midway, we already updated it in memory, but let's save what we have)
  saveImageCache(cache);

  if (verbose) {
    console.log(`[FigmaForge] Image pipeline: ${result.resolved} uploaded, ${result.cached} cached, ${result.failed} failed`);
  }

  return result;
}
