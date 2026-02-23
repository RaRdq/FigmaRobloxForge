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
import { generateDynamicTextJS, FigmaForgeConfig, DEFAULT_CONFIG } from './figma-forge-shared';

/**
 * Builds a self-contained JavaScript string that, when executed in Figma's
 * plugin sandbox via figma_execute, walks the node tree and returns
 * a FigmaForgeManifest JSON object.
 * 
 * @param nodeId - The Figma node ID to start extraction from (e.g. "3:164")
 * @param skipPngExport - If true, skip base64 PNG rasterization (tree-only mode).
 *   The rasterQueue is still populated and `unresolvedImages` / `_rasterizedImageHash`
 *   are still set, but `exportedImages` will be empty. Use `buildRasterExportScript()`
 *   in a second pass to export the PNGs in batches.
 */
export function buildExtractionScript(nodeId: string, maxDepth: number = 10, skipPngExport: boolean = false, config: FigmaForgeConfig = DEFAULT_CONFIG): string {
  // Generate SSOT dynamic text classification functions
  const dynTextJS = generateDynamicTextJS(config);
  // This entire string runs inside Figma's plugin context.
  // It uses figma.getNodeByIdAsync() since the file may use dynamic-page access.
  return `
async function main() {
  const root = await figma.getNodeByIdAsync("${nodeId}");
  if (!root) return { error: "Node '${nodeId}' not found" };

  const stats = { totalNodes: 0, dedupedTextNodes: 0, imageNodes: 0, frameNodes: 0, textNodes: 0 };
  const unresolvedImages = [];
  const seenImageHashes = new Set();
  const exportedImages = {};
  const rasterQueue = []; // [{irNode, figmaNode}] — nodes needing rasterization
  const HIDE_TEXT_MODE = '${config.textExportMode}';

  // ── Dynamic Text Classification (SSOT — generated from figma-forge-shared) ──
  ${dynTextJS}

  // ── Helpers ──
  function uint8ToBase64(bytes) {
    const CHUNK = 8192;
    const parts = [];
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const chunk = bytes.slice(i, i + CHUNK);
      let binary = '';
      for (let j = 0; j < chunk.length; j++) {
        binary += String.fromCharCode(chunk[j]);
      }
      parts.push(binary);
    }
    const raw = parts.join('');
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let result = '';
    let i = 0;
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

  function hasNonLinearGradient(fills) {
    if (!fills) return false;
    for (const f of fills) {
      if (f.visible !== false && (f.type === 'GRADIENT_RADIAL' || f.type === 'GRADIENT_ANGULAR')) {
        return true;
      }
    }
    return false;
  }

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
      radius: e.radius ?? 0,
      color: e.color ? serializeColor(e.color) : undefined,
      offset: e.offset ? { x: e.offset.x, y: e.offset.y } : undefined,
      spread: e.spread ?? 0,
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
      itemSpacing: node.itemSpacing ?? 0,
      counterAxisSpacing: node.counterAxisSpacing ?? 0,
      paddingTop: node.paddingTop ?? 0,
      paddingRight: node.paddingRight ?? 0,
      paddingBottom: node.paddingBottom ?? 0,
      paddingLeft: node.paddingLeft ?? 0,
      primaryAxisAlignItems: node.primaryAxisAlignItems ?? 'MIN',
      counterAxisAlignItems: node.counterAxisAlignItems ?? 'MIN',
      layoutWrap: node.layoutWrap ?? 'NO_WRAP',
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
        node.topLeftRadius ?? 0,
        node.topRightRadius ?? 0,
        node.bottomRightRadius ?? 0,
        node.bottomLeftRadius ?? 0,
      ];
    }
    // Uniform or mixed
    if ('cornerRadius' in node) {
      return node.cornerRadius === figma.mixed ? 0 : (node.cornerRadius ?? 0);
    }
    return 0;
  }

  function serializeNode(node) {
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
      constraints: 'constraints' in node ? node.constraints : undefined,
      overflowDirection: 'overflowDirection' in node ? node.overflowDirection : 'NONE',
      fills: [],
      strokes: [],
      strokeWeight: 0,
      strokeAlign: 'INSIDE',
      effects: [],
      opacity: 'opacity' in node ? node.opacity : 1,
      blendMode: 'blendMode' in node ? node.blendMode : 'NORMAL',
      clipsContent: 'clipsDescendants' in node ? node.clipsDescendants : ('clipsContent' in node ? node.clipsContent : false),
      reactions: [],
      children: [],
    };

    // ── Serialization of Properties ──
    // Fills
    if ('fills' in node && node.fills && node.fills !== figma.mixed) {
      ir.fills = Array.from(node.fills).map(serializeFill);
    }

    // Strokes
    if ('strokes' in node && node.strokes) {
      ir.strokes = Array.from(node.strokes).map(serializeStroke);
      ir.strokeWeight = node.strokeWeight === figma.mixed ? (node.strokeTopWeight ?? 1) : (node.strokeWeight ?? 0);
      ir.strokeAlign = node.strokeAlign ?? 'INSIDE';
    }

    // Effects
    if ('effects' in node && node.effects) {
      ir.effects = Array.from(node.effects).map(serializeEffect);
    }

    // ── Render Bounds (accounts for drop shadows, blurs, strokes, and text metrics) ──
    // exportAsync captures the visual render including effects, so the PNG
    // may be larger than node.width/height. We compute the delta so the
    // assembler can size the ImageLabel to match the actual PNG dimensions.
    var hasVisibleEffects = ir.effects && ir.effects.some(function(e) {
      return e.visible && (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW' || e.type === 'LAYER_BLUR');
    });
    var hasVisibleStroke = node.strokes && node.strokes.length > 0 && node.strokeWeight > 0;
    var isText = node.type === 'TEXT';
    
    if ((hasVisibleEffects || hasVisibleStroke || isText) && 'absoluteRenderBounds' in node && node.absoluteRenderBounds && 'absoluteBoundingBox' in node && node.absoluteBoundingBox) {
      var arb = node.absoluteRenderBounds;
      var abb = node.absoluteBoundingBox;
      // Compute how much the render extends beyond the bounding box on each side
      var extraLeft = Math.max(0, abb.x - arb.x);
      var extraTop = Math.max(0, abb.y - arb.y);
      var renderW = Math.round(arb.width * 100) / 100;
      var renderH = Math.round(arb.height * 100) / 100;
      // Only store if render bounds actually differ from node bounds
      if (Math.abs(renderW - ir.width) > 0.5 || Math.abs(renderH - ir.height) > 0.5) {
        ir._renderBounds = {
          x: Math.round((ir.x - extraLeft) * 100) / 100,
          y: Math.round((ir.y - extraTop) * 100) / 100,
          width: Math.round(renderW),
          height: Math.round(renderH),
        };
        console.log('[FigmaForge] RenderBounds: ' + node.name + ' node=' + ir.width + 'x' + ir.height + ' render=' + renderW + 'x' + renderH);
      }
    }

    // Text-specific
    if (node.type === 'TEXT') {
      ir.characters = node.characters || '';
      ir.textStyle = serializeTextStyle(node);
      ir.textAutoResize = node.textAutoResize || 'NONE';
      stats.textNodes++;
    }

    // Auto Layout
    if ('layoutMode' in node) {
      ir.autoLayout = serializeAutoLayout(node);
    }

    // Layout sizing
    if ('layoutSizingHorizontal' in node) ir.layoutSizingHorizontal = node.layoutSizingHorizontal || 'FIXED';
    if ('layoutSizingVertical' in node) ir.layoutSizingVertical = node.layoutSizingVertical || 'FIXED';

    // Track frame nodes
    if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') stats.frameNodes++;

    // ── Layer Slicing Classification ──
    // Every node is exactly one of: TEXT, CONTAINER, PNG
    //   TEXT      → TextLabel (ALL text nodes — preserves editability)
    //   CONTAINER → Frame (any frame with children, preserves hierarchy)
    //               If it has a visible fill/stroke, also rasterize background (exported with ALL children hidden)
    //   PNG       → ImageLabel (leaf visuals, [Flatten]-tagged, childless)

    var hasChildren = 'children' in node && node.children && node.children.length > 0;
    var nodeName = node.name || '';
    var isFlattenTag = nodeName.includes('[Flatten]') || nodeName.includes('[Raster]') || nodeName.includes('[Flattened]');

    // Check if node has any visible fill or stroke (background that needs to be captured)
    const visibleFills = node.fills && Array.isArray(node.fills) ? node.fills.filter(function(f) { return f.visible !== false; }) : [];
    var hasVisibleFill = visibleFills.length > 0;
    var hasVisibleStroke = (node.strokes && Array.isArray(node.strokes) && node.strokes.length > 0 && (typeof node.strokeWeight === 'symbol' || node.strokeWeight > 0));
    var hasVisualBackground = hasVisibleFill || hasVisibleStroke;

    // VERY IMPORTANT: _solidFill optimization natively maps simple frames back to Roblox's BackgroundColor3
    // Removing this will force simple frames to rasterize as images, breaking script logic!
    if (visibleFills.length === 1 && visibleFills[0].type === 'SOLID' && !hasVisibleStroke && node.type !== 'TEXT' && !isFlattenTag) {
      if (!ir._solidFill) ir._solidFill = serializeColor(visibleFills[0].color);
      ir._solidFillOpacity = visibleFills[0].opacity ?? 1;
      // Because we can represent this 100% losslessly in Roblox as a Frame, we DO NOT need to rasterize a _BG!
      hasVisualBackground = false; 
    }

    if (isFlattenTag) {
      // [Flatten] / [Raster] / [Flattened] tag → ALWAYS export as single PNG
      // This MUST come FIRST — overrides TEXT / CONTAINER classification
      ir._isFlattened = true;
      if ('exportAsync' in node) {
        rasterQueue.push({ irNode: ir, figmaNode: node });
        console.log('[FigmaForge] [Flatten] PNG slice: ' + node.name + ' (' + node.id + ')');
      }
    } else if (node.type === 'TEXT') {
      // ALL text → TextLabel. Never rasterize text as PNG — game code expects .Text
      ir._isDynamic = true;
      if (typeof isDynText === 'function' && isDynText(node)) {
        ir._isDynamicPattern = true; // Mark for $ prefix in assembler
      }
      console.log('[FigmaForge] TEXT→TextLabel: ' + node.name + ' (' + node.id + ')');
    } else if (hasChildren) {
      // Frame with children → CONTAINER (preserves hierarchy)
      // Any visible fill/stroke → _isHybrid → _BG ImageLabel from rasterized PNG
      ir._isHybrid = hasVisualBackground;
      if (hasVisualBackground && 'exportAsync' in node) {
        rasterQueue.push({ irNode: ir, figmaNode: node });
        console.log('[FigmaForge] Container+BG (will rasterize): ' + node.name + ' (' + node.id + ')');
      } else {
        console.log('[FigmaForge] Container (no-bg): ' + node.name + ' (' + node.id + ')');
      }
    } else {
      // Leaf visual (childless, no tag) → export as single PNG
      ir._isFlattened = true;
      if ('exportAsync' in node) {
        rasterQueue.push({ irNode: ir, figmaNode: node });
        console.log('[FigmaForge] PNG slice: ' + node.name + ' (' + node.id + ')');
      }
    }

    // Clean name tags
    if (isFlattenTag) {
      ir.name = ir.name.replace(/\\[Flatten\\]\\s*/g, '').replace(/\\[Raster\\]\\s*/g, '').replace(/\\[Flattened\\]\\s*/g, '').trim();
    }

    // ── Children Processing ──
    // Recurse into CONTAINER nodes only — PNG nodes are flattened
    if ('children' in node && node.children && !ir._isFlattened) {
      ir.children = [];
      for (let ci = 0; ci < node.children.length; ci++) {
        const child = node.children[ci];
        const serialized = serializeNode(child);
        if (serialized) {
          ir.children.push(serialized);
        }
      }
    }

    // Reactions / Prototype interactions  (#15)
    if ('reactions' in node && node.reactions && node.reactions.length > 0) {
      ir.reactions = node.reactions.map(function(r) {
        const reaction = {
          trigger: { type: r.trigger ? r.trigger.type : 'ON_CLICK' },
        };
        if (r.trigger && r.trigger.delay !== undefined) {
          reaction.trigger.delay = r.trigger.delay;
        }
        if (r.action) {
          reaction.action = {
            type: r.action.type,
            destinationId: r.action.destinationId ?? undefined,
          };
          if (r.action.transition) {
            const t = r.action.transition;
            reaction.action.transition = {
              type: t.type,
              duration: t.duration,
              easing: {
                type: t.easing ? t.easing.type : 'EASE_IN_AND_OUT',
              },
              direction: t.direction ?? undefined,
            };
            if (t.easing && t.easing.type === 'CUSTOM_BEZIER' && t.easing.customBezier) {
              reaction.action.transition.easing.controlPoints = [
                t.easing.customBezier.x1, t.easing.customBezier.y1,
                t.easing.customBezier.x2, t.easing.customBezier.y2,
              ];
            }
          }
        }
        return reaction;
      });
    }

    return ir;
  }

  const rootIR = serializeNode(root);

  // ── Rasterization Loop (HYBRID AWARE) ──
  // Phase 1: Always assign raster hashes and record unresolved images
  for (const { irNode, figmaNode } of rasterQueue) {
    const hash = 'raster_' + figmaNode.id.replace(/:/g, '_');
    irNode._rasterizedImageHash = hash;
    unresolvedImages.push(hash);
  }

  // Phase 2: Export PNGs (skip if tree-only mode)
  const SKIP_PNG = ${skipPngExport};
  if (!SKIP_PNG) {
    for (const { irNode, figmaNode } of rasterQueue) {
      try {
        const hiddenNodes = [];
        if (irNode._isHybrid) {
          // Hide ALL children so only the background fill/stroke is baked into the PNG.
          // Children are preserved in the hierarchy and exported as their own separate PNGs.
          if ('children' in figmaNode && figmaNode.children) {
            for (const childNode of figmaNode.children) {
              if (childNode.visible) {
                childNode.visible = false;
                hiddenNodes.push(childNode);
              }
            }
          }
          console.log('[FigmaForge] Hidden ' + hiddenNodes.length + ' children for hybrid: ' + figmaNode.name);
          // CRITICAL: Figma's render pipeline needs a tick to process visibility changes
          // before exportAsync captures the frame. Without this, children are still
          // baked into the exported PNG.
          await new Promise(function(r) { setTimeout(r, 100); });
        }

        const pngBytes = await figmaNode.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });
        
        // Restore visibility
        for (const n of hiddenNodes) {
          n.visible = true;
        }

        const hash = irNode._rasterizedImageHash;
        exportedImages[hash] = uint8ToBase64(pngBytes);
        console.log('[FigmaForge] Rasterized ' + (irNode._isHybrid ? 'HYBRID' : 'ATOM') + ': ' + figmaNode.name + ' (' + figmaNode.id + ')');
      } catch (err) {
        console.error('[FigmaForge] FAILED to rasterize ' + figmaNode.name + ': ' + err.message);
      }
    }
  } else {
    console.log('[FigmaForge] Tree-only mode — skipped PNG export for ' + rasterQueue.length + ' nodes');
  }

  return {
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    sourceFile: figma.root.name,
    sourceNodeId: root.id,
    sourceNodeName: root.name,
    canvasWidth: root.width || 0,
    canvasHeight: root.height || 0,
    root: rootIR,
    unresolvedImages: unresolvedImages,
    exportedImages: exportedImages,
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
 * This pass uses MEDIAN-BASED CLUSTERING to separate stroke copies from the survivor:
 * 1. Groups sibling TEXT nodes by (characters, fontSize, fontFamily)
 * 2. Computes median position of the group
 * 3. Splits into "core" (within 6px of median) and "outliers" (further away)
 * 4. If core has ≥5 nodes with tight spread (≤8px) → it's a stroke simulation
 * 5. Identifies survivor: outlier with GRADIENT fill, or the last core node (highest z-index)
 * 6. Marks all stroke copies as _isStrokeDuplicate = true
 * 7. Computes stroke thickness from core positional offset
 * 
 * Returns the count of removed duplicate nodes.
 */
export function deduplicateTextStrokes(parent: { children: any[] }): number {
  if (!parent || !parent.children || !Array.isArray(parent.children) || parent.children.length === 0) return 0;

  let removedCount = 0;

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
    // Need at least 5 nodes to qualify as stroke simulation
    // (Figma typically uses 8-13 copies at cardinal + ordinal offsets + 1 real text)
    if (group.length < 5) continue;

    // ── Median-based clustering ──
    // Compute median x/y to find the center of the stroke cluster
    const xs = group.map((n: any) => n.x as number).sort((a, b) => a - b);
    const ys = group.map((n: any) => n.y as number).sort((a, b) => a - b);
    const medianX = xs[Math.floor(xs.length / 2)];
    const medianY = ys[Math.floor(ys.length / 2)];

    // Split into core (stroke copies near median) and outliers (potential survivors)
    const CLUSTER_RADIUS = 6; // px from median to qualify as stroke copy
    const core: any[] = [];
    const outliers: any[] = [];
    for (const node of group) {
      const dx = Math.abs(node.x - medianX);
      const dy = Math.abs(node.y - medianY);
      if (dx <= CLUSTER_RADIUS && dy <= CLUSTER_RADIUS) {
        core.push(node);
      } else {
        outliers.push(node);
      }
    }

    // Core must have ≥5 tightly clustered nodes to be a stroke simulation
    if (core.length < 5) continue;

    // Verify core has tight positional spread (≤8px in both axes)
    const coreXs = core.map((n: any) => n.x);
    const coreYs = core.map((n: any) => n.y);
    const coreXSpread = Math.max(...coreXs) - Math.min(...coreXs);
    const coreYSpread = Math.max(...coreYs) - Math.min(...coreYs);
    if (coreXSpread > 8 || coreYSpread > 8) continue;

    // ── Identify survivor ──
    // Priority: outlier with gradient fill > outlier with effects > last node in group (highest z-index)
    let survivor: any = null;

    // Check outliers for gradient-fill nodes (the "real" text is often gradient)
    for (const node of outliers) {
      const hasGradient = node.fills?.some((f: any) => f.type?.startsWith('GRADIENT_') && f.visible);
      const hasEffects = node.effects?.some((e: any) => e.visible);
      if (hasGradient || hasEffects) {
        survivor = node;
        break;
      }
    }

    // If no gradient outlier, try any outlier
    if (!survivor && outliers.length > 0) {
      survivor = outliers[outliers.length - 1];
    }

    // If no outliers at all, use the last core node (highest z-index in children array)
    if (!survivor) {
      survivor = group[group.length - 1];
    }

    // ── Mark stroke copies ──
    const strokeThickness = Math.max(coreXSpread, coreYSpread) / 2;

    for (const node of group) {
      if (node === survivor) continue;
      node._isStrokeDuplicate = true;
      removedCount++;
    }

    // The surviving node gets stroke metadata
    if (survivor) {
      survivor._inferredStrokeThickness = strokeThickness > 0 ? Math.ceil(strokeThickness) : 2;
    }

    // Detect stroke color from the core duplicates (they share the same fill color)
    const strokeSample = core.find((n: any) => n !== survivor);
    if (strokeSample?.fills?.length > 0) {
      const strokeFill = strokeSample.fills.find((f: any) => f.type === 'SOLID' && f.visible);
      if (strokeFill?.color) {
        survivor._inferredStrokeColor = strokeFill.color;
      }
    }
  }

  // Remove flagged duplicates from children array
  const beforeLen = parent.children.length;
  parent.children = parent.children.filter((c: any) => !c._isStrokeDuplicate);

  // Recurse into remaining children
  for (const child of parent.children) {
    if (child && child.children) {
      removedCount += deduplicateTextStrokes(child);
    }
  }

  return removedCount;
}

// countDedupedNodes was removed — use deduplicateTextStrokes() return value instead

/**
 * Builds a self-contained JavaScript string that, when executed in Figma's
 * plugin sandbox via figma_execute, exports all specified image hashes
 * as base64 PNG data.
 * 
 * Must run AFTER buildExtractionScript — uses the unresolvedImages list
 * from that first extraction pass.
 * 
 * Uses the correct Figma plugin API chain:
 *   figma.getImageByHash(hash) → Image → getBytesAsync() → Uint8Array → base64
 * 
 * @param imageHashes - Array of image hashes from manifest.unresolvedImages
 * @returns JavaScript string to execute via figma_execute
 */
export function buildImageExportScript(imageHashes: string[]): string {
  if (imageHashes.length === 0) {
    return `return { exportedImages: {}, stats: { total: 0, exported: 0, failed: 0 }, errors: [] };`;
  }

  // Embed the hashes directly into the generated script
  const hashesJson = JSON.stringify(imageHashes);

  return `
async function exportImages() {
  const hashes = ${hashesJson};
  const exportedImages = {};
  const errors = [];
  let exported = 0;
  let failed = 0;

  // Uint8Array → base64 (no btoa in plugin context, manual conversion)
  function uint8ToBase64(bytes) {
    const CHUNK = 8192;
    const parts = [];
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const chunk = bytes.slice(i, i + CHUNK);
      let binary = '';
      for (let j = 0; j < chunk.length; j++) {
        binary += String.fromCharCode(chunk[j]);
      }
      parts.push(binary);
    }
    const raw = parts.join('');
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let result = '';
    let i = 0;
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

  for (const hash of hashes) {
    try {
      const img = figma.getImageByHash(hash);
      if (!img) {
        errors.push('getImageByHash returned null for: ' + hash.slice(0, 12));
        failed++;
        continue;
      }
      const bytes = await img.getBytesAsync();
      if (!bytes || bytes.length === 0) {
        errors.push('getBytesAsync returned empty for: ' + hash.slice(0, 12));
        failed++;
        continue;
      }
      exportedImages[hash] = uint8ToBase64(bytes);
      exported++;
    } catch (err) {
      errors.push('Failed to export ' + hash.slice(0, 12) + ': ' + (err.message || String(err)));
      failed++;
    }
  }

  return {
    exportedImages: exportedImages,
    stats: { total: hashes.length, exported: exported, failed: failed },
    errors: errors,
  };
}
return exportImages();
`;
}

/**
 * Builds a JavaScript string that, when executed in Figma's plugin sandbox,
 * exports specified **nodes** as PNG (via exportAsync) and returns base64 data.
 * 
 * Use this AFTER `buildExtractionScript(nodeId, maxDepth, skipPngExport=true)` — 
 * the extraction produces `unresolvedImages` list with `raster_<nodeId>` hashes.
 * Parse those to get the original Figma node IDs, then batch them here.
 * 
 * For hybrid nodes (containers with dynamic text), text descendants are hidden
 * before export so they aren't baked into the background PNG.
 * 
 * @param entries - Array of { nodeId, rasterHash, isHybrid } to export
 * @param scale - Export scale factor (default: 2)
 * @returns JavaScript string to execute via figma_execute (timeout: 30000)
 */
export function buildRasterExportScript(
  entries: { nodeId: string; rasterHash: string; isHybrid?: boolean }[],
  scale: number = 2,
  config: FigmaForgeConfig,
): string {
  if (entries.length === 0) {
    return `return { exportedImages: {}, stats: { total: 0, exported: 0, failed: 0 }, errors: [] };`;
  }

  const entriesJson = JSON.stringify(entries);
  const dynTextJS = generateDynamicTextJS(config);

  return `
async function exportRasterNodes() {
  const entries = ${entriesJson};
  const exportedImages = {};
  const errors = [];
  let exported = 0;
  let failed = 0;
  const HIDE_TEXT_MODE = '${config.textExportMode}';

  // ── Dynamic Text Classification (SSOT — generated from figma-forge-shared) ──
  ${dynTextJS}

  function uint8ToBase64(bytes) {
    const CHUNK = 8192;
    const parts = [];
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const chunk = bytes.slice(i, i + CHUNK);
      let binary = '';
      for (let j = 0; j < chunk.length; j++) {
        binary += String.fromCharCode(chunk[j]);
      }
      parts.push(binary);
    }
    const raw = parts.join('');
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let result = '';
    let i = 0;
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

  async function hideTextDescendants(node) {
    const hidden = [];
    async function walk(n) {
      if (n.type === 'TEXT' && n.visible) {
        // Always hide ALL text during container raster — text is emitted as TextLabel separately
        n.visible = false;
        hidden.push(n);
      } else if ('children' in n && n.children) {
        for (const c of n.children) await walk(c);
      }
    }
    await walk(node);
    return hidden;
  }

  for (const entry of entries) {
    try {
      const node = await figma.getNodeByIdAsync(entry.nodeId);
      if (!node) {
        errors.push('Node not found: ' + entry.nodeId);
        failed++;
        continue;
      }
      if (!('exportAsync' in node)) {
        errors.push('Node cannot export: ' + entry.nodeId);
        failed++;
        continue;
      }

      // Hybrid: hide ALL children (not just text) so only background is captured
      let hidden = [];
      if (entry.isHybrid) {
        if ('children' in node && node.children) {
          for (const c of node.children) {
            if (c.visible) {
              c.visible = false;
              hidden.push(c);
            }
          }
        }
        console.log('[FigmaForge:Raster] Hidden ' + hidden.length + ' children for hybrid: ' + node.name);
        // CRITICAL: Figma render pipeline needs a tick to process visibility changes
        await new Promise(function(r) { setTimeout(r, 100); });
      }

      const pngBytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: ${scale} } });

      // Restore
      for (const n of hidden) n.visible = true;

      exportedImages[entry.rasterHash] = uint8ToBase64(pngBytes);
      exported++;
      console.log('[FigmaForge] Exported ' + entry.rasterHash + ' (' + (pngBytes.length / 1024).toFixed(1) + 'KB)');
    } catch (err) {
      errors.push('Failed ' + entry.nodeId + ': ' + (err.message || String(err)));
      failed++;
    }
  }

  return {
    exportedImages: exportedImages,
    stats: { total: entries.length, exported: exported, failed: failed },
    errors: errors,
  };
}
return exportRasterNodes();
`;
}
