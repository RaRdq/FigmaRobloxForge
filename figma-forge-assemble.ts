/**
 * FigmaForge Assembler v2 — PNG-based .rbxmx Generator
 * 
 * Assembles a complete .rbxmx from the IR node tree, where:
 * - Visual nodes → ImageLabel with uploaded rbxassetid:// PNGs
 * - Designed text (headers, titles, decorative) → ImageLabel (preserved as PNG)
 * - Dynamic text (runtime values, $ prefix) → TextLabel for game code binding
 * - Container nodes → Frame with auto-layout (UIListLayout + UIPadding)
 * 
 * The output imports via Rojo and renders 1:1 with the Figma design.
 */

import type { FigmaForgeNode, FigmaForgeManifest, FigmaColor } from './figma-forge-ir';
import {
  round, escapeXmlAttr, getFontFamily,
  mapAutoLayout, mapLayoutSizing, computeCanvasSize,
  isScrollContainer, isDynamicText, RuntimeConfig,
  sanitizeTextForRoblox, isTemplateNode, stripConventionSuffix, isScrollConvention,
  computeBackgroundTransparency,
} from './figma-forge-shared';

// ─── Constants ───────────────────────────────────────────────────
const DEFAULT_SCROLLBAR_THICKNESS = 4;

/** Module-level referent counter — always reset at the start of assembleRbxmx().
 *  Safe because all emit functions are module-internal and only called during assembly. */
let refCounter = 0;
function nextRef(): string { return `RBX${refCounter++}`; }

// ─── Node Classification ─────────────────────────────────────────

/**
 * Classify a node's export strategy.
 * 
 * - 'png': export as PNG ImageLabel (leaf visuals, icons, backgrounds)
 * - 'text_dynamic': emit as TextLabel (ALL text nodes — preserves editability)
 * - 'container': Frame with children (hierarchy preserved, auto-layout mapped)
 * 
 * Strategy: preserve FULL hierarchy. Every text is a TextLabel, every frame
 * with children is a container. Only childless leaf visuals become PNG.
 */
function classifyNode(
  node: FigmaForgeNode,
  config: RuntimeConfig,
): 'png' | 'text_dynamic' | 'container' {
  // ALL text → TextLabel FIRST — takes priority over _isFlattened.
  // Game code expects .Text property on every text node.
  if (node.type === 'TEXT') return 'text_dynamic';

  // Explicitly flattened nodes → always PNG
  if (node._isFlattened) return 'png';

  // Leaf nodes (no children): always PNG
  if (!node.children || node.children.length === 0) {
    return 'png';
  }

  // ANY frame with children → container (preserve hierarchy)
  return 'container';
}


// ─── Interactive Detection ───────────────────────────────────────

/** Check if a node name indicates an interactive container that needs a TextButton overlay */
function isInteractive(name: string, config: RuntimeConfig): boolean {
  return config._compiledInteractivePatterns.some(p => p.test(name));
}

/** Emit an invisible TextButton overlay for click detection.
 *  Name: `{parentName}_Interact`, fills parent, transparent, highest ZIndex. */
function emitInteractiveOverlay(parentName: string, maxChildZIndex: number): string {
  const ref = nextRef();
  const name = `${parentName}_Interact`;
  const z = maxChildZIndex + 10;
  return [
    `<Item class="TextButton" referent="${ref}">`,
    `<Properties>`,
    `<string name="Name">${escapeXmlAttr(name)}</string>`,
    `<bool name="Visible">true</bool>`,
    `<int name="ZIndex">${z}</int>`,
    `<int name="BorderSizePixel">0</int>`,
    `<float name="BackgroundTransparency">1</float>`,
    `<UDim2 name="Position"><XS>0</XS><XO>0</XO><YS>0</YS><YO>0</YO></UDim2>`,
    `<UDim2 name="Size"><XS>1</XS><XO>0</XO><YS>1</YS><YO>0</YO></UDim2>`,
    `<string name="Text"></string>`,
    `<bool name="AutoButtonColor">false</bool>`,
    `</Properties>`,
    `</Item>`,
  ].join('\n');
}

