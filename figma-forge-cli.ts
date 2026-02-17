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
import { resolveImages } from './figma-forge-images';
import { assembleRbxmx } from './figma-forge-assemble';
import type { FigmaForgeManifest } from './figma-forge-ir';

interface CliArgs {
  input: string;
  output: string;
  scale: number;
  dynamicPrefix: string;
  resolveImages: boolean;
  verbose: boolean;
  skipDedup: boolean;
  mergeImages: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    input: '',
    output: '',
    scale: 2,
    dynamicPrefix: '$',
    resolveImages: false,
    verbose: false,
    skipDedup: false,
    mergeImages: '',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--input': case '-i': result.input = args[++i]; break;
      case '--output': case '-o': result.output = args[++i]; break;
      case '--scale': case '-s': result.scale = parseFloat(args[++i]); break;
      case '--dynamic-prefix': result.dynamicPrefix = args[++i]; break;
      case '--resolve-images': result.resolveImages = true; break;
      case '--merge-images': result.mergeImages = args[++i]; break;
      case '--verbose': case '-v': result.verbose = true; break;
      case '--skip-dedup': result.skipDedup = true; break;
      case '--help': case '-h':
        console.log(`FigmaForge v2 — PNG Pipeline

Usage: figma-forge --input <manifest.json> [options]

Options:
  --input, -i          Path to FigmaForge manifest JSON (required)
  --output, -o         Path for generated .rbxmx (default: <input>.rbxmx)
  --scale, -s          PNG export scale factor (default: 2)
  --dynamic-prefix     Prefix for dynamic text nodes (default: '$')
  --resolve-images     Upload exported PNGs to Roblox Cloud
  --merge-images       Path to exported-images JSON to merge into manifest
  --skip-dedup         Skip text-stroke deduplication pass
  --verbose, -v        Show detailed processing info
  --help, -h           Show this help
`);
        process.exit(0);
    }
  }

  return result;
}

export interface ProcessOptions {
  skipDedup?: boolean;
  resolveImages?: boolean;
  exportedImages?: Record<string, string>;
  verbose?: boolean;
  scale?: number;
  dynamicPrefix?: string;
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
  if (manifestData.success === true && manifestData.result) {
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
  const dynamicPrefix = options?.dynamicPrefix ?? '$';
  return assembleRbxmx(manifest, dynamicPrefix);
}

/**
 * Synchronous variant — skips image upload, generates .rbxmx with existing asset IDs.
 */
export function processManifestSync(
  jsonString: string,
  options?: ProcessOptions,
): string {
  let manifestData = JSON.parse(jsonString);
  if (manifestData.success === true && manifestData.result) {
    manifestData = manifestData.result;
  }
  const manifest: FigmaForgeManifest = manifestData;

  if (!options?.skipDedup) {
    deduplicateTextStrokes(manifest.root);
  }

  const dynamicPrefix = options?.dynamicPrefix ?? '$';
  return assembleRbxmx(manifest, dynamicPrefix);
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

  if (args.verbose) {
    console.log(`📦 FigmaForge v2 — PNG Pipeline`);
    console.log(`   Input: ${inputPath}`);
    console.log(`   Scale: ${args.scale}x`);
    console.log(`   Dynamic prefix: "${args.dynamicPrefix}"`);
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

  const rbxmx = args.resolveImages
    ? await processManifestAsync(finalJsonString, {
        ...args,
        exportedImages: (parsedInput.result || parsedInput).exportedImages || {},
      })
    : processManifestSync(finalJsonString, args);

  const outputPath = args.output || inputPath.replace(/\.json$/, '.rbxmx');
  fs.writeFileSync(outputPath, rbxmx);
  console.log(`✅ Generated ${outputPath}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
