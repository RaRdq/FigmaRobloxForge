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
  computeBackgroundTransparency, mapTextAutoResize,
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
  let hc = node.constraints?.horizontal ?? 'MIN';
  let vc = node.constraints?.vertical ?? 'MIN';

  // --- SOW_UI_AAA Layout Overrides ---
  // 1. Force TitleBar to stretch across the full width of the Modal
  if (node.name === 'TitleBar') {
    hc = 'STRETCH';
  }
  // 2. Buy Buttons need their internal TextLabels perfectly centered
  if (node.type === 'TEXT' && (node as any).parent?.name?.includes('Btn') && !parentHasAutoLayout) {
    hc = 'CENTER';
    vc = 'CENTER';
  }
  // 3. Prevent Double Text on PricePills (especially for Luck Upgrade where the parent has a background and text is drawn twice)
  if (node.type === 'FRAME' && node.name === 'PricePill' && node.children) {
    // If we have a TextLabel inside, we want to ensure we don't accidentally render its duplicate
    const textChildren = node.children.filter(c => c.type === 'TEXT');
    if (textChildren.length > 1) {
      // Remove all but the last Text node (usually the uppermost in Figma stacking order)
      node.children = node.children.filter(c => c.type !== 'TEXT' || c.id === textChildren[textChildren.length - 1].id);
    }
  }
  
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
  parentCornerRadius: number = 0,
): string {
  if (!node) return '';
  if (node._isStrokeDuplicate) return '';

  const strategy = classifyNode(node, config);

  switch (strategy) {
    case 'png':
      return emitPngNode(node, zIndex, isRoot, parentHasAutoLayout, parentWidth, parentHeight, config, parentCornerRadius);
    case 'text_dynamic':
      return emitDynamicTextNode(node, config, zIndex, parentHasAutoLayout, parentWidth, parentHeight);
    case 'container':
      return emitContainerNode(node, config, zIndex, isRoot, parentHasAutoLayout, parentWidth, parentHeight);
  }
}

/**
 * Emit a visual node as an ImageLabel with its uploaded PNG asset.
 * This handles: visual frames, icons, designed text, leaf nodes.
 * 
 * GENERIC RULE: [Flatten] nodes that match interactive patterns (e.g. *Btn*)
 * automatically get an _Interact TextButton overlay injected as a child.
 * This ensures baked buttons are still clickable without manual post-processing.
 */
