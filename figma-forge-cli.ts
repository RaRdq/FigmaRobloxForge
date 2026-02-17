/**
 * FigmaForge CLI
 * 
 * End-to-end pipeline: Extract from Figma → Process IR → Generate .rbxmx or .luau
 * 
 * Usage (via the MCP tool chain):
 *   1. Run extraction script in Figma via figma_execute
 *   2. Save the returned JSON to a .json file
 *   3. Run: npx ts-node figma-forge-cli.ts --input <manifest.json> --output <output.rbxmx>
 *   4. Or: npx ts-node figma-forge-cli.ts --input <manifest.json> --format luau --output <output.luau>
 * 
 * Or programmatically:
 *   import { processManifest } from './figma-forge-cli';
 *   const result = processManifest(jsonString, { format: 'luau' });
 */

import * as fs from 'fs';
import * as path from 'path';
import { deduplicateTextStrokes, countDedupedNodes } from './figma-forge-extract';
import { manifestToRbxmx } from './figma-forge-rbxmx';
import { manifestToLuau } from './figma-forge-luau';
import type { FigmaForgeManifest } from './figma-forge-ir';

// ─── CLI Argument Parsing ────────────────────────────────────────

type OutputFormat = 'rbxmx' | 'luau';

interface CliArgs {
  input: string;
  output: string;
  format: OutputFormat;
  skipDedup: boolean;
  verbose: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    input: '',
    output: '',
    format: 'rbxmx',
    skipDedup: false,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--input':
      case '-i':
        result.input = args[++i];
        break;
      case '--output':
      case '-o':
        result.output = args[++i];
        break;
      case '--format':
      case '-f':
        result.format = args[++i] as OutputFormat;
        break;
      case '--skip-dedup':
        result.skipDedup = true;
        break;
      case '--verbose':
      case '-v':
        result.verbose = true;
        break;
      case '--help':
      case '-h':
        console.log(`
FigmaForge CLI — Figma→Roblox 1:1 Parity Engine

Usage:
  npx ts-node figma-forge-cli.ts --input <manifest.json> --output <output.rbxmx>
  npx ts-node figma-forge-cli.ts --input <manifest.json> --format luau --output <output.luau>

Options:
  --input, -i      Path to FigmaForge manifest JSON (from figma_execute extraction)
  --output, -o     Path for generated file (default: <input-name>.rbxmx or .luau)
  --format, -f     Output format: 'rbxmx' (default) or 'luau' (for Roblox Studio MCP)
  --skip-dedup     Skip text-stroke deduplication pass
  --verbose, -v    Show detailed processing info
  --help, -h       Show this help message
`);
        process.exit(0);
    }
  }

  // Auto-detect format from output extension
  if (result.output && !args.includes('--format') && !args.includes('-f')) {
    if (result.output.endsWith('.luau') || result.output.endsWith('.lua')) {
      result.format = 'luau';
    }
  }

  return result;
}

// ─── Processing Pipeline ─────────────────────────────────────────

export interface ProcessOptions {
  skipDedup?: boolean;
  verbose?: boolean;
  format?: OutputFormat;
}

/**
 * Process a FigmaForge manifest JSON string through the full pipeline.
 * Returns the generated output string (rbxmx XML or Luau code).
 * For luau format, returns the first chunk; use processManifestChunked for all chunks.
 */
export function processManifest(jsonString: string, options?: ProcessOptions): string {
  const chunks = processManifestChunked(jsonString, options);
  return chunks[0];
}

/**
 * Process manifest and return all output chunks.
 * For rbxmx format, returns a single-element array.
 * For luau format, may return multiple chunks for large trees.
 */
