/**
 * Merge old manifest's resolved asset IDs into fresh manifest.
 * The fresh manifest has correct structure (only BG containers are hybrid)
 * but empty exportedImages. The old manifest has many leaf PNGs already uploaded.
 * We merge: fresh structure + image cache asset IDs pre-applied to nodes.
 *
 * Reads from .figmaforge-image-cache.json to get all previously uploaded IDs.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { FigmaForgeNode } from './figma-forge-ir';

const freshPath = path.resolve('./manifest_DailyRewardModal_fresh.json');
const oldPath = path.resolve('./manifest_DailyRewardModal.json');
const cachePath = path.resolve('./.figmaforge-image-cache.json');

const freshRaw = fs.existsSync(freshPath) ? fs.readFileSync(freshPath, 'utf-8') : null;
const oldRaw = fs.readFileSync(oldPath, 'utf-8');

const oldData = JSON.parse(oldRaw);
const oldManifest = oldData.result || oldData;

if (!freshRaw) {
  console.log('No fresh manifest found. Using old manifest as-is.');
  process.exit(0);
}

const freshManifest = JSON.parse(freshRaw);

// ─── Load image cache (source of truth for uploaded asset IDs) ────────────
interface CacheEntry { imageHash: string; assetId: string; uploadedAt: string; }
interface Cache { version: string; entries: Record<string, CacheEntry>; }

const imageCache: Cache = fs.existsSync(cachePath)
  ? JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
  : { version: '1.0.0', entries: {} };

console.log(`Image cache entries: ${Object.keys(imageCache.entries).length}`);

// ─── Create a map of old manifest nodes by Figma ID ───────────────────────
const oldNodeMap = new Map<string, FigmaForgeNode>();
function populateOldNodeMap(node: FigmaForgeNode) {
  if (node.id) {
    oldNodeMap.set(node.id, node);
  }
  for (const child of node.children || []) {
    populateOldNodeMap(child);
  }
}
populateOldNodeMap(oldManifest.root);
console.log(`Old manifest nodes mapped: ${oldNodeMap.size}`);

// ─── Transfer _rasterizedImageHash from old to fresh manifest nodes ──────
let transferredRasterHashes = 0;
function transferRasterHashes(freshNode: FigmaForgeNode, oldNodeMap: Map<string, FigmaForgeNode>) {
  if (freshNode.id) {
    // Transfer raster hash from old manifest to preserve cached image uploads.
    // All hybrid containers AND leaf nodes can have raster hashes —
    // extract now rasterizes containers with children hidden (background-only PNG).
    const oldNode = oldNodeMap.get(freshNode.id);
    if (oldNode && oldNode._rasterizedImageHash && !freshNode._rasterizedImageHash) {
      freshNode._rasterizedImageHash = oldNode._rasterizedImageHash;
      transferredRasterHashes++;
    }
  }
  for (const child of freshNode.children || []) {
    transferRasterHashes(child, oldNodeMap);
  }
}
transferRasterHashes(freshManifest.root, oldNodeMap);
console.log(`Transferred ${transferredRasterHashes} _rasterizedImageHash from old to fresh manifest.`);

// ─── Pre-apply cached asset IDs to fresh manifest nodes ──────────────────
// Walk tree, find nodes with _rasterizedImageHash in cache → set _resolvedImageId
let preResolved = 0;
function applyFromCache(node: FigmaForgeNode, cache: Record<string, CacheEntry>): number {
  let count = 0;
  if (node._rasterizedImageHash && cache[node._rasterizedImageHash]) {
    node._resolvedImageId = `rbxthumb://type=Asset&id=${cache[node._rasterizedImageHash].assetId}&w=420&h=420`;
    // console.log(`  ✅ Pre-resolved [${node.name}] ${node._rasterizedImageHash} → ${node._resolvedImageId}`);
    count++;
  }
  for (const child of node.children || []) {
    count += applyFromCache(child, cache);
  }
  return count;
}

preResolved = applyFromCache(freshManifest.root, imageCache.entries);
console.log(`Pre-resolved ${preResolved} nodes from cache`);

// ─── Merge old exportedImages (base64) for fill hashes we don't have yet ─
const oldExported = oldManifest.exportedImages || {};
freshManifest.exportedImages = { ...oldExported };
console.log(`Base64 blobs from old manifest: ${Object.keys(oldExported).length}`);

// ─── Recalculate unresolvedImages ─────────────────────────────────────────
// Only include hashes that are NOT already resolved AND NOT in cache
function collectUnresolved(
  node: FigmaForgeNode,
  out: string[],
  cache: Record<string, CacheEntry>,
  exported: Record<string, string>,
) {
  // Raster hash: skip if already resolved or in cache
  if (node._rasterizedImageHash && !node._resolvedImageId && !cache[node._rasterizedImageHash]) {
    if (!out.includes(node._rasterizedImageHash)) out.push(node._rasterizedImageHash);
  }
  // Figma IMAGE fill hashes
  for (const fill of node.fills || []) {
    if (fill.type === 'IMAGE' && fill.imageHash && !cache[fill.imageHash] && !exported[fill.imageHash]) {
      if (!out.includes(fill.imageHash)) out.push(fill.imageHash);
    }
  }
  for (const child of node.children || []) {
    collectUnresolved(child, out, cache, exported);
  }
}

const newUnresolved: string[] = [];
collectUnresolved(freshManifest.root, newUnresolved, imageCache.entries, freshManifest.exportedImages);
freshManifest.unresolvedImages = newUnresolved;

console.log(`\nFresh manifest stats:`);
console.log(`  Total nodes: ${freshManifest.stats?.totalNodes}`);
console.log(`  Transferred raster hashes: ${transferredRasterHashes}`);
console.log(`  Pre-resolved from cache: ${preResolved}`);
console.log(`  Still unresolved: ${newUnresolved.length} (${JSON.stringify(newUnresolved.slice(0, 3))}...)`);

fs.writeFileSync('./manifest_DailyRewardModal_merged.json', JSON.stringify(freshManifest, null, 2));
console.log('\nWritten: manifest_DailyRewardModal_merged.json');