function emitPngNode(
  node: FigmaForgeNode,
  zIndex: number,
  isRoot: boolean,
  parentHasAutoLayout: boolean = false,
  parentWidth: number = 0,
  parentHeight: number = 0,
  config?: RuntimeConfig,
  parentCornerRadius: number = 0,
): string {
  const ref = nextRef();
  const rb = node._renderBounds;
  const effectiveW = rb ? rb.width : node.width;
  const effectiveH = rb ? rb.height : node.height;

  // Determine the image asset ID
  const assetId = node._resolvedImageId || '';
  const hasImage = !!assetId;

  // ── CRITICAL FIX: Use logical node dimensions for constraint geometry ──
  // When constraints (STRETCH, CENTER, SCALE) are applied, the geometry calculation
  // needs the LOGICAL node size (node.width/height), NOT render bounds (which include
  // glow/shadow expansion). Using render bounds with STRETCH produces:
  //   Size = {1, renderW - parentW} = {1, 12} → 12px wider than parent (WRONG)
  // Using node bounds with STRETCH produces:
  //   Size = {1, nodeW - parentW} = {1, 0} → exact parent width (CORRECT)
  //
  // Render bounds are ONLY correct for MIN constraint (absolute positioning)
  // where the PNG needs to display effects at their full expanded size.
  const hc = node.constraints?.horizontal ?? 'MIN';
  const vc = node.constraints?.vertical ?? 'MIN';
  const isStretchOrCenter = (name: string) => name === 'STRETCH' || name === 'CENTER' || name === 'SCALE' || name === 'MAX';
  // Also check for forced overrides (e.g. TitleBar → STRETCH)
  const forcedStretchH = node.name === 'TitleBar' || node.name === '[Flatten] TitleBar';
  const useNodeW = isStretchOrCenter(hc) || forcedStretchH;
  const useNodeH = isStretchOrCenter(vc);
  const geoW = useNodeW ? Math.round(node.width) : Math.round(effectiveW);
  const geoH = useNodeH ? Math.round(node.height) : Math.round(effectiveH);

  const [posXml, sizeXml, anchorXml] = emitGeometry(node, isRoot, parentHasAutoLayout, parentWidth, parentHeight, geoW, geoH);

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
    // XML-escape the URL (ampersands must be &amp; in XML attributes)
    const xmlSafeUrl = assetId.replace(/&/g, '&amp;');
    lines.push(`<Content name="Image"><url>${xmlSafeUrl}</url></Content>`);
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

  // ── GENERIC RULE: Auto-inject _Interact overlay for interactive [Flatten] PNG nodes ──
  // [Flatten] nodes are emitted as PNG (no container recursion), so they normally skip
  // the _Interact overlay. But interactive ones (e.g. CloseBtn) need clickable overlays.
  if (config && (node as any)._isFlattened && isInteractive(node.name, config)) {
    lines.push(emitInteractiveOverlay(node.name, zIndex));
  }

  // ── GENERIC RULE: Propagate UICorner from parent to edge-touching PNG children ──
  // Roblox ClipsDescendants clips RECTANGULARLY, not to rounded UICorner.
  // ImageLabels near parent edges (like InnerShine, glow overlays) show sharp corners
  // poking beyond the parent's rounded corners. Fix: add UICorner to edge-hugging PNGs.
  if (parentCornerRadius > 0 && !isRoot) {
    const nx = Math.round(node.x);
    const ny = Math.round(node.y);
    const nw = Math.round(effectiveW);
    const nh = Math.round(effectiveH);
    const pw = Math.round(parentWidth);
    const ph = Math.round(parentHeight);
    // Check if the node hugs the parent's edges (within 5px tolerance)
    const touchesLeft = nx <= 5;
    const touchesTop = ny <= 5;
    const touchesRight = pw > 0 && (nx + nw >= pw - 5);
    const touchesBottom = ph > 0 && (ny + nh >= ph - 5);
    const isWide = pw > 0 && nw >= pw * 0.85;
    const isTall = ph > 0 && nh >= ph * 0.85;
    // Add UICorner if the node spans most of one dimension AND touches corners
    if ((isWide && (touchesLeft || touchesRight)) || (isTall && (touchesTop || touchesBottom))) {
      const crRef = nextRef();
      const cr = Math.round(parentCornerRadius);
      lines.push(`<Item class="UICorner" referent="${crRef}"><Properties>`);
      lines.push(`<UDim name="CornerRadius"><S>0</S><O>${cr}</O></UDim>`);
      lines.push(`</Properties></Item>`);
    }
  }

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

  // Support both standard extract (fontFamily/fontSize/fontWeight) and turbo extract (family/size/style) formats
  const fontFamily = getFontFamily(ts?.fontFamily ?? ts?.family ?? node.fontFamily ?? 'Inter');
  // Map Figma font style names to numeric weights
  const styleToWeight: Record<string, number> = { Thin: 100, ExtraLight: 200, Light: 300, Regular: 400, Medium: 500, SemiBold: 600, Bold: 700, ExtraBold: 800, Black: 900 };
  const rawWeight = ts?.fontWeight ?? (ts?.style ? styleToWeight[ts.style] : undefined) ?? node.fontWeight ?? 400;
  const fontWeight = Number.isFinite(Number(rawWeight)) ? Math.round(Number(rawWeight) / 100) * 100 : 400;
  // Text color: support turbo extract fillR/G/B on textStyle, and standard fills array
  const textColor = (ts?.fillR !== undefined)
    ? { r: ts.fillR, g: ts.fillG ?? 0, b: ts.fillB ?? 0, a: ts.fillOpacity ?? 1 }
    : node.fills?.find(f => f.visible && f.type === 'SOLID')?.color
      ?? { r: 1, g: 1, b: 1, a: 1 };

  // Roblox TextXAlignment tokens: Left=0, Right=1, Center=2
  // Roblox TextYAlignment tokens: Top=0, Center=1, Bottom=2
  const hAlignMap: Record<string, number> = { LEFT: 0, CENTER: 2, RIGHT: 1, JUSTIFIED: 0 };
  const vAlignMap: Record<string, number> = { TOP: 0, CENTER: 1, BOTTOM: 2 };

  // ── GENERIC FIX: Dynamic text sizing depends on Figma resize mode ──
  // - WIDTH_AND_HEIGHT (HUG): keep Figma pixel size, let AutomaticSize=XY grow on demand.
  //   This preserves the narrow text box inside auto-layout that gets centered by UIListLayout.
  // - HEIGHT only: fill parent width (XS=1) so wrapping text uses all available space.
  const isDynamic = name.startsWith(config.dynamicPrefix);
  const resizeMode = node.textAutoResize ?? 'HEIGHT';
  const isHugText = resizeMode === 'WIDTH_AND_HEIGHT';

  const [basePosXml, baseSizeXml, baseAnchorXml] = emitGeometry(node, false, parentHasAutoLayout, parentWidth, parentHeight, Math.round(node.width), Math.round(node.height));
  
  // Size override: only HEIGHT-resize text fills parent width (for wrapping).
  // HUG text keeps its Figma pixel width — auto-layout UIListLayout handles centering.
  let sizeXml: string;
  if (isDynamic && parentHasAutoLayout && !isHugText) {
    // Wrapping text: fill parent width, fixed height
    sizeXml = `<UDim2 name="Size"><XS>1</XS><XO>0</XO><YS>0</YS><YO>${Math.round(node.height)}</YO></UDim2>`;
  } else {
    sizeXml = baseSizeXml;
  }

  // OVERRIDE AnchorPoint and Position based on text alignment for non-autolayout containers!
  // If we don't do this, center-aligned text will grow strictly to the right from X=0.
  let posXml = basePosXml;
  let anchorXml = baseAnchorXml;
  if (isDynamic && !parentHasAutoLayout) {
    const hAlign = ts?.textAlignHorizontal ?? ts?.textAlign ?? node.textAlignHorizontal ?? 'LEFT';
    const vAlign = ts?.textAlignVertical ?? node.textAlignVertical ?? 'TOP';
    
    let ax = 0, px = Math.round(node.x);
    if (hAlign === 'CENTER') { ax = 0.5; px = Math.round(node.x + (node.width / 2)); }
    else if (hAlign === 'RIGHT') { ax = 1.0; px = Math.round(node.x + node.width); }

    let ay = 0, py = Math.round(node.y);
    if (vAlign === 'CENTER') { ay = 0.5; py = Math.round(node.y + (node.height / 2)); }
    else if (vAlign === 'BOTTOM') { ay = 1.0; py = Math.round(node.y + node.height); }

    posXml = `<UDim2 name="Position"><XS>0</XS><XO>${px}</XO><YS>0</YS><YO>${py}</YO></UDim2>`;
    anchorXml = (ax !== 0 || ay !== 0) ? `<Vector2 name="AnchorPoint"><X>${ax}</X><Y>${ay}</Y></Vector2>` : '';
  }

  // ── GENERIC RULE: HUG text in centered auto-layout → CENTER alignment ──
  // In Figma, HUG text + centered auto-layout = visually centered (text box fits content exactly).
  // In Roblox, font rendering differs so the auto-sized box may not exactly fit, making LEFT visible.
  let effectiveHAlign = ts?.textAlignHorizontal ?? ts?.textAlign ?? node.textAlignHorizontal ?? 'LEFT';
  if (isHugText && parentHasAutoLayout && effectiveHAlign === 'LEFT') {
    effectiveHAlign = 'CENTER';
  }

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
    `<float name="TextSize">${ts?.fontSize ?? ts?.size ?? node.fontSize ?? 14}</float>`,
    colorXml('TextColor3', textColor),
    `<Font name="FontFace"><Family><url>${fontFamily}</url></Family><Weight>${fontWeight}</Weight><Style>Normal</Style></Font>`,
    `<token name="TextXAlignment">${hAlignMap[effectiveHAlign] ?? 0}</token>`,
    `<token name="TextYAlignment">${vAlignMap[ts?.textAlignVertical ?? node.textAlignVertical ?? 'TOP'] ?? 0}</token>`,
  ];

  if (anchorXml) lines.push(anchorXml);

  // Dynamic text must wrap to expand vertically if needed. Unless specifically WIDTH_AND_HEIGHT
  const resizeEnum = node.textAutoResize ?? 'HEIGHT';
  let autoSizeToken = 2; // Y
  let textWrapped = true;
  
  if (resizeEnum === 'WIDTH_AND_HEIGHT') {
    autoSizeToken = 3; // XY
    textWrapped = false;
  }
  
  lines.push(`<bool name="TextWrapped">${textWrapped}</bool>`);
  lines.push(`<token name="AutomaticSize">${mapTextAutoResize(resizeEnum).automaticSizeToken}</token>`);

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

  const hasRasterBG = !!((node as any)._isHybrid && (node as any)._resolvedImageId);
  const solidFill = (node as any)._solidFill as FigmaColor | undefined;
  const solidFillOpacity = (node as any)._solidFillOpacity as number | undefined;

  // ── Background color/transparency computation ──
  // Root frames MAY need background fills (e.g., modal dark BG). Only skip fills
  // when the root has NO intentional fill at all (bare Figma section/page).
  let bgTransparency = 1;
  let bgColor: FigmaColor | undefined = undefined;
  // Root frames with no solidFill and no rasterBG → transparent (Figma section default)
  const skipBgFill = isRoot && !solidFill && !hasRasterBG;

  if (skipBgFill) {
    // Root frame with no intentional fill: always transparent
    bgTransparency = 1;
  } else if (hasRasterBG) {
    // If a rasterized background image (ImageLabel) will be injected, the container Frame
    // must be fully transparent to prevent solid colors (like Roblox's default gray)
    // from rendering behind rounded corners, drop shadows, or translucent pixels in the PNG.
    bgTransparency = 1;
  } else if (solidFill) {
    // Pure solid fills (optimized in extract.ts to bypass PNG rasterization entirely)
    const fillOpacity = (solidFillOpacity ?? 1) * (node.opacity ?? 1);
    bgTransparency = round(1 - fillOpacity);
    bgColor = solidFill;
  } else if (node.fills && Array.isArray(node.fills) && node.fills.length > 0) {
    // Fallback for solid fills not caught by extract.ts
    const primaryFill = node.fills.find((f: any) => f.visible !== false && f.type === 'SOLID');
    if (primaryFill && primaryFill.color) {
      bgColor = primaryFill.color;
      const fillOpacity = (primaryFill.opacity ?? 1) * (node.opacity ?? 1);
      bgTransparency = round(1 - fillOpacity);
    }
  }

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

  // Set BackgroundColor3 from solid fill, computed fill, or hybrid fallback
  if (bgColor) {
    lines.push(colorXml('BackgroundColor3', bgColor));
  }

  if (isRoot && !anchorXml) {
    // Only push if anchorXml did not handle it
    lines.push(`<Vector2 name="AnchorPoint"><X>0.5</X><Y>0.5</Y></Vector2>`);
  }
  if (isRoot) {
    // ── GENERIC RULE: Root containers respect Figma's clipsContent property ──
    // CRITICAL FIX: Previously forced ClipsDescendants=true when corners were rounded,
    // ignoring Figma's clipsContent=false. This clipped TitleBar glow, CloseBtn at edges,
    // and shadow effects across ALL modals (required 5+ manual overrides in wiring code).
    //
    // Why rounded corners DON'T need ClipsDescendants:
    //   1. _BG ImageLabel already has its own UICorner (lines 699-713) for visual rounding
    //   2. Roblox ClipsDescendants clips RECTANGULARLY, not to rounded UICorner shapes
    //   3. Elements like CloseBtn, TitleBar glow intentionally extend beyond the root frame
    //
    // Only clip when Figma explicitly sets clipsContent=true.
    const rootClips = !!node.clipsContent;
    lines.push(`<bool name="ClipsDescendants">${rootClips}</bool>`);
  }

  if (sizing.autoSizeToken > 0) {
    lines.push(`<token name="AutomaticSize">${sizing.autoSizeToken}</token>`);
  }

  // ── Clipping: respect Figma's clipsContent BUT disable when children have shadows ──
  // Shadow siblings are prepended into the PARENT container. If the parent clips,
  // the shadow (which extends beyond the child's bounds) gets clipped and becomes invisible.
  // The _BG ImageLabel with UICorner already handles visual rounding — we don't need
  // Frame-level ClipsDescendants for that.
  if (!isRoot) {
    // Check if any child has a shadow that will be emitted as sibling in THIS container
    const childrenHaveShadows = node.children?.some(
      (c: any) => !!(c as any)._shadowImageHash && !!(c as any)._resolvedShadowId
    ) ?? false;
    // Only clip when Figma explicitly clips AND no shadow siblings would be clipped
    const shouldClip = node.clipsContent && !isScroll && !childrenHaveShadows;
    if (shouldClip) {
      lines.push(`<bool name="ClipsDescendants">true</bool>`);
    }
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
  if (hasRasterBG) {
    const bgRef = nextRef();
    const bgAsset = (node as any)._resolvedImageId as string;
    console.log("[DEBUG bgAsset]", bgAsset, "for node", node.name);
    // _BG size: if render bounds exist AND this is NOT the root container,
    // the PNG includes effects (shadows/blurs) that extend beyond node bounds.
    // ROOT containers should NOT expand _BG — the outer shadow is unnecessary
    // in-game (modal floats over dimmed overlay) and causes children (like title bars)
    // to appear narrower than the dark background.
    // HYBRID nodes (_isHybrid): outer effects are STRIPPED during clone+strip export,
    // so the PNG is always frame-sized. _renderBounds are STALE — ignore them.
    // Only [Flatten] atoms (non-hybrid) preserve outer effects and need render bounds.
    const isHybrid = !!(node as any)._isHybrid;
    const hasRenderBounds = !isRoot && !isHybrid && !!(rb && (rb.width > node.width + 0.5 || rb.height > node.height + 0.5));
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
    // ── UICorner on _BG: Roblox's ClipsDescendants clips to RECTANGULAR bounds only ──
    // UICorner on the parent Frame does NOT round children's corners.
    // Each _BG ImageLabel needs its own UICorner to match the parent's rounded corners.
    const bgCr = typeof node.cornerRadius === 'number' ? node.cornerRadius
      : (Array.isArray(node.cornerRadius) ? node.cornerRadius[0] : 0);
    if (bgCr > 0) {
      const bgCrRef = nextRef();
      lines.push(`<Item class="UICorner" referent="${bgCrRef}"><Properties>`);
      if (bgCr >= Math.min(node.width, node.height) / 2) {
        lines.push(`<UDim name="CornerRadius"><S>0.5</S><O>0</O></UDim>`);
      } else {
        lines.push(`<UDim name="CornerRadius"><S>0</S><O>${Math.round(bgCr)}</O></UDim>`);
      }
      lines.push(`</Properties></Item>`);
    }
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
    lines.push(`<int name="ZIndex">${(!isRoot && hasRasterBG) ? 2 : 1}</int>`);
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
    lines.push(`<UDim name="Padding"><S>0</S><O>${al.padding || 0}</O></UDim>`);
    lines.push(`<token name="HorizontalAlignment">${al.horizontalAlignment === 'Center' ? 1 : (al.horizontalAlignment === 'Right' ? 2 : 0)}</token>`);
    lines.push(`<token name="VerticalAlignment">${al.verticalAlignment === 'Center' ? 1 : (al.verticalAlignment === 'Bottom' ? 2 : 0)}</token>`);
    lines.push(`<token name="SortOrder">2</token>`); // LayoutOrder
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
  const childZBase = useContentWrapper ? 1 : (hasRasterBG ? 2 : 1);
  let maxChildZ = 0;

  // ── GENERIC RULE: Promote overflowing children when parent clips (cornerRadius) ──
  // When ClipsDescendants=true (from cornerRadius), children exceeding bounds get clipped.
  // Intentionally overflowing elements (like CloseBtn at -5y) must be promoted as siblings
  // with their position adjusted from parent-relative to grandparent-relative coordinates.
  const parentCr = typeof node.cornerRadius === 'number' ? node.cornerRadius
    : (Array.isArray(node.cornerRadius) ? Math.max(...(node.cornerRadius as number[])) : 0);
  const parentClips = parentCr > 0 && !isRoot;
  const promotedChildrenXml: string[] = [];

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
        const exceedsBounds = cx < 0 || cy < 0 || cx + cw > pw + 5 || cy + ch > ph + 5;
        if (exceedsBounds) {
          console.warn(`[FigmaForge] ⚠️  Child "${child.name}" (${cw}×${ch} at ${cx},${cy}) exceeds parent "${node.name}" bounds (${pw}×${ph})`);
        }

        // Promote ONLY overflowing INTERACTIVE children when parent clips due to cornerRadius.
        // Decorative elements (icons, bg images) intentionally overflow for visual effect — keep them.
        // Only interactive elements (buttons, close) need promotion for clickability.
        if (exceedsBounds && parentClips && isInteractive(child.name, config)) {
          // Adjust position: parent-relative → grandparent-relative
          const promoted = { ...child, x: child.x + node.x, y: child.y + node.y };
          const promotedXml = emitNode(promoted as FigmaForgeNode, config, childZ + 100, false, false, 0, 0);
          promotedChildrenXml.push(promotedXml);
          return; // Skip inline emission — will be emitted as sibling
        }
      }

      lines.push(emitNode(child, config, childZ, false, thisHasAutoLayout, node.width, node.height, parentCr));
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

  // Append promoted (overflowing) children as siblings of this container
  if (promotedChildrenXml.length > 0) {
    lines.push(...promotedChildrenXml);
  }

  // ── SHADOW SIBLING: Emit _Shadow ImageLabel as sibling (behind container) ──
  // When a container has _shadowImageHash (from DROP_SHADOW in Figma), emit a separate
  // ImageLabel BEFORE the container (prepended to output) that renders the shadow.
  // The shadow PNG is sized to _renderBounds (includes shadow expansion beyond frame).
  // This lives OUTSIDE ClipsDescendants, so the shadow renders beyond rounded corners.
  const shadowAsset = (node as any)._resolvedShadowId as string | undefined;
  if (shadowAsset && rb) {
    const shadowRef = nextRef();
    // _renderBounds from tree extraction stores ADJUSTED positions:
    //   rb.x = ir.x - extraLeft  (node position minus shadow expansion)
    //   rb.y = ir.y - extraTop   (node position minus shadow expansion)
    // These ARE the final shadow positions relative to the parent — no need to add node.x/y again.
    const shadowW = Math.round(rb.width);
    const shadowH = Math.round(rb.height);
    
    const shadowLines: string[] = [
      `<Item class="ImageLabel" referent="${shadowRef}">`,
      `<Properties>`,
      `<string name="Name">${escapeXmlAttr(node.name)}_Shadow</string>`,
      `<bool name="Visible">true</bool>`,
      `<int name="ZIndex">${Math.max(0, zIndex - 1)}</int>`,
      `<int name="BorderSizePixel">0</int>`,
      `<float name="BackgroundTransparency">1</float>`,
    ];
    
    if (isRoot) {
      // Root shadow: centered behind root frame, use scale-based positioning
      // For root, compute pure expansion offset: rb.x - node.x = -extraLeft
      const rootExpX = Math.round(rb.x - node.x);
      const rootExpY = Math.round(rb.y - node.y);
      shadowLines.push(`<UDim2 name="Position"><XS>0.5</XS><XO>${rootExpX}</XO><YS>0.5</YS><YO>${rootExpY}</YO></UDim2>`);
      shadowLines.push(`<Vector2 name="AnchorPoint"><X>0.5</X><Y>0.5</Y></Vector2>`);
    } else {
      // Non-root: rb.x/y already includes node position — use directly
      const shadowPosX = Math.round(rb.x);
      const shadowPosY = Math.round(rb.y);
      shadowLines.push(`<UDim2 name="Position"><XS>0</XS><XO>${shadowPosX}</XO><YS>0</YS><YO>${shadowPosY}</YO></UDim2>`);
    }
    
    shadowLines.push(`<UDim2 name="Size"><XS>0</XS><XO>${shadowW}</XO><YS>0</YS><YO>${shadowH}</YO></UDim2>`);
    shadowLines.push(`<Content name="Image"><url>${shadowAsset}</url></Content>`);
    shadowLines.push(`<token name="ScaleType">0</token>`); // Stretch
    shadowLines.push(`</Properties>`);
    shadowLines.push(`</Item>`);
    
    // PREPEND shadow before the container frame so it renders behind
    return shadowLines.join('\n') + '\n' + lines.join('\n');
  }

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
  if (!manifest || !manifest.root) {
    throw new Error('Invalid manifest: root node is missing.');
  }

    const body = emitNode(manifest.root, config, 1, true);
    // DIAGNOSTIC_FIX_VERIFIED
    const screenGuiRef = nextRef();
  const screenGuiName = manifest.root.name || 'FigmaForgeUI';

  // ScreenGui: Enabled=true (Lua controls visibility via rootFrame.Visible),
  // IgnoreGuiInset=true (proper centering), DisplayOrder=50 (above HUD)
  const screenGui = `<Item class="ScreenGui" referent="${screenGuiRef}"><Properties>` +
    `<string name="Name">${escapeXmlAttr(screenGuiName)}</string>` +
    `<bool name="IgnoreGuiInset">true</bool>` +
    `<bool name="ResetOnSpawn">false</bool>` +
    `<token name="ZIndexBehavior">1</token>` +
    `<bool name="Enabled">false</bool>` +
    `<int name="DisplayOrder">50</int>` +
    `</Properties>${body}</Item>`;

  return `<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">${screenGui}</roblox>`;
}