export function processManifestChunked(jsonString: string, options?: ProcessOptions): string[] {
  const manifest: FigmaForgeManifest = JSON.parse(jsonString);
  const verbose = options?.verbose ?? false;
  const format = options?.format ?? 'rbxmx';

  if (verbose) {
    console.log(`[FigmaForge] Processing: "${manifest.sourceNodeName}" (${manifest.sourceNodeId})`);
    console.log(`[FigmaForge]   Source: ${manifest.sourceFile}`);
    console.log(`[FigmaForge]   Canvas: ${manifest.canvasWidth}×${manifest.canvasHeight}`);
    console.log(`[FigmaForge]   Format: ${format}`);
    console.log(`[FigmaForge]   Total nodes: ${manifest.stats.totalNodes}`);
    console.log(`[FigmaForge]   Text nodes: ${manifest.stats.textNodes}`);
    console.log(`[FigmaForge]   Image nodes: ${manifest.stats.imageNodes}`);
    console.log(`[FigmaForge]   Unresolved images: ${manifest.unresolvedImages.length}`);
  }

  // ── Pass 1: Text-stroke deduplication ──
  if (!options?.skipDedup) {
    deduplicateTextStrokes(manifest.root);
    const dedupCount = countDedupedNodes(manifest);
    manifest.stats.dedupedTextNodes = dedupCount;

    if (verbose) {
      console.log(`[FigmaForge]   Deduped text nodes: ${dedupCount} removed`);
    }
  }

  // ── Pass 2: Image resolution (Kit asset matching) ──
  if (manifest.unresolvedImages.length > 0 && verbose) {
    console.log(`[FigmaForge]   ⚠ ${manifest.unresolvedImages.length} images need manual resolution:`);
    for (const hash of manifest.unresolvedImages) {
      console.log(`[FigmaForge]     - imageHash: ${hash}`);
    }
  }

  // ── Pass 3: Generate output ──
  if (format === 'luau') {
    const chunks = manifestToLuau(manifest);
    if (verbose) {
      const totalLines = chunks.reduce((sum, c) => sum + c.split('\n').length, 0);
      console.log(`[FigmaForge]   Generated ${chunks.length} chunk(s), ${totalLines} total lines of Luau`);
    }
    return chunks;
  } else {
    const rbxmx = manifestToRbxmx(manifest);
    if (verbose) {
      const nodeCountAfter = countNodesInXml(rbxmx);
      console.log(`[FigmaForge]   Generated ${rbxmx.length} bytes, ~${nodeCountAfter} Roblox instances`);
    }
    return [rbxmx];
  }
}

/** Quick count of <Item> tags in generated XML */
function countNodesInXml(xml: string): number {
  return (xml.match(/<Item /g) || []).length;
}

// ─── Main ────────────────────────────────────────────────────────

function main(): void {
  const args = parseArgs();

  if (!args.input) {
    console.error('[FigmaForge] Error: --input is required. Use --help for usage.');
    process.exit(1);
  }

  const inputPath = path.resolve(args.input);
  if (!fs.existsSync(inputPath)) {
    console.error(`[FigmaForge] Error: Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const ext = args.format === 'luau' ? '.luau' : '.rbxmx';
  const outputPath = args.output
    ? path.resolve(args.output)
    : inputPath.replace(/\.json$/, ext);

  console.log(`[FigmaForge] Input:  ${inputPath}`);
  console.log(`[FigmaForge] Output: ${outputPath} (${args.format})`);

  const jsonString = fs.readFileSync(inputPath, 'utf-8');
  const chunks = processManifestChunked(jsonString, {
    skipDedup: args.skipDedup,
    verbose: args.verbose,
    format: args.format,
  });

  if (chunks.length === 1) {
    fs.writeFileSync(outputPath, chunks[0], 'utf-8');
    console.log(`[FigmaForge] ✅ Successfully generated ${outputPath}`);
  } else {
    // Multiple chunks: write as separate files
    for (let i = 0; i < chunks.length; i++) {
      const chunkPath = outputPath.replace(/(\.\w+)$/, `.chunk${i + 1}$1`);
      fs.writeFileSync(chunkPath, chunks[i], 'utf-8');
      console.log(`[FigmaForge] ✅ Chunk ${i + 1}/${chunks.length}: ${chunkPath}`);
    }
  }
}

// Run if called directly
if (require.main === module) {
  main();
}