// ─── XML Helpers ─────────────────────────────────────────────────

function colorXml(tag: string, c: FigmaColor): string {
  return `<Color3 name="${tag}"><R>${round(c.r)}</R><G>${round(c.g)}</G><B>${round(c.b)}</B></Color3>`;
}

// ─── Node Emission ───────────────────────────────────────────────

function emitGeometry(
  node: FigmaForgeNode,
  isRoot: boolean,
  parentHasAutoLayout: boolean,
  pw: number,
  ph: number,
  defaultSizeXOff: number,
  defaultSizeYOff: number,
): [string, string, string] {
  // If in auto-layout, UIListLayout controls position, size uses layoutSizing
  if (parentHasAutoLayout && !isRoot) {
    const sxs = node.layoutSizingHorizontal === 'FILL' ? 1 : 0;
    const sys = node.layoutSizingVertical === 'FILL' ? 1 : 0;
    const sxo = sxs > 0 ? 0 : defaultSizeXOff;
    const syo = sys > 0 ? 0 : defaultSizeYOff;
    return [
      `<UDim2 name="Position"><XS>0</XS><XO>0</XO><YS>0</YS><YO>0</YO></UDim2>`,
      `<UDim2 name="Size"><XS>${sxs}</XS><XO>${sxo}</XO><YS>${sys}</YS><YO>${syo}</YO></UDim2>`,
      ''
    ];
  }

  // Root elements usually centered in ScreenGui
  if (isRoot) {
    return [
      `<UDim2 name="Position"><XS>0.5</XS><XO>0</XO><YS>0.5</YS><YO>0</YO></UDim2>`,
      `<UDim2 name="Size"><XS>0</XS><XO>${defaultSizeXOff}</XO><YS>0</YS><YO>${defaultSizeYOff}</YO></UDim2>`,
      `<Vector2 name="AnchorPoint"><X>0.5</X><Y>0.5</Y></Vector2>`
    ];
  }

  // Parse Constraints
  const hc = node.constraints?.horizontal ?? 'MIN';
  const vc = node.constraints?.vertical ?? 'MIN';
  
  let pxs = 0, pxo = Math.round(node.x), sxs = 0, sxo = defaultSizeXOff, ax = 0;
  let pys = 0, pyo = Math.round(node.y), sys = 0, syo = defaultSizeYOff, ay = 0;

  // Horizontal Constraints
  if (hc === 'MAX') {
    pxs = 1; pxo = Math.round(node.x - pw);
    sxs = 0; sxo = defaultSizeXOff;
    ax = 1; // Anchor right
  } else if (hc === 'CENTER') {
    pxs = 0.5; pxo = Math.round(node.x + (defaultSizeXOff / 2) - (pw / 2));
    sxs = 0; sxo = defaultSizeXOff;
    ax = 0.5; // Anchor center
  } else if (hc === 'STRETCH') {
    pxs = 0; pxo = Math.round(node.x);
    sxs = 1; sxo = Math.round(defaultSizeXOff - pw); // Usually X offset + Width gives total padding
  } else if (hc === 'SCALE') {
    pxs = pw > 0 ? node.x / pw : 0; pxo = 0;
    sxs = pw > 0 ? defaultSizeXOff / pw : 0; sxo = 0;
  }

  // Vertical Constraints
  if (vc === 'MAX') {
    pys = 1; pyo = Math.round(node.y - ph);
    sys = 0; syo = defaultSizeYOff;
    ay = 1; // Anchor bottom
  } else if (vc === 'CENTER') {
    pys = 0.5; pyo = Math.round(node.y + (defaultSizeYOff / 2) - (ph / 2));
    sys = 0; syo = defaultSizeYOff;
    ay = 0.5; // Anchor middle
  } else if (vc === 'STRETCH') {
    pys = 0; pyo = Math.round(node.y);
    sys = 1; syo = Math.round(defaultSizeYOff - ph);
  } else if (vc === 'SCALE') {
    pys = ph > 0 ? node.y / ph : 0; pyo = 0;
    sys = ph > 0 ? defaultSizeYOff / ph : 0; syo = 0;
  }

  const anchorXml = (ax !== 0 || ay !== 0) 
    ? `<Vector2 name="AnchorPoint"><X>${ax}</X><Y>${ay}</Y></Vector2>` 
    : '';

  return [
    `<UDim2 name="Position"><XS>${pxs}</XS><XO>${pxo}</XO><YS>${pys}</YS><YO>${pyo}</YO></UDim2>`,
    `<UDim2 name="Size"><XS>${sxs}</XS><XO>${sxo}</XO><YS>${sys}</YS><YO>${syo}</YO></UDim2>`,
    anchorXml
  ];
}

