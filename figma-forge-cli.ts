/**
 * FigmaForge CLI v2 — PNG Pipeline
 * 
 * Converts Figma designs into complete .rbxmx files using PNG-based export.
 * Every visual element (including designed text) → ImageLabel with uploaded PNG.
 * Only dynamic text (runtime values) → TextLabel for game code binding.
 */

import * as fs from 'fs';
import * as path from 'path';
import { deduplicateTextStrokes } from './figma-forge-extract';
import { resolveImages, setConfig } from './figma-forge-images';
import { assembleRbxmx } from './figma-forge-assemble';
import { generateBindings } from './figma-forge-bindings';
import { computeDiff, generatePreviousManifest } from './figma-forge-diff';
import type { FigmaForgeManifest } from './figma-forge-ir';

interface CliArgs {
  input: string;
  output: string;
  scale: number;
  config: string;
  textExport: 'all' | 'dynamic' | 'none';
  resolveImages: boolean;
  verbose: boolean;
  skipDedup: boolean;
  mergeImages: string;
  apiKey: string;
  creatorId: string;
  responsive: boolean;
  incremental: string;
  saveManifest: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    input: '',
    output: '',
    scale: 2,
    config: '',
    textExport: 'all',
    resolveImages: false,
    verbose: false,
    skipDedup: false,
    mergeImages: '',
    apiKey: '',
    creatorId: '',
    responsive: false,
    incremental: '',
    saveManifest: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--input': case '-i': result.input = args[++i]; break;
      case '--output': case '-o': result.output = args[++i]; break;
      case '--scale': case '-s': result.scale = parseFloat(args[++i]); break;
      case '--config': case '-c': result.config = args[++i]; break;
      case '--text-export':
        const mode = args[++i];
        if (mode === 'all' || mode === 'dynamic' || mode === 'none') {
          result.textExport = mode;
        } else {
          console.warn(`[Cli] Invalid --text-export value "${mode}". Valid values are 'all', 'dynamic', 'none'. Defaulting to 'all'.`);
        }
        break;
      case '--resolve-images': result.resolveImages = true; break;
      case '--merge-images': result.mergeImages = args[++i]; break;
      case '--verbose': case '-v': result.verbose = true; break;
      case '--skip-dedup': result.skipDedup = true; break;
      case '--api-key': result.apiKey = args[++i]; break;
      case '--creator-id': result.creatorId = args[++i]; break;
      case '--responsive': result.responsive = true; break;
      case '--incremental': result.incremental = args[++i]; break;
      case '--save-manifest': result.saveManifest = true; break;
      case '--help': case '-h':
        console.log(`FigmaForge v2 — PNG Pipeline

Usage: figma-forge --input <manifest.json> [options]

Options:
  --input, -i          Path to FigmaForge manifest JSON (required)
  --output, -o         Path for generated .rbxmx (default: <input>.rbxmx)
  --scale, -s          PNG export scale factor (default: 2)
  --config, -c         Path to custom figmaforge.config.json
  --text-export        Text export mode: 'all' | 'dynamic' | 'none' (default: 'all')
  --resolve-images     Upload exported PNGs to Roblox Cloud
  --merge-images       Path to exported-images JSON to merge into manifest
  --api-key            Roblox Open Cloud API key (highest priority)
  --creator-id         Roblox creator/user ID for asset ownership
  --skip-dedup         Skip text-stroke deduplication pass
  --responsive         Use scale-based sizing proportional to root (for responsive UI)
  --incremental <prev> Path to previous manifest for incremental re-export
  --save-manifest      Save current state for future incremental exports
  --verbose, -v        Show detailed processing info
  --help, -h           Show this help
`);
        process.exit(0);
    }
  }

  return result;
}

import { DEFAULT_CONFIG, compileConfig, FigmaForgeConfig, RuntimeConfig } from './figma-forge-shared';

export interface ProcessOptions {
  skipDedup?: boolean;
  resolveImages?: boolean;
  exportedImages?: Record<string, string>;
  verbose?: boolean;
  scale?: number;
  config?: Partial<FigmaForgeConfig>;
}

/**
 * Process a manifest JSON string through the PNG pipeline.
 * Returns the assembled .rbxmx XML string.
 */
