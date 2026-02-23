/**
 * FigmaForge Turbo Extractor
 * 
 * Production-scale batch extraction orchestrator.
 * 
 * Problem: figma_execute has a 30s timeout. A modal with 17+ PNG nodes times out.
 * Solution: 
 *   1. Generate a fast "tree-only" extraction script (no PNG export, ~1s)
 *   2. Parse the rasterQueue from the result
 *   3. Generate N batch export scripts, each processing BATCH_SIZE images
 *   4. Generate a NodeJS merge script to reassemble the manifest
 * 
 * Usage:
 *   node dist/figma-forge-turbo-extract.js --node <NODE_ID> --output <manifest.json> [--batch-size 3] [--scale 2]
 * 
 * Output files:
 *   - batch_script_0.js, batch_script_1.js, ... — run each via figma_execute
 *   - batch_merge.js — run locally to merge results into manifest.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { buildExtractionScript } from './figma-forge-extract';
import { DEFAULT_CONFIG, FigmaForgeConfig } from './figma-forge-shared';

const BATCH_SIZE_DEFAULT = 3; // 3 PNGs per 30s call (safe budget)
const SCALE_DEFAULT = 2;

interface TurboArgs {
  nodeId: string;
  output: string;
  batchSize: number;
  scale: number;
  config: string;
}

function parseArgs(): TurboArgs {
  const args = process.argv.slice(2);
  const result: TurboArgs = {
    nodeId: '',
    output: 'manifest_turbo.json',
    batchSize: BATCH_SIZE_DEFAULT,
    scale: SCALE_DEFAULT,
    config: '',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--node': case '-n': result.nodeId = args[++i]; break;
      case '--output': case '-o': result.output = args[++i]; break;
      case '--batch-size': case '-b': result.batchSize = parseInt(args[++i]); break;
      case '--scale': case '-s': result.scale = parseFloat(args[++i]); break;
      case '--config': result.config = args[++i]; break;
      case '--help': case '-h':
        console.log(`FigmaForge Turbo Extractor

Usage: node figma-forge-turbo-extract.js --node <FIGMA_NODE_ID> [options]

Options:
  --node, -n       Figma node ID to extract (required)
  --output, -o     Output manifest path (default: manifest_turbo.json)
  --batch-size, -b PNG images per batch call (default: ${BATCH_SIZE_DEFAULT}, max safe: 4)
  --scale, -s      PNG scale factor (default: ${SCALE_DEFAULT})
  --config         Path to figmaforge.config.json
  --help, -h       Show this help

Workflow:
  1. Run this tool → generates batch_script_N.js files
  2. For each batch_script_N.js → run via MCP figma_execute
  3. Save each result as batch_result_N.json
  4. Run: node batch_merge.js → generates final manifest_turbo.json
  5. Run: npx ts-node figma-forge-cli.ts --input manifest_turbo.json --output <path>.rbxmx --resolve-images
`);
        process.exit(0);
    }
  }

  if (!result.nodeId) {
    console.error('[ERROR] --node is required. Get it from Figma (right-click → Copy link → extract ID after /design/...)');
    process.exit(1);
  }

  return result;
}

/**
 * Build a batch PNG export script for a specific range of raster nodes.
 * This script is designed to run in Figma's plugin context (30s budget).
 * It looks up nodes by ID and exports only the specified image hashes.
 */