function emitNode(
  node: FigmaForgeNode,
  config: RuntimeConfig,
  zIndex: number = 0,
  isRoot: boolean = false,
  parentHasAutoLayout: boolean = false,
  parentWidth: number = 0,
  parentHeight: number = 0,
): string {
  if (node._isStrokeDuplicate) return '';

  const strategy = classifyNode(node, config);

  switch (strategy) {
    case 'png':
      return emitPngNode(node, zIndex, isRoot, parentHasAutoLayout, parentWidth, parentHeight);
    case 'text_dynamic':
      return emitDynamicTextNode(node, config, zIndex, parentHasAutoLayout, parentWidth, parentHeight);
    case 'container':
      return emitContainerNode(node, config, zIndex, isRoot, parentHasAutoLayout, parentWidth, parentHeight);
  }
}

/**
 * Emit a visual node as an ImageLabel with its uploaded PNG asset.
 * This handles: visual frames, icons, designed text, leaf nodes.
 */
function emitPngNode(
  node: FigmaForgeNode,
  zIndex: number,
  isRoot: boolean,
  parentHasAutoLayout: boolean = false,
  parentWidth: number = 0,
  parentHeight: number = 0,
): string {
  const ref = nextRef();
  const rb = node._renderBounds;
  const effectiveW = rb ? rb.width : node.width;
  const effectiveH = rb ? rb.height : node.height;

  // Determine the image asset ID
  const assetId = node._resolvedImageId || '';
  const hasImage = !!assetId;

  const [posXml, sizeXml, anchorXml] = emitGeometry(node, isRoot, parentHasAutoLayout, parentWidth, parentHeight, Math.round(effectiveW), Math.round(effectiveH));

  // Always use ImageLabel — it supports both Image AND BackgroundColor3.
  // Frame does NOT support Image/ScaleType, so solid-fill nodes must also be ImageLabel.
  // When node has BOTH solidFill AND a resolved image, the image IS the visual —
  // the solid fill is just Figma's underlying paint layer, so make bg transparent.
  const isSolidFrame = !!node._solidFill;
  const solidFillOnlyNoImage = isSolidFrame && !hasImage;
  const bgTransparency = solidFillOnlyNoImage ? computeBackgroundTransparency(node) : 1;

  const lines: string[] = [
    `<Item class="ImageLabel" referent="${ref}">`,
    `<Properties>`,
    `<string name="Name">${escapeXmlAttr(node.name)}</string>`,
    `<bool name="Visible">${node.visible !== false}</bool>`,
    `<int name="ZIndex">${zIndex}</int>`,
    `<int name="BorderSizePixel">0</int>`,
    `<float name="BackgroundTransparency">${bgTransparency}</float>`,
    posXml,
    sizeXml,
  ];

  if (anchorXml) lines.push(anchorXml);

  // Only set BackgroundColor3 when there's a solid fill and NO image
  if (solidFillOnlyNoImage) {
    lines.push(colorXml('BackgroundColor3', node._solidFill));
  }

  const sizing = mapLayoutSizing(node.layoutSizingHorizontal, node.layoutSizingVertical);
  if (sizing.autoSizeToken > 0) {
    lines.push(`<token name="AutomaticSize">${sizing.autoSizeToken}</token>`);
  }

  if (hasImage) {
    lines.push(`<Content name="Image"><url>${assetId}</url></Content>`);
    // 9-slice if metadata present, else Stretch (pixel-exact PNG)
    const slice = (node as any)._sliceCenter;
    if (slice) {
      lines.push(`<token name="ScaleType">1</token>`); // Slice
      lines.push(`<Rect name="SliceCenter"><Min><X>${slice.left}</X><Y>${slice.top}</Y></Min><Max><X>${slice.right}</X><Y>${slice.bottom}</Y></Max></Rect>`);
    } else {
      lines.push(`<token name="ScaleType">0</token>`); // Stretch
    }
  }

  if (isRoot) {
    lines.push(`<token name="ZIndexBehavior">1</token>`); // Sibling
  }

  // Rotation: Figma rotation → Roblox Rotation property (degrees)
  if (node.rotation && Math.abs(node.rotation) > 0.01) {
    lines.push(`<float name="Rotation">${round(node.rotation)}</float>`);
  }

  lines.push(`</Properties>`);
  lines.push(`</Item>`);
  return lines.join('\n');
}