export async function processManifestAsync(
  jsonString: string,
  options?: ProcessOptions,
): Promise<string> {
  let manifestData = JSON.parse(jsonString);
  if (manifestData.result) {
    manifestData = manifestData.result;
  }
  const manifest: FigmaForgeManifest = manifestData;

  // Step 1: Dedup text strokes (still useful for cleaning extraction)
  if (!options?.skipDedup) {
    deduplicateTextStrokes(manifest.root);
  }

  // Step 2: Resolve images (upload exported PNGs to Roblox)
  if (options?.resolveImages && manifest.unresolvedImages && manifest.unresolvedImages.length > 0) {
    await resolveImages(manifest, options.exportedImages ?? {}, !!options.verbose);
  }

  // Step 3: Assemble .rbxmx from PNG-based hierarchy
  const runtimeConfig = compileConfig(options?.config || {});
  return assembleRbxmx(manifest, runtimeConfig);
}

/**
 * Synchronous variant — skips image upload, generates .rbxmx with existing asset IDs.
 */
export function processManifestSync(
  jsonString: string,
  options?: ProcessOptions,
): string {
  let manifestData = JSON.parse(jsonString);
  if (manifestData.result) {
    manifestData = manifestData.result;
  }
  const manifest: FigmaForgeManifest = manifestData;

  if (!options?.skipDedup) {
    deduplicateTextStrokes(manifest.root);
  }

  const runtimeConfig = compileConfig(options?.config || {});
  return assembleRbxmx(manifest, runtimeConfig);
}

