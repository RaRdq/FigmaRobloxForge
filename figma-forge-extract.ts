/**
 * FigmaForge Extractor
 * 
 * Generates a JavaScript snippet that runs inside Figma's plugin context
 * (via figma_execute or the Desktop Bridge) to walk a node tree and
 * serialize it into FigmaForge IR JSON.
 * 
 * Usage:
 *   1. Copy the generated snippet from buildExtractionScript()
 *   2. Run it via figma_execute with the target nodeId
 *   3. Parse the returned JSON as FigmaForgeManifest
 */

import type { FigmaForgeManifest } from './figma-forge-ir';

/**
 * Builds a self-contained JavaScript string that, when executed in Figma's
 * plugin sandbox via figma_execute, walks the node tree and returns
 * a FigmaForgeManifest JSON object.
 * 
 * @param nodeId - The Figma node ID to start extraction from (e.g. "3:164")
 * @param maxDepth - Maximum recursion depth (default: 10)
 */
export function buildExtractionScript(nodeId: string, maxDepth: number = 10): string {
  // This entire string runs inside Figma's plugin context.
  // It uses figma.getNodeByIdAsync() since the file may use dynamic-page access.
  return `
async function main() {
  const root = await figma.getNodeByIdAsync("${nodeId}");
  if (!root) return { error: "Node '${nodeId}' not found" };

  const stats = { totalNodes: 0, dedupedTextNodes: 0, imageNodes: 0, frameNodes: 0, textNodes: 0 };
  const unresolvedImages = [];
  const seenImageHashes = new Set();

  function serializeColor(c) {
    if (!c) return { r: 0, g: 0, b: 0, a: 1 };
    return { r: c.r, g: c.g, b: c.b, a: c.a !== undefined ? c.a : 1 };
  }

  function serializeFill(f) {
    const fill = {
      type: f.type,
      visible: f.visible !== false,
      opacity: f.opacity !== undefined ? f.opacity : 1,
    };
    if (f.type === 'SOLID' && f.color) {
      fill.color = serializeColor(f.color);
      fill.color.a = fill.opacity;
    }
    if (f.gradientStops) {
      fill.gradientStops = f.gradientStops.map(s => ({
        position: s.position,
        color: serializeColor(s.color),
      }));
    }
    if (f.gradientTransform) {
      fill.gradientTransform = f.gradientTransform;
    }
    if (f.type === 'IMAGE') {
      fill.imageHash = f.imageHash || null;
      fill.scaleMode = f.scaleMode || 'FILL';
      if (f.imageHash && !seenImageHashes.has(f.imageHash)) {
        seenImageHashes.add(f.imageHash);
        unresolvedImages.push(f.imageHash);
      }
      stats.imageNodes++;
    }
    return fill;
  }

  function serializeStroke(s) {
    return {
      type: s.type,
      visible: s.visible !== false,
      color: s.color ? serializeColor(s.color) : undefined,
      gradientStops: s.gradientStops ? s.gradientStops.map(gs => ({
        position: gs.position,
        color: serializeColor(gs.color),
      })) : undefined,
    };
  }

  function serializeEffect(e) {
    return {
      type: e.type,
      visible: e.visible !== false,
      radius: e.radius || 0,
      color: e.color ? serializeColor(e.color) : undefined,
      offset: e.offset ? { x: e.offset.x, y: e.offset.y } : undefined,
      spread: e.spread || 0,
    };
  }

  function serializeTextStyle(node) {
    // Handle mixed styles by reading from the node directly
    const style = {};
    try {
      style.fontFamily = node.fontName && node.fontName !== figma.mixed ? node.fontName.family : 'Inter';
      style.fontWeight = node.fontWeight && node.fontWeight !== figma.mixed ? node.fontWeight : 400;
      style.fontStyle = (node.fontName && node.fontName !== figma.mixed && node.fontName.style) 
        ? (node.fontName.style.includes('Italic') ? 'Italic' : 'Normal')
        : 'Normal';
      style.fontSize = node.fontSize && node.fontSize !== figma.mixed ? node.fontSize : 14;
      style.lineHeight = node.lineHeight && node.lineHeight !== figma.mixed
        ? (node.lineHeight.unit === 'AUTO' ? 'AUTO' : node.lineHeight.value)
        : 'AUTO';
      style.letterSpacing = node.letterSpacing && node.letterSpacing !== figma.mixed ? node.letterSpacing.value : 0;
      style.textAlignHorizontal = node.textAlignHorizontal || 'LEFT';
      style.textAlignVertical = node.textAlignVertical || 'TOP';
      style.textDecoration = node.textDecoration && node.textDecoration !== figma.mixed ? node.textDecoration : 'NONE';
      style.textCase = node.textCase && node.textCase !== figma.mixed ? node.textCase : 'ORIGINAL';
    } catch (e) {
      // Fallbacks for mixed styles
      style.fontFamily = 'Inter';
      style.fontWeight = 400;
      style.fontStyle = 'Normal';
      style.fontSize = 14;
      style.lineHeight = 'AUTO';
      style.letterSpacing = 0;
      style.textAlignHorizontal = 'LEFT';
      style.textAlignVertical = 'TOP';
      style.textDecoration = 'NONE';
      style.textCase = 'ORIGINAL';
    }
    return style;
  }

  function serializeAutoLayout(node) {
    if (!node.layoutMode || node.layoutMode === 'NONE') return undefined;
    return {
      mode: node.layoutMode,
      itemSpacing: node.itemSpacing || 0,
      counterAxisSpacing: node.counterAxisSpacing || 0,
      paddingTop: node.paddingTop || 0,
      paddingRight: node.paddingRight || 0,
      paddingBottom: node.paddingBottom || 0,
      paddingLeft: node.paddingLeft || 0,
      primaryAxisAlignItems: node.primaryAxisAlignItems || 'MIN',
      counterAxisAlignItems: node.counterAxisAlignItems || 'MIN',
      layoutWrap: node.layoutWrap || 'NO_WRAP',
    };
  }

  function getCornerRadius(node) {
    // Check for per-corner radius first
    if ('topLeftRadius' in node && (
      node.topLeftRadius !== node.topRightRadius ||
      node.topLeftRadius !== node.bottomRightRadius ||
      node.topLeftRadius !== node.bottomLeftRadius
    )) {
      return [
        node.topLeftRadius || 0,
        node.topRightRadius || 0,
        node.bottomRightRadius || 0,
        node.bottomLeftRadius || 0,
      ];
    }
    // Uniform or mixed
    if ('cornerRadius' in node) {
      return node.cornerRadius === figma.mixed ? 0 : (node.cornerRadius || 0);
    }
    return 0;
  }

  function serializeNode(node, depth) {
    if (depth > ${maxDepth}) return null;
    stats.totalNodes++;

    const ir = {
      id: node.id,
      name: node.name,
      type: node.type,
      visible: node.visible !== false,
      x: 'x' in node ? Math.round(node.x * 100) / 100 : 0,
      y: 'y' in node ? Math.round(node.y * 100) / 100 : 0,
      width: 'width' in node ? Math.round(node.width * 100) / 100 : 0,
      height: 'height' in node ? Math.round(node.height * 100) / 100 : 0,
      rotation: 'rotation' in node ? Math.round(node.rotation * 100) / 100 : 0,
      cornerRadius: getCornerRadius(node),
      fills: [],
      strokes: [],
      strokeWeight: 0,
      strokeAlign: 'INSIDE',
      effects: [],
      opacity: 'opacity' in node ? node.opacity : 1,
      blendMode: 'blendMode' in node ? node.blendMode : 'NORMAL',
      clipsContent: 'clipsDescendants' in node ? node.clipsDescendants : ('clipsContent' in node ? node.clipsContent : false),
      children: [],
    };

    // Fills
    if ('fills' in node && node.fills && node.fills !== figma.mixed) {
      ir.fills = Array.from(node.fills).map(serializeFill);
    }

    // Strokes
    if ('strokes' in node && node.strokes) {
      ir.strokes = Array.from(node.strokes).map(serializeStroke);
      ir.strokeWeight = node.strokeWeight === figma.mixed ? (node.strokeTopWeight || 1) : (node.strokeWeight || 0);
      ir.strokeAlign = node.strokeAlign || 'INSIDE';
    }

    // Effects
    if ('effects' in node && node.effects) {
      ir.effects = Array.from(node.effects).map(serializeEffect);
    }

    // Text-specific
    if (node.type === 'TEXT') {
      ir.characters = node.characters || '';
      ir.textStyle = serializeTextStyle(node);
      stats.textNodes++;
    }

    // Auto Layout
    if ('layoutMode' in node) {
      ir.autoLayout = serializeAutoLayout(node);
    }

    // Track frame nodes
    if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') {
      stats.frameNodes++;
    }

    // Children (maintain z-order: first child = bottom)
    if ('children' in node && node.children) {
      ir.children = [];
      for (const child of node.children) {
        const serialized = serializeNode(child, depth + 1);
        if (serialized) ir.children.push(serialized);
      }
    }

    return ir;
  }

  const rootIR = serializeNode(root, 0);

  return {
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    sourceFile: figma.root.name,
    sourceNodeId: "${nodeId}",
    sourceNodeName: root.name,
    canvasWidth: root.width || 0,
    canvasHeight: root.height || 0,
    root: rootIR,
    unresolvedImages: unresolvedImages,
    stats: stats,
  };
}
return main();
`;
}