/**
 * Emit a dynamic text node as a TextLabel for runtime binding.
 * Name uses dynamic prefix for easy discovery in game code.
 */
function emitDynamicTextNode(
  node: FigmaForgeNode,
  config: RuntimeConfig,
  zIndex: number,
  parentHasAutoLayout: boolean = false,
  parentWidth: number = 0,
  parentHeight: number = 0,
): string {
  const ref = nextRef();
  const ts = node.textStyle;
  // Only add $ prefix for text nodes that match dynamic patterns (runtime-bound values).
  // Non-dynamic text (labels, designed text) keeps its original Figma name.
  const name = node.name.startsWith(config.dynamicPrefix)
    ? node.name
    : node._isDynamicPattern
      ? `${config.dynamicPrefix}${node.name}`
      : node.name;

  const fontFamily = getFontFamily(ts?.fontFamily ?? node.fontFamily ?? 'Inter');
  const rawWeight = Number(ts?.fontWeight ?? node.fontWeight ?? 400);
  const fontWeight = Number.isFinite(rawWeight) ? Math.round(rawWeight / 100) * 100 : 400;
  const textColor = node.fills?.find(f => f.visible && f.type === 'SOLID')?.color
    ?? { r: 1, g: 1, b: 1, a: 1 };

  const hAlignMap: Record<string, number> = { LEFT: 0, RIGHT: 1, CENTER: 2, JUSTIFIED: 0 };
  const vAlignMap: Record<string, number> = { TOP: 0, CENTER: 1, BOTTOM: 2 };

  // ── GENERIC FIX: Dynamic text ($prefix) uses parent-relative width + AutomaticSize ──
  // Figma text bounds are snapped to static content — at runtime the text changes,
  // so we use parent-fill width and let Roblox auto-size the height.
  const isDynamic = name.startsWith(config.dynamicPrefix);

  const [posXml, baseSizeXml, anchorXml] = emitGeometry(node, false, parentHasAutoLayout, parentWidth, parentHeight, Math.round(node.width), Math.round(node.height));
  
  // Size override: dynamic text inside auto-layout forces Scale X = 1
  const sizeXml = (isDynamic && parentHasAutoLayout)
    ? `<UDim2 name="Size"><XS>1</XS><XO>0</XO><YS>0</YS><YO>${Math.round(node.height)}</YO></UDim2>`
    : baseSizeXml;

  const lines: string[] = [
    `<Item class="TextLabel" referent="${ref}">`,
    `<Properties>`,
    `<string name="Name">${escapeXmlAttr(name)}</string>`,
    `<bool name="Visible">${node.visible !== false}</bool>`,
    `<int name="ZIndex">${zIndex}</int>`,
    `<int name="BorderSizePixel">0</int>`,
    `<float name="BackgroundTransparency">1</float>`,
    posXml,
    sizeXml,
    `<string name="Text">${escapeXmlAttr(sanitizeTextForRoblox(node.characters ?? ''))}</string>`,
    `<float name="TextSize">${ts?.fontSize ?? node.fontSize ?? 14}</float>`,
    colorXml('TextColor3', textColor),
    `<Font name="FontFace"><Family><url>${fontFamily}</url></Family><Weight>${fontWeight}</Weight><Style>Normal</Style></Font>`,
    `<token name="TextXAlignment">${hAlignMap[ts?.textAlignHorizontal ?? node.textAlignHorizontal ?? 'LEFT'] ?? 0}</token>`,
    `<token name="TextYAlignment">${vAlignMap[ts?.textAlignVertical ?? node.textAlignVertical ?? 'TOP'] ?? 0}</token>`,
    `<bool name="TextWrapped">${isDynamic ? 'true' : 'false'}</bool>`,
  ];

  if (anchorXml) lines.push(anchorXml);

  // Dynamic text gets AutomaticSize=Y so the label grows vertically if text wraps
  if (isDynamic) {
    lines.push(`<token name="AutomaticSize">2</token>`);  // Y=2
  }

  // Text transparency from node opacity
  if (node.opacity < 1) {
    lines.push(`<float name="TextTransparency">${round(1 - node.opacity)}</float>`);
  }

  // UIStroke for text outline (from inferred stroke or Figma stroke)
  if (node._inferredStrokeThickness && node._inferredStrokeColor) {
    const sRef = nextRef();
    lines.push(`</Properties>`);
    lines.push(`<Item class="UIStroke" referent="${sRef}"><Properties>`);
    lines.push(colorXml('Color', node._inferredStrokeColor));
    lines.push(`<float name="Thickness">${node._inferredStrokeThickness}</float>`);
    lines.push(`<token name="ApplyStrokeMode">0</token>`); // Contextual for text
    lines.push(`</Properties></Item>`);
    lines.push(`</Item>`);
  } else if (node.strokes?.length && node.strokeWeight > 0) {
    const stroke = node.strokes.find(s => s.visible && s.color);
    if (stroke?.color) {
      const sRef = nextRef();
      lines.push(`</Properties>`);
      lines.push(`<Item class="UIStroke" referent="${sRef}"><Properties>`);
      lines.push(colorXml('Color', stroke.color));
      lines.push(`<float name="Thickness">${Math.round(node.strokeWeight)}</float>`);
      lines.push(`<token name="ApplyStrokeMode">0</token>`);
      lines.push(`</Properties></Item>`);
      lines.push(`</Item>`);
    } else {
      lines.push(`</Properties>`);
      lines.push(`</Item>`);
    }
  } else {
    lines.push(`</Properties>`);
    lines.push(`</Item>`);
  }

  return lines.join('\n');
}

