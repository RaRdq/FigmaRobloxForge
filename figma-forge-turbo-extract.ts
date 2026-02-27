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
  flattenKeys: Set<string> = new Set(),
): string {
  const hashList = JSON.stringify(hashesToExport);
  const flattenList = JSON.stringify([...flattenKeys].filter(k => hashesToExport.includes(k)));
  return `
async function main() {
  // Batch ${batchIndex}: export ${hashesToExport.length} image hashes
  const TARGET_HASHES = new Set(${hashList});
  const FLATTEN_KEYS = new Set(${flattenList}); // [Flatten] nodes: export WITH children (bake text into image)
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
    
    const rasterKey = 'raster_' + node.id.replace(/:/g, '_');
    if (TARGET_HASHES.has(rasterKey)) {
      TARGET_HASHES.delete(rasterKey);
      try {
        // --- CHILD VISIBILITY: Hybrid nodes hide children (BG only), Flatten nodes keep children (bake text) ---
        // [Flatten] nodes: children are text/icons that must be baked INTO the exported image.
        // Hybrid nodes: children are separate UI elements, only the container BG should be captured.
        //
        // CRITICAL: Neither opacity=0 NOR visible=false work with Figma's exportAsync!
        // Both still render children in the output. PROVEN: original=102KB vs clone-stripped=79KB.
        // The ONLY reliable approach is CLONE + STRIP: clone the node, remove all children
        // from the clone, export the clone (BG-only), then delete the clone.
        const isFlatten = FLATTEN_KEYS.has(rasterKey);
        
        let exportNode = node;
        let cloneToDelete = null;
        if (!isFlatten && 'children' in node && node.children && node.children.length > 0) {
          // Clone the frame to get an independent copy
          const clone = node.clone();
          // Disable auto-layout so removing children doesn't collapse the frame
          if ('layoutMode' in clone) clone.layoutMode = 'NONE';
          // Force the clone to match the original frame dimensions
          clone.resize(node.width, node.height);
          // Remove ALL children from the clone — only frame fills remain
          while (clone.children.length > 0) {
            clone.children[0].remove();
          }
          // ── SMART SELECTIVE STRIPPING for hybrid _BG clones ──
          // Strip ONLY properties that cause transparent padding in exportAsync.
          // Keep properties that render INSIDE the frame (part of visual design).
          //
          // | Property              | Strip? | Reason                                    |
          // |-----------------------|--------|-------------------------------------------|
          // | cornerRadius          | YES    | Roblox UICorner handles rounding           |
          // | DROP_SHADOW           | YES    | Transparent padding beyond frame           |
          // | LAYER_BLUR            | YES    | Blurs content beyond frame bounds          |
          // | INNER_SHADOW          | NO     | Renders inside — designed highlight        |
          // | BACKGROUND_BLUR       | NO     | Doesn't expand bounds                     |
          // | stroke INSIDE         | NO     | Renders inside — designed card border      |
          // | stroke CENTER/OUTSIDE | YES    | Extends beyond frame bounds                |

          // 1. CornerRadius → always strip (Roblox UICorner handles rounding)
          if ('cornerRadius' in clone) clone.cornerRadius = 0;
          if ('topLeftRadius' in clone) clone.topLeftRadius = 0;
          if ('topRightRadius' in clone) clone.topRightRadius = 0;
          if ('bottomLeftRadius' in clone) clone.bottomLeftRadius = 0;
          if ('bottomRightRadius' in clone) clone.bottomRightRadius = 0;

          // 2. Effects → strip only OUTER effects (DROP_SHADOW, LAYER_BLUR)
          //    Keep INNER_SHADOW and BACKGROUND_BLUR (render inside frame)
          if ('effects' in clone && clone.effects && clone.effects.length > 0) {
            clone.effects = clone.effects.filter(function(e) {
              return e.type === 'INNER_SHADOW' || e.type === 'BACKGROUND_BLUR';
            });
          }

          // 3. Strokes → strip only CENTER/OUTSIDE (expand bounds)
          //    Keep INSIDE strokes (card borders — part of visual design)
          if ('strokes' in clone && clone.strokes && clone.strokes.length > 0) {
            var align = ('strokeAlign' in clone) ? clone.strokeAlign : 'CENTER';
            if (align !== 'INSIDE') {
              clone.strokes = [];
              if ('strokeWeight' in clone) clone.strokeWeight = 0;
            }
          }
          // Small wait for Figma to process the removals
          await new Promise(function(r) { setTimeout(r, 100); });
          exportNode = clone;
          cloneToDelete = clone;
        }
        
        const bytes = await exportNode.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } });
        
        // --- CLEANUP: Delete the clone ---
        if (cloneToDelete) {
          cloneToDelete.remove();
        }
        
        exportedImages[rasterKey] = uint8ToBase64(bytes);

        // ── SHADOW-ONLY CLONE: Export DROP_SHADOW as separate _Shadow PNG ──
        // If original node has DROP_SHADOW effects AND is hybrid (container with BG),
        // create a shadow-only clone: keep fills (for shape mask) + DROP_SHADOW only.
        // Strip: children, strokes, INNER_SHADOW, BACKGROUND_BLUR, cornerRadius.
        // The shadow PNG includes the expanded bounds from DROP_SHADOW.
        if (!isFlatten && 'children' in node && 'effects' in node && node.effects) {
          var hasDropShadow = false;
          for (var ei = 0; ei < node.effects.length; ei++) {
            if (node.effects[ei].type === 'DROP_SHADOW' && node.effects[ei].visible !== false) {
              hasDropShadow = true;
              break;
            }
          }
          if (hasDropShadow) {
            var shadowKey = 'shadow_' + node.id.replace(/:/g, '_');
            try {
              var shadowClone = node.clone();
              if ('layoutMode' in shadowClone) shadowClone.layoutMode = 'NONE';
              shadowClone.resize(node.width, node.height);
              // Remove ALL children
              while (shadowClone.children.length > 0) shadowClone.children[0].remove();
              // Strip cornerRadius (shadow PNG uses renderBounds for sizing)
              if ('cornerRadius' in shadowClone) shadowClone.cornerRadius = 0;
              if ('topLeftRadius' in shadowClone) shadowClone.topLeftRadius = 0;
              if ('topRightRadius' in shadowClone) shadowClone.topRightRadius = 0;
              if ('bottomLeftRadius' in shadowClone) shadowClone.bottomLeftRadius = 0;
              if ('bottomRightRadius' in shadowClone) shadowClone.bottomRightRadius = 0;
              // Keep ONLY DROP_SHADOW effects — strip INNER_SHADOW, BACKGROUND_BLUR, LAYER_BLUR
              if ('effects' in shadowClone && shadowClone.effects) {
                shadowClone.effects = shadowClone.effects.filter(function(e) {
                  return e.type === 'DROP_SHADOW';
                });
              }
              // Strip ALL strokes (shadow only needs shape from fills)
              if ('strokes' in shadowClone) {
                shadowClone.strokes = [];
                if ('strokeWeight' in shadowClone) shadowClone.strokeWeight = 0;
              }
              await new Promise(function(r) { setTimeout(r, 50); });
              var shadowBytes = await shadowClone.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } });
              shadowClone.remove();
              exportedImages[shadowKey] = uint8ToBase64(shadowBytes);
            } catch(se) {
              // Non-fatal: shadow export failed, node will just have no shadow
            }
          }
        }
      } catch(e) {
        notFound.push(rasterKey + ':err:' + String(e));
      }
    }

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

  // CRITICAL: All ephemeral output goes to project-level temp/figmaforge/, NOT the FigmaForge source dir.
  // This keeps the public repo clean — no batch scripts, manifests, or merge scripts in source.
  const FORGE_DIR = path.resolve(__dirname, '..');
  const PROJECT_ROOT = path.resolve(FORGE_DIR, '..', '..');
  const TEMP_DIR = path.join(PROJECT_ROOT, 'temp', 'figmaforge');
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

  // Resolve output path: if relative (no directory), put it in TEMP_DIR
  const MANIFEST_PATH = path.isAbsolute(args.output) 
    ? args.output 
    : path.join(TEMP_DIR, path.basename(args.output));
  const outputDir = path.dirname(MANIFEST_PATH);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

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
  console.log(`[Turbo] → Save result to: ${MANIFEST_PATH}`);
  console.log('');

  // Step 2: Check if manifest already exists (from a previous tree extraction)
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.log('[Turbo] ℹ Manifest not found yet. Run extract_tree.js first, save result to:', MANIFEST_PATH);
    console.log('[Turbo] ℹ Then re-run this script to generate batch export scripts.');
    return;
  }

  // Step 3: Load manifest and get unresolvedImages list
  let manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  if (manifest.success === true && manifest.result) manifest = manifest.result;

  const unresolvedImages: string[] = manifest.unresolvedImages || [];
  const alreadyExported = new Set(Object.keys(manifest.exportedImages || {}));
  
  // Filter to only images not yet exported
  const toExport = unresolvedImages.filter(h => !alreadyExported.has(h));

  console.log(`[Turbo] Manifest loaded: ${unresolvedImages.length} unresolved, ${alreadyExported.size} already exported, ${toExport.length} to export`);

  if (toExport.length === 0) {
    console.log('[Turbo] ✅ All images already exported! Ready to assemble:');
    console.log(`[Turbo] → npx ts-node figma-forge-cli.ts --input ${MANIFEST_PATH} --output ../../src/ReplicatedStorage/<NAME>.rbxmx --resolve-images --verbose`);
    return;
  }

  // Step 4: Collect [Flatten] keys from manifest tree — these nodes must keep children visible during raster
  const flattenKeys = new Set<string>();
  function collectFlattenKeys(node: any) {
    if (node._isFlattened) {
      const rasterKey = 'raster_' + node.id.replace(/[:\;]/g, '_');
      flattenKeys.add(rasterKey);
    }
    if (node.children) {
      for (const child of node.children) collectFlattenKeys(child);
    }
  }
  const tree = manifest.root || manifest.tree;
  if (tree) collectFlattenKeys(tree);
  if (flattenKeys.size > 0) {
    console.log(`[Turbo] Found ${flattenKeys.size} [Flatten] nodes: ${[...flattenKeys].join(', ')}`);
  }

  // Step 5: Generate batch export scripts
  const batches: string[][] = [];
  for (let i = 0; i < toExport.length; i += args.batchSize) {
    batches.push(toExport.slice(i, i + args.batchSize));
  }

  console.log(`[Turbo] Generating ${batches.length} batch scripts (${args.batchSize} images each):`);
  
  for (let i = 0; i < batches.length; i++) {
    const script = buildBatchRasterScript(batches[i], i, args.scale, flattenKeys);
    const scriptPath = path.join(outputDir, `batch_script_${i}.js`);
    fs.writeFileSync(scriptPath, script);
    console.log(`  [Batch ${i}] ${scriptPath} → ${batches[i].length} images: ${batches[i].map(h => h.substring(0, 8) + '...').join(', ')}`);
  }

  // Step 6: Generate merge script
  const mergeScript = buildMergeScript(MANIFEST_PATH, batches.length);
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
  console.log('[Turbo]   Then run: npx ts-node figma-forge-cli.ts --input', MANIFEST_PATH, '--output ../../src/ReplicatedStorage/<NAME>.rbxmx --resolve-images --verbose');
  console.log('[Turbo] ====================================================');
}

main().catch(e => {
  console.error('[Turbo] FATAL:', e);
  process.exit(1);
});
