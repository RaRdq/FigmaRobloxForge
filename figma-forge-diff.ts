/**
 * FigmaForge Diff — Incremental Re-Export
 * 
 * Compares a previous manifest against the current extraction to determine
 * which PNG nodes have changed and need re-uploading. Unchanged nodes
 * keep their existing rbxassetid:// URLs.
 * 
 * Usage:
 *   figma-forge --input current.json --incremental prev.manifest.json
 * 
 * Saves ~80% upload time on iterative exports.
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import type { FigmaForgeNode } from './figma-forge-ir';

// ─── Types ───────────────────────────────────────────────────────

export interface DiffManifest {
  /** Nodes that changed and need re-export */
  changed: string[];
  /** Nodes that are unchanged and can reuse existing assets */
  unchanged: string[];
  /** Nodes that are new (not in previous manifest) */
  added: string[];
  /** Nodes that were removed (in previous but not current) */
  removed: string[];
  /** Map of nodeId → previous rbxassetid URL for reuse */
  reuseMap: Record<string, string>;
  /** Stats */
  stats: {
    totalCurrent: number;
    totalPrevious: number;
    changedCount: number;
    unchangedCount: number;
    addedCount: number;
    removedCount: number;
    savedUploads: number;
  };
}

export interface PreviousManifestEntry {
  nodeId: string;
  name: string;
  hash: string;
  assetId: string;
  width: number;
  height: number;
}

export interface PreviousManifest {
  version: string;
  generatedAt: string;
  sourceNodeId: string;
  entries: Record<string, PreviousManifestEntry>;
}

// ─── Hash Computation ────────────────────────────────────────────

/** Compute a structural hash for a node based on its visual properties */
function computeNodeHash(node: FigmaForgeNode): string {
  // Hash key properties that affect visual appearance
  const data = JSON.stringify({
    name: node.name,
    width: Math.round(node.width),
    height: Math.round(node.height),
    fills: node.fills?.map(f => ({ type: f.type, color: f.color, opacity: f.opacity })),
    effects: node.effects?.map(e => ({ type: e.type, radius: e.radius, color: e.color })),
    opacity: node.opacity,
    cornerRadius: node.cornerRadius,
    characters: node.characters,
    // Include children count and names for structural changes
    childCount: node.children?.length ?? 0,
    childNames: node.children?.map(c => c.name).join(','),
  });
  
  return crypto.createHash('md5').update(data).digest('hex').substring(0, 12);
}

// ─── Diff Engine ─────────────────────────────────────────────────

/**
 * Compare current IR tree against a previous manifest to find changes.
 */
export function computeDiff(
  currentRoot: FigmaForgeNode,
  previousManifestPath: string,
): DiffManifest {
  // Load previous manifest
  let previous: PreviousManifest;
  try {
    const raw = fs.readFileSync(previousManifestPath, 'utf-8');
    previous = JSON.parse(raw);
  } catch {
    // No previous manifest — everything is new
    const allNodeIds = collectAllNodeIds(currentRoot);
    return {
      changed: [],
      unchanged: [],
      added: allNodeIds,
      removed: [],
      reuseMap: {},
      stats: {
        totalCurrent: allNodeIds.length,
        totalPrevious: 0,
        changedCount: 0,
        unchangedCount: 0,
        addedCount: allNodeIds.length,
        removedCount: 0,
        savedUploads: 0,
      },
    };
  }

  // Collect current nodes
  const currentNodes = new Map<string, { node: FigmaForgeNode; hash: string }>();
  collectNodesWithHashes(currentRoot, currentNodes);

  const changed: string[] = [];
  const unchanged: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const reuseMap: Record<string, string> = {};

  // Compare current against previous
  for (const [nodeId, current] of currentNodes) {
    const prev = previous.entries[nodeId];
    if (!prev) {
      added.push(nodeId);
    } else if (prev.hash !== current.hash) {
      changed.push(nodeId);
    } else {
      unchanged.push(nodeId);
      reuseMap[nodeId] = prev.assetId;
    }
  }

  // Find removed nodes
  for (const nodeId of Object.keys(previous.entries)) {
    if (!currentNodes.has(nodeId)) {
      removed.push(nodeId);
    }
  }

  return {
    changed,
    unchanged,
    added,
    removed,
    reuseMap,
    stats: {
      totalCurrent: currentNodes.size,
      totalPrevious: Object.keys(previous.entries).length,
      changedCount: changed.length,
      unchangedCount: unchanged.length,
      addedCount: added.length,
      removedCount: removed.length,
      savedUploads: unchanged.length,
    },
  };
}

/**
 * Generate a manifest snapshot from the current IR tree for future diffing.
 * Call after successful upload to save the current state.
 */
export function generatePreviousManifest(
  root: FigmaForgeNode,
  assetMap: Record<string, string>,
): PreviousManifest {
  const entries: Record<string, PreviousManifestEntry> = {};
  
  function walk(node: FigmaForgeNode): void {
    if (!node.visible) return;
    const hash = computeNodeHash(node);
    const assetId = assetMap[node.id] || '';
    
    if (assetId) {
      entries[node.id] = {
        nodeId: node.id,
        name: node.name,
        hash,
        assetId,
        width: Math.round(node.width),
        height: Math.round(node.height),
      };
    }
    
    if (node.children) {
      for (const child of node.children) {
        walk(child);
      }
    }
  }
  
  walk(root);
  
  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    sourceNodeId: root.id,
    entries,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────

function collectAllNodeIds(node: FigmaForgeNode): string[] {
  const ids: string[] = [node.id];
  if (node.children) {
    for (const child of node.children) {
      ids.push(...collectAllNodeIds(child));
    }
  }
  return ids;
}

function collectNodesWithHashes(
  node: FigmaForgeNode,
  map: Map<string, { node: FigmaForgeNode; hash: string }>,
): void {
  if (!node.visible) return;
  map.set(node.id, { node, hash: computeNodeHash(node) });
  if (node.children) {
    for (const child of node.children) {
      collectNodesWithHashes(child, map);
    }
  }
}