/**
 * Emit a container node as a Frame that preserves hierarchy.
 * Children are recursively emitted as PNG or dynamic text.
 * Auto-layout → UIListLayout + UIPadding.
 */
function emitContainerNode(
  node: FigmaForgeNode,
  config: RuntimeConfig,
  zIndex: number,
  isRoot: boolean,
  parentHasAutoLayout: boolean = false,
  parentWidth: number = 0,
  parentHeight: number = 0,
): string {
  const ref = nextRef();
  const isScroll = isScrollContainer(node);
  const className = isScroll ? 'ScrollingFrame' : 'Frame';
  const sizing = mapLayoutSizing(node.layoutSizingHorizontal, node.layoutSizingVertical);

  // ── Container Frame ALWAYS uses Figma's exact node size ──
  // Render bounds expansion (for drop shadows, blurs) is ONLY applied to the _BG ImageLabel,
  // NOT to the container Frame. Expanding the Frame pushes children out of alignment
  // and causes neighboring elements (like title bars) to not fill the parent width.
  const rb = (node as any)._renderBounds as { x: number; y: number; width: number; height: number } | undefined;
  
  const [posXml, sizeXml, anchorXml] = emitGeometry(node, isRoot, parentHasAutoLayout, parentWidth, parentHeight, Math.round(node.width), Math.round(node.height));

  const hasBgUnderlay = !isRoot && !!((node as any)._isHybrid && (node as any)._resolvedImageId);
  const solidFill = (node as any)._solidFill as FigmaColor | undefined;
  const bgTransparency = solidFill ? computeBackgroundTransparency(node) : 1;

  const lines: string[] = [
    `<Item class="${className}" referent="${ref}">`,
    `<Properties>`,
    `<string name="Name">${escapeXmlAttr(node.name)}</string>`,
    `<bool name="Visible">${node.visible !== false}</bool>`,
    `<int name="ZIndex">${zIndex}</int>`,
    `<int name="BorderSizePixel">0</int>`,
    `<float name="BackgroundTransparency">${bgTransparency}</float>`,
    posXml,
    sizeXml,
  ];

  if (anchorXml) lines.push(anchorXml);

  // Solid fill → set BackgroundColor3 directly on Frame (no ImageLabel needed)
  if (solidFill) {
    lines.push(colorXml('BackgroundColor3', solidFill));
  }

  if (isRoot && !anchorXml) {
    // Only push if anchorXml did not handle it
    lines.push(`<Vector2 name="AnchorPoint"><X>0.5</X><Y>0.5</Y></Vector2>`);
  }
  if (isRoot) {
    // Respect Figma's clipsContent — some modals intentionally overflow (e.g. close button, title bar)
    lines.push(`<bool name="ClipsDescendants">${!!node.clipsContent}</bool>`);
  }

  if (sizing.autoSizeToken > 0) {
    lines.push(`<token name="AutomaticSize">${sizing.autoSizeToken}</token>`);
  }

  if (node.clipsContent && !isScroll && !isRoot) {
    // Hybrid containers with render bounds may have effects that extend beyond node bounds.
    // The frame itself uses exact Figma size, but _BG extends for effects — so clipping is safe.
    lines.push(`<bool name="ClipsDescendants">true</bool>`);
  }

  if (isRoot) {
    lines.push(`<token name="ZIndexBehavior">1</token>`);
  }

  // ScrollingFrame properties
  if (isScroll) {
    const canvasSize = computeCanvasSize(node);
    lines.push(`<UDim2 name="CanvasSize"><XS>0</XS><XO>${Math.round(canvasSize.width)}</XO><YS>0</YS><YO>${Math.round(canvasSize.height)}</YO></UDim2>`);
    lines.push(`<int name="ScrollBarThickness">${DEFAULT_SCROLLBAR_THICKNESS}</int>`);
    lines.push(`<bool name="ScrollingEnabled">true</bool>`);
  }

  lines.push(`</Properties>`);

  // ── UICorner for rounded containers ──
  const cr = typeof node.cornerRadius === 'number' ? node.cornerRadius
    : (Array.isArray(node.cornerRadius) ? node.cornerRadius[0] : 0);
  if (cr > 0) {
    const crRef = nextRef();
    const isCircle = cr >= Math.min(node.width, node.height) / 2;
    lines.push(`<Item class="UICorner" referent="${crRef}"><Properties>`);
    if (isCircle) {
      lines.push(`<UDim name="CornerRadius"><S>0.5</S><O>0</O></UDim>`);
    } else {
      lines.push(`<UDim name="CornerRadius"><S>0</S><O>${Math.round(cr)}</O></UDim>`);
    }
    lines.push(`</Properties></Item>`);
  }

  // ── Background underlay: rasterized PNG as ImageLabel _BG ──────────────────
  // Per SOW_UI_AAA.md §2.2: hybrid containers with non-trivial backgrounds (gradients,
  // image fills, complex effects) emit ImageLabel "_BG" at ZIndex=1 from a rasterized PNG.
  // Pure solid fills are handled above via BackgroundColor3 on the Frame — no PNG needed.
  // _isHybrid is ONLY true for non-solid backgrounds (set in extract.ts).
  if ((node as any)._isHybrid && (node as any)._resolvedImageId) {
    const bgRef = nextRef();
    const bgAsset = (node as any)._resolvedImageId as string;
    // _BG size: if render bounds exist AND this is NOT the root container,
    // the PNG includes effects (shadows/blurs) that extend beyond node bounds.
    // ROOT containers should NOT expand _BG — the outer shadow is unnecessary
    // in-game (modal floats over dimmed overlay) and causes children (like title bars)
    // to appear narrower than the dark background.
    const hasRenderBounds = !isRoot && !!(rb && (rb.width > node.width + 0.5 || rb.height > node.height + 0.5));
    const bgXO = hasRenderBounds ? Math.round(rb!.x - node.x) : 0;
    const bgYO = hasRenderBounds ? Math.round(rb!.y - node.y) : 0;
    const bgW = hasRenderBounds ? Math.round(rb!.width) : 0;
    const bgH = hasRenderBounds ? Math.round(rb!.height) : 0;
    lines.push(`<Item class="ImageLabel" referent="${bgRef}">`);
    lines.push(`<Properties>`);
    lines.push(`<string name="Name">_BG</string>`);
    lines.push(`<bool name="Visible">true</bool>`);
    lines.push(`<int name="ZIndex">0</int>`);  // ZIndex=0: behind all children (children start at 2+)
    lines.push(`<int name="BorderSizePixel">0</int>`);
    lines.push(`<float name="BackgroundTransparency">1</float>`);
    if (hasRenderBounds) {
      // Absolute position/size for effects-expanded PNGs
      lines.push(`<UDim2 name="Position"><XS>0</XS><XO>${bgXO}</XO><YS>0</YS><YO>${bgYO}</YO></UDim2>`);
      lines.push(`<UDim2 name="Size"><XS>0</XS><XO>${bgW}</XO><YS>0</YS><YO>${bgH}</YO></UDim2>`);
    } else {
      // No effects or ROOT: _BG fills the container exactly (stretch to fit)
      lines.push(`<UDim2 name="Position"><XS>0</XS><XO>0</XO><YS>0</YS><YO>0</YO></UDim2>`);
      lines.push(`<UDim2 name="Size"><XS>1</XS><XO>0</XO><YS>1</YS><YO>0</YO></UDim2>`);
    }
    lines.push(`<Content name="Image"><url>${bgAsset}</url></Content>`);
    lines.push(`<token name="ScaleType">0</token>`);
    lines.push(`</Properties>`);
    lines.push(`</Item>`);
  }


  // ── Auto-layout children (UIListLayout + UIPadding) ──
  const al = mapAutoLayout(node);
  const useContentWrapper = !!al;

  if (useContentWrapper) {
    const cRef = nextRef();
    lines.push(`<Item class="Frame" referent="${cRef}"><Properties>`);
    lines.push(`<string name="Name">Content</string>`);
    lines.push(`<bool name="Visible">true</bool>`);
    lines.push(`<int name="ZIndex">${hasBgUnderlay ? 2 : 1}</int>`);
    lines.push(`<int name="BorderSizePixel">0</int>`);
    lines.push(`<float name="BackgroundTransparency">1</float>`);
    lines.push(`<UDim2 name="Position"><XS>0</XS><XO>0</XO><YS>0</YS><YO>0</YO></UDim2>`);
    if (isScroll) {
      const canvasSize = computeCanvasSize(node);
      lines.push(`<UDim2 name="Size"><XS>0</XS><XO>${Math.round(canvasSize.width)}</XO><YS>0</YS><YO>${Math.round(canvasSize.height)}</YO></UDim2>`);
    } else {
      lines.push(`<UDim2 name="Size"><XS>1</XS><XO>0</XO><YS>1</YS><YO>0</YO></UDim2>`);
    }
    lines.push(`</Properties>`);
  }

  if (al) {
    const llRef = nextRef();
    lines.push(`<Item class="UIListLayout" referent="${llRef}"><Properties>`);
    lines.push(`<token name="FillDirection">${al.fillDirection === 'Horizontal' ? 0 : 1}</token>`);
    lines.push(`<UDim name="Padding"><S>0</S><O>${al.padding}</O></UDim>`);
    lines.push(`<token name="HorizontalAlignment">${al.horizontalAlignment === 'Center' ? 1 : (al.horizontalAlignment === 'Right' ? 2 : 0)}</token>`);
    lines.push(`<token name="VerticalAlignment">${al.verticalAlignment === 'Center' ? 1 : (al.verticalAlignment === 'Bottom' ? 2 : 0)}</token>`);
    lines.push(`<token name="SortOrder">2</token>`);
    if (al.wraps) {
      lines.push(`<bool name="Wraps">true</bool>`);
    }
    lines.push(`</Properties></Item>`);

    if (al.paddingTop || al.paddingRight || al.paddingBottom || al.paddingLeft) {
      const pRef = nextRef();
      lines.push(`<Item class="UIPadding" referent="${pRef}"><Properties>`);
      lines.push(`<UDim name="PaddingTop"><S>0</S><O>${al.paddingTop}</O></UDim>`);
      lines.push(`<UDim name="PaddingRight"><S>0</S><O>${al.paddingRight}</O></UDim>`);
      lines.push(`<UDim name="PaddingBottom"><S>0</S><O>${al.paddingBottom}</O></UDim>`);
      lines.push(`<UDim name="PaddingLeft"><S>0</S><O>${al.paddingLeft}</O></UDim>`);
      lines.push(`</Properties></Item>`);
    }
  }

  // ── Emit children ──
  const thisHasAutoLayout = !!al;
  // If wrapped in Content, Content frame provides Z-isolation, so children start at 1.
  // Otherwise, children must render above the _BG underlay.
  const childZBase = useContentWrapper ? 1 : (hasBgUnderlay ? 2 : 1);
  let maxChildZ = 0;
  if (node.children) {
    node.children.forEach((child, i) => {
      const childZ = childZBase + i;
      if (childZ > maxChildZ) maxChildZ = childZ;

      if (!thisHasAutoLayout && !isRoot) {
        const cx = Math.round(child.x);
        const cy = Math.round(child.y);
        const cw = Math.round(child.width);
        const ch = Math.round(child.height);
        const pw = Math.round(node.width);
        const ph = Math.round(node.height);
        if (cx < 0 || cy < 0) {
          // Negative positions now safely preserved by UDim2 translation and Content wrapping
        }
        if (cx + cw > pw + 5 || cy + ch > ph + 5) {
          console.warn(`[FigmaForge] ⚠️  Child "${child.name}" (${cw}×${ch} at ${cx},${cy}) exceeds parent "${node.name}" bounds (${pw}×${ph})`);
        }
      }

      lines.push(emitNode(child, config, childZ, false, thisHasAutoLayout, node.width, node.height));
    });
  }

  if (useContentWrapper) {
    lines.push(`</Item>`); // Close the Content frame
  }

  // ── Auto-inject TextButton overlay for interactive containers ──
  if (isInteractive(node.name, config) && !isRoot) {
    // Inject at a high ZIndex on the main frame so it covers Content and _BG
    const interactZ = useContentWrapper ? 10 : maxChildZ + 1;
    lines.push(emitInteractiveOverlay(node.name, interactZ));
  }

  lines.push(`</Item>`);
  return lines.join('\n');
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Assemble a complete .rbxmx from a FigmaForge manifest.
 * 
 * The output preserves the Figma hierarchy:
 * - Visual nodes → ImageLabel (PNG assets)
 * - Designed text → ImageLabel (PNG, preserves styling)
 * - Dynamic text → TextLabel ($ prefix, game code binds values)
 * - Containers → Frame + UIListLayout (auto-layout preserved)
 * 
 * @param manifest - The FigmaForge IR manifest
 * @param config - The runtime config for text extraction and defaults
 * @returns Complete .rbxmx XML string
 */
export function assembleRbxmx(
  manifest: FigmaForgeManifest,
  config: RuntimeConfig,
): string {
  refCounter = 0;
  const body = emitNode(manifest.root, config, 1, true);
  const screenGuiRef = nextRef();
  const screenGuiName = manifest.root.name || 'FigmaForgeUI';

  // ScreenGui: Enabled=true (Lua controls visibility via rootFrame.Visible),
  // IgnoreGuiInset=true (proper centering), DisplayOrder=50 (above HUD)
  const screenGui = `<Item class="ScreenGui" referent="${screenGuiRef}"><Properties>` +
    `<string name="Name">${escapeXmlAttr(screenGuiName)}</string>` +
    `<bool name="IgnoreGuiInset">true</bool>` +
    `<bool name="ResetOnSpawn">false</bool>` +
    `<token name="ZIndexBehavior">1</token>` +
    `<bool name="Enabled">true</bool>` +
    `<int name="DisplayOrder">50</int>` +
    `</Properties>${body}</Item>`;

  return `<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">${screenGui}</roblox>`;
}
