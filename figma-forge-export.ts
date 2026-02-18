/**
 * FigmaForge Export — Batch PNG Export via Figma `exportAsync`
 * 
 * Generates JavaScript scripts that run inside Figma's plugin context
 * to export each visual node as a flat PNG at the specified scale.
 * 
 * Handles Figma's 30s figma_execute timeout by chunking exports
 * into batches of N nodes per script execution.
 * 
 * Usage:
 *   1. Run buildExtractionScript() to get the node tree (existing)
 *   2. Classify nodes as png/text_dynamic/container
 *   3. Run buildPngExportScript() with the nodeIds to export
 *   4. Parse the returned base64 PNG map
 *   5. Feed into resolveImages() for upload
 */

import type { FigmaForgeNode } from './figma-forge-ir';
import { isDynamicText, hasDescendantDynamicText } from './figma-forge-shared';

// ─── Constants ───────────────────────────────────────────────────

/** Max nodes to export per figma_execute call (avoid 30s timeout) */
const CHUNK_SIZE = 15;

/** Default export scale (2x for retina) */
const DEFAULT_SCALE = 2;

// ─── Node Collection ─────────────────────────────────────────────

export interface ExportableNode {
  nodeId: string;
  name: string;
  width: number;
  height: number;
  type: string;
}

/**
 * Collect all nodes that should be exported as PNGs.
 * 
 * Walks the IR tree and collects:
 * - Leaf visual nodes (no children)
 * - Designed text nodes (static headers, decorative text)
 * - Subtrees with no dynamic text descendants (flatten to one PNG)
 * 
 * @param root - IR root node
 * @param dynamicPrefix - Prefix for dynamic text nodes (default: '$')
 * @returns Array of nodes to export as PNGs
 */
export function collectExportableNodes(
  root: FigmaForgeNode,
  dynamicPrefix: string = '$',
): ExportableNode[] {
  const results: ExportableNode[] = [];
  walkForExport(root, dynamicPrefix, results);
  return results;
}

function walkForExport(
  node: FigmaForgeNode,
  dynamicPrefix: string,
  results: ExportableNode[],
): void {
  if (!node.visible || node._isStrokeDuplicate) return;

  // Text nodes: designed text → export as PNG
  if (node.type === 'TEXT') {
    if (!isDynamicText(node, dynamicPrefix)) {
      results.push({
        nodeId: node.id,
        name: node.name,
        width: node.width,
        height: node.height,
        type: 'designed_text',
      });
    }
    return; // Dynamic text = TextLabel, not exported as PNG
  }

  // Leaf node (no children): always export as PNG
  if (!node.children || node.children.length === 0) {
    results.push({
      nodeId: node.id,
      name: node.name,
      width: node.width,
      height: node.height,
      type: 'visual',
    });
    return;
  }

  // Container: check if any descendant has dynamic text
  if (hasDescendantDynamicText(node, dynamicPrefix)) {
    // Has dynamic text inside — recurse into children
    for (const child of node.children) {
      walkForExport(child, dynamicPrefix, results);
    }
  } else {
    // No dynamic text — export entire subtree as one PNG
    results.push({
      nodeId: node.id,
      name: node.name,
      width: node.width,
      height: node.height,
      type: 'flattened_subtree',
    });
  }
}

// isDynamicText and hasDescendantDynamicText imported from figma-forge-shared (SSOT)

// ─── Script Generation ──────────────────────────────────────────

/**
 * Build a self-contained JavaScript string that, when executed in Figma's
 * plugin sandbox via figma_execute, exports specified nodes as base64 PNGs.
 * 
 * Returns a map of { nodeId: base64PngData }.
 * 
 * @param nodeIds - Array of Figma node IDs to export
 * @param scale - Export scale factor (default: 2)
 * @returns JavaScript string to execute via figma_execute
 */
export function buildPngExportScript(
  nodeIds: string[],
  scale: number = DEFAULT_SCALE,
): string {
  // Serialize nodeIds as a JSON array inside the script
  const idsJson = JSON.stringify(nodeIds);

  return `
(async () => {
  const nodeIds = ${idsJson};
  const scale = ${scale};
  const results = {};
  const errors = [];

  // Figma sandbox lacks btoa — use a self-contained base64 encoder
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function uint8ToBase64(bytes) {
    let r = '';
    const len = bytes.length;
    for (let i = 0; i < len; i += 3) {
      const a = bytes[i];
      const b = i + 1 < len ? bytes[i + 1] : 0;
      const c = i + 2 < len ? bytes[i + 2] : 0;
      r += B64[a >> 2];
      r += B64[((a & 3) << 4) | (b >> 4)];
      r += i + 1 < len ? B64[((b & 15) << 2) | (c >> 6)] : '=';
      r += i + 2 < len ? B64[c & 63] : '=';
    }
    return r;
  }

  for (const id of nodeIds) {
    try {
      const node = figma.getNodeById(id);
      if (!node) {
        errors.push({ id, error: 'Node not found' });
        continue;
      }

      const bytes = await node.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: scale },
      });

      results[id] = uint8ToBase64(bytes);
    } catch (e) {
      errors.push({ id, error: String(e) });
    }
  }

  return {
    exportedNodes: results,
    errors: errors,
    count: Object.keys(results).length,
    failCount: errors.length,
  };
})()
`.trim();
}

/**
 * Chunk nodeIds into batches and generate one export script per batch.
 * Each script stays within Figma's 30s execution timeout.
 * 
 * @param nodeIds - All node IDs to export
 * @param scale - Export scale factor
 * @param chunkSize - Max nodes per batch (default: 15)
 * @returns Array of { script, nodeIds } chunks
 */
export function buildChunkedExportScripts(
  nodeIds: string[],
  scale: number = DEFAULT_SCALE,
  chunkSize: number = CHUNK_SIZE,
): Array<{ script: string; nodeIds: string[] }> {
  const chunks: Array<{ script: string; nodeIds: string[] }> = [];

  for (let i = 0; i < nodeIds.length; i += chunkSize) {
    const batch = nodeIds.slice(i, i + chunkSize);
    chunks.push({
      script: buildPngExportScript(batch, scale),
      nodeIds: batch,
    });
  }

  return chunks;
}

/**
 * Merge results from multiple chunked export runs into one map.
 */
export function mergeExportResults(
  results: Array<{ exportedNodes: Record<string, string>; errors: any[] }>,
): { exportedNodes: Record<string, string>; errors: any[]; totalExported: number; totalErrors: number } {
  const merged: Record<string, string> = {};
  const allErrors: any[] = [];

  for (const result of results) {
    Object.assign(merged, result.exportedNodes);
    allErrors.push(...result.errors);
  }

  return {
    exportedNodes: merged,
    errors: allErrors,
    totalExported: Object.keys(merged).length,
    totalErrors: allErrors.length,
  };
}