/**
 * Text-stroke deduplication pass.
 * 
 * Figma simulates text strokes by duplicating TEXT nodes at ±1-3px offsets
 * with the same content. The "Figma To Roblox" plugin exports all of them.
 * 
 * This pass:
 * 1. Groups sibling TEXT nodes by (characters, fontSize, fontFamily)
 * 2. If group size > 4 and positions differ by ≤ 3px → it's a stroke simulation
 * 3. Keeps only the LAST node (highest z-index = the "real" colored text on top)
 * 4. Marks all others as _isStrokeDuplicate = true
 * 5. Computes stroke thickness from the max positional offset
 * 
 * Returns the inferred stroke thickness for the surviving node.
 */
export function deduplicateTextStrokes(parent: { children: any[] }): void {
  if (!parent.children || parent.children.length === 0) return;

  // Group TEXT children by content fingerprint
  const textGroups = new Map<string, any[]>();

  for (const child of parent.children) {
    if (child.type === 'TEXT' && child.characters) {
      const fontSize = child.textStyle?.fontSize ?? child.fontSize ?? 0;
      const fontFamily = child.textStyle?.fontFamily ?? 'unknown';
      const key = `${child.characters}|${fontSize}|${fontFamily}`;

      if (!textGroups.has(key)) textGroups.set(key, []);
      textGroups.get(key)!.push(child);
    }
  }

  // Process each group
  for (const [_key, group] of textGroups) {
    // Need at least 5 duplicates to qualify as stroke simulation
    // (Figma typically uses 8-13 copies at cardinal + ordinal offsets)
    if (group.length < 5) continue;

    // Check positional spread — all nodes should be within 3px of each other
    const xs = group.map((n: any) => n.x);
    const ys = group.map((n: any) => n.y);
    const xSpread = Math.max(...xs) - Math.min(...xs);
    const ySpread = Math.max(...ys) - Math.min(...ys);

    if (xSpread > 8 || ySpread > 8) continue; // Not a stroke simulation (threshold accounts for ±3px stroke + drop shadow offset)

    // This IS a stroke simulation group.
    // The last node in the array (highest z-index) is the "real" text.
    // All others are stroke duplicates.
    const strokeThickness = Math.max(xSpread, ySpread) / 2;

    // Keep only the last node (top of z-stack)
    for (let i = 0; i < group.length - 1; i++) {
      group[i]._isStrokeDuplicate = true;
    }

    // The surviving node gets stroke metadata
    const survivor = group[group.length - 1];
    survivor._inferredStrokeThickness = strokeThickness > 0 ? Math.ceil(strokeThickness) : 2;

    // Detect stroke color from the duplicates (they all share the same fill color)
    // The stroke color is the fill of the duplicate nodes (usually darker/outline color)
    if (group.length > 1 && group[0].fills && group[0].fills.length > 0) {
      const strokeFill = group[0].fills.find((f: any) => f.type === 'SOLID' && f.visible);
      if (strokeFill && strokeFill.color) {
        survivor._inferredStrokeColor = strokeFill.color;
      }
    }
  }

  // Remove flagged duplicates from children array
  parent.children = parent.children.filter((c: any) => !c._isStrokeDuplicate);

  // Recurse into remaining children
  for (const child of parent.children) {
    if (child.children) {
      deduplicateTextStrokes(child);
    }
  }
}

/**
 * Count how many nodes were removed by deduplication.
 */
export function countDedupedNodes(manifest: FigmaForgeManifest): number {
  const beforeCount = manifest.stats.totalNodes;
  let afterCount = 0;

  function countNodes(node: any): void {
    afterCount++;
    if (node.children) {
      for (const child of node.children) countNodes(child);
    }
  }

  countNodes(manifest.root);
  return beforeCount - afterCount;
}