function buildBatchRasterScript(
  hashesToExport: string[],
  batchIndex: number,
  scale: number,
): string {
  const hashList = JSON.stringify(hashesToExport);
  return `
async function main() {
  // Batch ${batchIndex}: export ${hashesToExport.length} image hashes
  const TARGET_HASHES = new Set(${hashList});
  const scale = ${scale};
  const exportedImages = {};
  const notFound = [];

  function uint8ToBase64(bytes) {
    const CHUNK = 8192;
    const parts = [];
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const chunk = bytes.slice(i, i + CHUNK);
      let binary = '';
      for (let j = 0; j < chunk.length; j++) binary += String.fromCharCode(chunk[j]);
      parts.push(binary);
    }
    const raw = parts.join('');
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let result = ''; let i = 0;
    while (i < raw.length) {
      const a = raw.charCodeAt(i++);
      const b = i < raw.length ? raw.charCodeAt(i++) : 0;
      const c = i < raw.length ? raw.charCodeAt(i++) : 0;
      const n = (a << 16) | (b << 8) | c;
      result += chars[(n >> 18) & 63];
      result += chars[(n >> 12) & 63];
      result += (i - 2 < raw.length) ? chars[(n >> 6) & 63] : '=';
      result += (i - 1 < raw.length) ? chars[n & 63] : '=';
    }
    return result;
  }

  // Walk all nodes in the document to find matching image fills
  async function processNode(node) {
    if (TARGET_HASHES.size === 0) return;
    
    const fills = node.fills;
    if (fills && fills !== figma.mixed) {
      for (const fill of fills) {
        if (fill.type === 'IMAGE' && fill.imageHash && TARGET_HASHES.has(fill.imageHash)) {
          TARGET_HASHES.delete(fill.imageHash);
          try {
            const img = figma.getImageByHash(fill.imageHash);
            if (img) {
              const bytes = await img.getBytesAsync();
              exportedImages[fill.imageHash] = uint8ToBase64(bytes);
            } else {
              notFound.push(fill.imageHash);
            }
          } catch(e) {
            notFound.push(fill.imageHash + ':err:' + String(e));
          }
        }
      }
    }

    if ('children' in node) {
      for (const child of node.children) {
        await processNode(child);
        if (TARGET_HASHES.size === 0) return;
      }
    }
  }

  // Search current page
  for (const node of figma.currentPage.children) {
    await processNode(node);
    if (TARGET_HASHES.size === 0) break;
  }

  return {
    batchIndex: ${batchIndex},
    exportedImages,
    notFound,
    exportedCount: Object.keys(exportedImages).length,
  };
}

return main();
`;
}

/**
 * Build the Node.js merge script that reassembles batch results
 * into a single manifest file.
 */
function buildMergeScript(
  manifestPath: string,
  batchCount: number,
): string {
  return `
// FigmaForge Batch Merge Script
// Auto-generated by figma-forge-turbo-extract
// Run: node batch_merge.js
const fs = require('fs');
const path = require('path');

const MANIFEST_PATH = ${JSON.stringify(manifestPath)};
const BATCH_COUNT = ${batchCount};

console.log('[Merge] Loading manifest:', MANIFEST_PATH);
let manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
if (manifest.success === true && manifest.result) manifest = manifest.result;

let totalMerged = 0;
let totalNotFound = 0;

for (let i = 0; i < BATCH_COUNT; i++) {
  const resultPath = 'batch_result_' + i + '.json';
  if (!fs.existsSync(resultPath)) {
    console.warn('[Merge] ⚠ Missing:', resultPath, '(skipping)');
    continue;
  }
  try {
    let batchData = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    // Handle MCP wrapper
    if (batchData.success === true && batchData.result) batchData = batchData.result;
    
    const imgs = batchData.exportedImages || {};
    const count = Object.keys(imgs).length;
    
    if (!manifest.exportedImages) manifest.exportedImages = {};
    Object.assign(manifest.exportedImages, imgs);
    
    totalMerged += count;
    totalNotFound += (batchData.notFound || []).length;
    console.log('[Merge] Batch', i, '→', count, 'images merged');
    if (batchData.notFound && batchData.notFound.length > 0) {
      console.warn('[Merge] Not found in batch', i, ':', batchData.notFound);
    }
  } catch(e) {
    console.error('[Merge] Error reading batch', i, ':', e.message);
  }
}

fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
console.log('');
console.log('[Merge] ✅ Done!');
console.log('[Merge]   Total merged:', totalMerged, 'images');
console.log('[Merge]   Total notFound:', totalNotFound);
console.log('[Merge]   Manifest:', MANIFEST_PATH);
console.log('');
console.log('Next step: npx ts-node figma-forge-cli.ts --input ' + MANIFEST_PATH + ' --output ../../src/ReplicatedStorage/<NAME>.rbxmx --resolve-images --verbose');
`;
}