function loadConfig(configPath: string, verbose: boolean): Partial<FigmaForgeConfig> {
  const resolvedPath = path.resolve(configPath || 'figmaforge.config.json');
  if (fs.existsSync(resolvedPath)) {
    if (verbose) console.log(`[Cli] Loaded config from ${resolvedPath}`);
    return JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
  }
  if (configPath) {
    console.warn(`[Cli] Warning: Specified config file not found at ${resolvedPath}`);
  }
  return {};
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.input) {
    console.error('Error: --input is required. Use --help for usage.');
    process.exit(1);
  }

  const inputPath = path.resolve(args.input);
  if (!fs.existsSync(inputPath)) {
    console.error(`Error: Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const jsonString = fs.readFileSync(inputPath, 'utf-8');

  // Inject CLI-provided Roblox credentials (highest priority)
  if (args.apiKey && args.creatorId) {
    setConfig(args.apiKey, args.creatorId);
  }

  const loadedConfig = loadConfig(args.config, args.verbose);
  loadedConfig.textExportMode = args.textExport || loadedConfig.textExportMode;
  if (args.responsive) loadedConfig.responsive = true;

  if (args.verbose) {
    console.log(`📦 FigmaForge v2 — PNG Pipeline`);
    console.log(`   Input: ${inputPath}`);
    console.log(`   Scale: ${args.scale}x`);
    console.log(`   Text Export: ${loadedConfig.textExportMode || DEFAULT_CONFIG.textExportMode}`);
    console.log(`   Resolve images: ${args.resolveImages}`);
  }

  let parsedInput = JSON.parse(jsonString);

  // Merge exported images from separate file (from batched export)
  if (args.mergeImages) {
    const mergeImagesPath = path.resolve(args.mergeImages);
    if (!fs.existsSync(mergeImagesPath)) {
      console.error(`Error: Merge images file not found: ${mergeImagesPath}`);
      process.exit(1);
    }
    const imagesData = JSON.parse(fs.readFileSync(mergeImagesPath, 'utf-8'));
    const existingImages = parsedInput.exportedImages || (parsedInput.result?.exportedImages) || {};
    const mergedImages = { ...existingImages, ...imagesData };
    if (parsedInput.result) {
      parsedInput.result.exportedImages = mergedImages;
    } else {
      parsedInput.exportedImages = mergedImages;
    }
    if (args.verbose) {
      console.log(`   Merged ${Object.keys(imagesData).length} exported images from ${mergeImagesPath}`);
    }
  }

  const finalJsonString = JSON.stringify(parsedInput);

  const options: ProcessOptions = {
    ...args,
    config: loadedConfig,
    exportedImages: (parsedInput.result || parsedInput).exportedImages || {},
  };

  const rbxmx = args.resolveImages
    ? await processManifestAsync(finalJsonString, options)
    : processManifestSync(finalJsonString, options);

  // ── Rojo-Safety Validator (FAIL FAST) ──
  // Catches known Rojo crash patterns BEFORE writing the file
  const rojoErrors: string[] = [];

  // ── CRITICAL: <token> tags MUST contain numeric values, never strings ──
  // Rojo fails with "invalid digit found in string" if tokens contain "None", "XY", etc.
  const stringTokenPattern = /<token[^>]*>([A-Za-z]+)<\/token>/g;
  let tokenMatch;
  while ((tokenMatch = stringTokenPattern.exec(rbxmx)) !== null) {
    rojoErrors.push(`❌ <token> contains string "${tokenMatch[1]}" instead of numeric enum — at char ${tokenMatch.index}`);
  }

  // Properties that Rojo requires as <int>, NOT <token>
  // Source: Rojo crashes with "unexpected property type" for these
  const ROJO_INT_PROPERTIES = [
    'ScrollBarThickness', 'BorderSizePixel',
    'ZIndex', 'LayoutOrder', 'DisplayOrder',
  ];
  for (const prop of ROJO_INT_PROPERTIES) {
    const tokenPattern = new RegExp(`<token name="${prop}">`, 'g');
    const matches = rbxmx.match(tokenPattern);
    if (matches) {
      rojoErrors.push(`❌ <token> for "${prop}" (${matches.length}x) — Rojo requires <int>`);
    }
  }

  // Check for unclosed XML tags (basic well-formedness)
  const openItems = (rbxmx.match(/<Item /g) || []).length;
  const closeItems = (rbxmx.match(/<\/Item>/g) || []).length;
  if (openItems !== closeItems) {
    rojoErrors.push(`❌ XML malformed: ${openItems} <Item> opens vs ${closeItems} </Item> closes`);
  }

  // Check for duplicate referent IDs (causes Rojo to silently merge nodes)
  const referents = rbxmx.match(/referent="([^"]+)"/g) || [];
  const refSet = new Set<string>();
  for (const r of referents) {
    if (refSet.has(r)) rojoErrors.push(`❌ Duplicate referent: ${r}`);
    refSet.add(r);
  }

  if (rojoErrors.length > 0) {
    throw new Error(`[FigmaForge] ROJO SAFETY CHECK FAILED:\n${rojoErrors.join('\n')}`);
  }

  // ── Image asset completeness check ──
  // Fail-fast if ImageLabels exist but have no Image content (e.g. --resolve-images was forgotten)
  const imageLabelCount = (rbxmx.match(/class="ImageLabel"/g) || []).length;
  const assetIdCount = (rbxmx.match(/rbxassetid:\/\/\d+/g) || []).length;
  if (imageLabelCount > 0 && assetIdCount === 0) {
    throw new Error(
      `[FigmaForge] IMAGE ASSET CHECK FAILED: ${imageLabelCount} ImageLabels but 0 rbxassetid:// URLs!\n` +
      `Did you forget --resolve-images? Re-run with: --resolve-images`
    );
  }
  // Warn if some ImageLabels may be missing images (heuristic: expect at least 1 asset per 2 ImageLabels)
  if (imageLabelCount > 2 && assetIdCount < imageLabelCount / 2) {
    console.warn(`⚠️  WARNING: ${imageLabelCount} ImageLabels but only ${assetIdCount} asset IDs — some images may be missing`);
  }

  if (args.verbose) console.log(`🛡️  Rojo safety check passed (${openItems} items, ${referents.length} referents, ${assetIdCount} assets, 0 issues)`);

  const outputPath = args.output || inputPath.replace(/\.json$/, '.rbxmx');
  fs.writeFileSync(outputPath, rbxmx);
  console.log(`✅ Generated ${outputPath}`);

  // ── Generate binding manifest ──
  const manifest = (parsedInput.result || parsedInput) as any;
  const runtimeConfig = compileConfig(loadedConfig);
  const rootNode = manifest.root;
  if (rootNode && rootNode.name) {
    const bindings = generateBindings(rootNode, runtimeConfig);
    const bindingsPath = outputPath.replace(/\.rbxmx$/, '.bindings.json');
    fs.writeFileSync(bindingsPath, JSON.stringify(bindings, null, 2));
    console.log(`📋 Generated ${bindingsPath}`);

    // ── Incremental diff ──
    if (args.incremental) {
      const diff = computeDiff(rootNode, path.resolve(args.incremental));
      console.log(`🔄 Incremental diff:`);
      console.log(`   Changed: ${diff.stats.changedCount}, Added: ${diff.stats.addedCount}, Unchanged: ${diff.stats.unchangedCount}, Removed: ${diff.stats.removedCount}`);
      console.log(`   Saved ${diff.stats.savedUploads} uploads (reuse existing assets)`);
    }

    // ── Save manifest for future incremental exports ──
    if (args.saveManifest) {
      const assetMap = (parsedInput.result || parsedInput).resolvedAssets || {};
      const prevManifest = generatePreviousManifest(rootNode, assetMap);
      const manifestPath = outputPath.replace(/\.rbxmx$/, '.manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(prevManifest, null, 2));
      console.log(`💾 Saved manifest ${manifestPath} (use with --incremental for next export)`);
    }
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(`Fatal:`, err);
    process.exit(1);
  });
}