async function main() {
  const args = parseArgs();
  const outputDir = path.dirname(args.output);

  // Load config if provided
  let extraConfig: Partial<FigmaForgeConfig> = {};
  if (args.config && fs.existsSync(args.config)) {
    try {
      extraConfig = JSON.parse(fs.readFileSync(args.config, 'utf8'));
    } catch (e) {
      console.warn('[Turbo] Could not load config:', e);
    }
  }

  // Step 1: Generate tree-only extraction script (fast, no PNG export)
  console.log(`[Turbo] Generating tree extraction script for node: ${args.nodeId}`);
  const extractionScript = buildExtractionScript(
    args.nodeId,
    10,
    true, // skipPngExport = true for speed
    { ...DEFAULT_CONFIG, ...extraConfig },
  );

  const treeScriptPath = path.join(outputDir, 'extract_tree.js');
  fs.writeFileSync(treeScriptPath, extractionScript);
  console.log(`[Turbo] ✅ Tree extraction script: ${treeScriptPath}`);
  console.log(`[Turbo] → Run via figma_execute to get the tree structure + unresolvedImages list`);
  console.log(`[Turbo] → Save result to: ${args.output}`);
  console.log('');

  // Step 2: Check if manifest already exists (from a previous tree extraction)
  if (!fs.existsSync(args.output)) {
    console.log('[Turbo] ℹ Manifest not found yet. Run extract_tree.js first, save result to:', args.output);
    console.log('[Turbo] ℹ Then re-run this script to generate batch export scripts.');
    return;
  }

  // Step 3: Load manifest and get unresolvedImages list
  let manifest = JSON.parse(fs.readFileSync(args.output, 'utf8'));
  if (manifest.success === true && manifest.result) manifest = manifest.result;

  const unresolvedImages: string[] = manifest.unresolvedImages || [];
  const alreadyExported = new Set(Object.keys(manifest.exportedImages || {}));
  
  // Filter to only images not yet exported
  const toExport = unresolvedImages.filter(h => !alreadyExported.has(h));

  console.log(`[Turbo] Manifest loaded: ${unresolvedImages.length} unresolved, ${alreadyExported.size} already exported, ${toExport.length} to export`);

  if (toExport.length === 0) {
    console.log('[Turbo] ✅ All images already exported! Ready to assemble:');
    console.log(`[Turbo] → npx ts-node figma-forge-cli.ts --input ${args.output} --output ../../src/ReplicatedStorage/<NAME>.rbxmx --resolve-images --verbose`);
    return;
  }

  // Step 4: Generate batch export scripts
  const batches: string[][] = [];
  for (let i = 0; i < toExport.length; i += args.batchSize) {
    batches.push(toExport.slice(i, i + args.batchSize));
  }

  console.log(`[Turbo] Generating ${batches.length} batch scripts (${args.batchSize} images each):`);
  
  for (let i = 0; i < batches.length; i++) {
    const script = buildBatchRasterScript(batches[i], i, args.scale);
    const scriptPath = path.join(outputDir, `batch_script_${i}.js`);
    fs.writeFileSync(scriptPath, script);
    console.log(`  [Batch ${i}] ${scriptPath} → ${batches[i].length} images: ${batches[i].map(h => h.substring(0, 8) + '...').join(', ')}`);
  }

  // Step 5: Generate merge script
  const mergeScript = buildMergeScript(args.output, batches.length);
  const mergePath = path.join(outputDir, 'batch_merge.js');
  fs.writeFileSync(mergePath, mergeScript);

  console.log('');
  console.log('[Turbo] ✅ Generated!');
  console.log('[Turbo] ====================================================');
  console.log('[Turbo] NEXT STEPS:');
  console.log('[Turbo]   For each batch_script_N.js:');
  console.log('[Turbo]     1. Read the script content');
  console.log('[Turbo]     2. Call figma_execute with that content + timeout:30000');
  console.log('[Turbo]     3. Save result as batch_result_N.json');
  console.log('[Turbo]   Then run: node batch_merge.js');
  console.log('[Turbo]   Then run: npx ts-node figma-forge-cli.ts --input', args.output, '--output ../../src/ReplicatedStorage/<NAME>.rbxmx --resolve-images --verbose');
  console.log('[Turbo] ====================================================');
}

main().catch(e => {
  console.error('[Turbo] FATAL:', e);
  process.exit(1);
});
