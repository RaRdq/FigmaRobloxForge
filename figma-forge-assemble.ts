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
  isScrollContainer,
} from './figma-forge-shared';

let refCounter = 0;
function nextRef(): string { return `RBX${refCounter++}`; }

// ─── Text Classification ─────────────────────────────────────────

/**
 * Determine if a text node contains dynamic content (runtime-bound values).
 * 
 * Dynamic text = TextLabel in Roblox (game code updates it).
 * Designed text = PNG ImageLabel (preserves exact visual styling).
 * 
 * Classification rules (in priority order):
 * 1. Layer name starts with dynamicPrefix (e.g. "$CashAmount") → DYNAMIC
 * 2. Content matches placeholder patterns → DYNAMIC
 * 3. Everything else → DESIGNED (export as PNG)
 */
function isDynamicText(node: FigmaForgeNode, dynamicPrefix: string): boolean {
  // Rule 1: Explicit prefix in layer name
  if (node.name.startsWith(dynamicPrefix)) return true;

  // Rule 2: Layer name convention detection (common dynamic naming patterns)
  const dynamicNamePatterns = [
    /price/i,            // Price1, Price10, PriceLabel
    /^unit/i,            // UnitName, UnitLevel
    /^socket/i,          // SocketIcon_1, SocketMulti_1
    /^stats/i,           // StatsText, StatsValue
    /^timer/i,           // Timer, TimerLabel
    /^count/i,           // Counter, CountLabel
    /^amount/i,          // Amount, AmountLabel
    /^level/i,           // Level, LevelText
    /^score/i,           // Score, ScoreLabel
    /^currency/i,        // CurrencyAmount
    /^health/i,          // HealthBar, HealthText
    /^progress/i,        // ProgressText
    /^rank/i,            // RankText
    /^value/i,           // ValueLabel
    /^quantity/i,        // QuantityText
  ];
  if (dynamicNamePatterns.some(p => p.test(node.name))) return true;

  // Rule 3: Placeholder pattern detection on text content
  const text = (node.characters ?? '').trim();
  if (!text) return false;

  const placeholderPatterns = [
    /^\{.+\}$/,              // {value}, {playerName}
    /^\$[\d.,]+[KMBkmb]?$/,  // $1,234, $1.2K, $10.5M (currency with suffixes)
    /^[\d,]+$/,              // 1234, 1,000
    /^\d+:\d+$/,             // 00:00 (timer)
    /^x[\d.]+$/i,            // x3, X10, x2.0 — multiplier placeholders
    /^Level \d+$/i,          // Level 5
    /^Lv\.?\d+$/i,           // Lv.42, Lv5
    /^Player ?Name$/i,       // PlayerName, Player Name
    /^0$/,                   // Single zero placeholder
    /^\d+%$/,                // 50%
    /^\.\.\./,               // ... (loading placeholder)
    /→/,                     // Arrow stats like "$1.2K → $1.5K/s"
    /^\p{Emoji}+$/u,         // Single emoji (e.g. 👑, ⭐) — often dynamic icons
    /^\?$/,                  // Single "?" — empty socket placeholder
  ];

  return placeholderPatterns.some(p => p.test(text));
}

/**
 * Classify a node's export strategy.
 * 
 * - 'png': export as PNG ImageLabel (visual elements, designed text)
 * - 'text_dynamic': emit as TextLabel (runtime-bound values)
 * - 'container': Frame with children (auto-layout preserved)
 */
function classifyNode(
  node: FigmaForgeNode,
  dynamicPrefix: string,
): 'png' | 'text_dynamic' | 'container' {
  // Text nodes: classify as dynamic or designed
  if (node.type === 'TEXT') {
    return isDynamicText(node, dynamicPrefix) ? 'text_dynamic' : 'png';
  }

  // Leaf nodes (no children): always PNG
  if (!node.children || node.children.length === 0) {
    return 'png';
  }

  // Containers with children: check if any descendant has dynamic text.
  // If yes → container (preserve hierarchy so dynamic text is accessible).
  // If no → PNG (flatten entire subtree into one image).
  if (hasDescendantDynamicText(node, dynamicPrefix)) {
    return 'container';
  }

  // No dynamic text anywhere inside → export entire subtree as one PNG
  return 'png';
}

function hasDescendantDynamicText(node: FigmaForgeNode, prefix: string): boolean {
  if (node.type === 'TEXT' && isDynamicText(node, prefix)) return true;
  if (!node.children) return false;
  return node.children.some(child => hasDescendantDynamicText(child, prefix));
}

// ─── XML Helpers ─────────────────────────────────────────────────

function colorXml(tag: string, c: FigmaColor): string {
  return `<Color3 name="${tag}"><R>${round(c.r)}</R><G>${round(c.g)}</G><B>${round(c.b)}</B></Color3>`;
}

// ─── Node Emission ───────────────────────────────────────────────

function emitNode(
  node: FigmaForgeNode,
  dynamicPrefix: string,
  zIndex: number = 0,
  isRoot: boolean = false,
  parentHasAutoLayout: boolean = false,
): string {
  if (!node.visible || node._isStrokeDuplicate) return '';

  const strategy = classifyNode(node, dynamicPrefix);

  switch (strategy) {
    case 'png':
      return emitPngNode(node, zIndex, isRoot, parentHasAutoLayout);
    case 'text_dynamic':
      return emitDynamicTextNode(node, dynamicPrefix, zIndex, parentHasAutoLayout);
    case 'container':
      return emitContainerNode(node, dynamicPrefix, zIndex, isRoot, parentHasAutoLayout);
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
): string {
  const ref = nextRef();
  const sizing = mapLayoutSizing(node.layoutSizingHorizontal, node.layoutSizingVertical);
  const sxs = sizing.sizeXScale;
  const sys = sizing.sizeYScale;

  // Use render bounds if available (includes drop shadow / blur padding)
  const rb = node._renderBounds;
  const effectiveW = rb ? rb.width : node.width;
  const effectiveH = rb ? rb.height : node.height;
  const effectiveX = rb ? rb.x : node.x;
  const effectiveY = rb ? rb.y : node.y;

  const sxo = sxs > 0 ? 0 : Math.round(effectiveW);
  const syo = sys > 0 ? 0 : Math.round(effectiveH);

  // Determine the image asset ID
  const assetId = node._resolvedImageId || '';
  const hasImage = !!assetId;

  // Position: root → screen center, auto-layout child → skip (UIListLayout manages), else → parent-relative
  let posXml: string;
  if (isRoot) {
    posXml = `<UDim2 name="Position"><XS>0.5</XS><XO>0</XO><YS>0.5</YS><YO>0</YO></UDim2>`;
  } else if (parentHasAutoLayout) {
    posXml = `<UDim2 name="Position"><XS>0</XS><XO>0</XO><YS>0</YS><YO>0</YO></UDim2>`;
  } else {
    posXml = `<UDim2 name="Position"><XS>0</XS><XO>${Math.round(effectiveX)}</XO><YS>0</YS><YO>${Math.round(effectiveY)}</YO></UDim2>`;
  }

  const lines: string[] = [
    `<Item class="ImageLabel" referent="${ref}">`,
    `<Properties>`,
    `<string name="Name">${escapeXmlAttr(node.name)}</string>`,
    `<bool name="Visible">true</bool>`,
    `<int name="ZIndex">${zIndex}</int>`,
    `<int name="BorderSizePixel">0</int>`,
    `<float name="BackgroundTransparency">1</float>`,
    posXml,
    `<UDim2 name="Size"><XS>${sxs}</XS><XO>${sxo}</XO><YS>${sys}</YS><YO>${syo}</YO></UDim2>`,
  ];

  if (isRoot) {
    lines.push(`<Vector2 name="AnchorPoint"><X>0.5</X><Y>0.5</Y></Vector2>`);
  }

  if (sizing.autoSizeToken > 0) {
    lines.push(`<token name="AutomaticSize">${sizing.autoSizeToken}</token>`);
  }

  if (hasImage) {
    lines.push(`<Content name="Image"><url>${assetId}</url></Content>`);
    lines.push(`<token name="ScaleType">0</token>`); // Stretch — pixel-exact PNG
  }

  if (isRoot) {
    lines.push(`<token name="ZIndexBehavior">1</token>`); // Sibling
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
  dynamicPrefix: string,
  zIndex: number,
  parentHasAutoLayout: boolean = false,
): string {
  const ref = nextRef();
  const ts = node.textStyle;
  const name = node.name.startsWith(dynamicPrefix)
    ? node.name
    : `${dynamicPrefix}${node.name}`;

  const fontFamily = getFontFamily(ts?.fontFamily ?? 'Inter');
  const fontWeight = Math.round((ts?.fontWeight ?? 400) / 100) * 100;
  const textColor = node.fills?.find(f => f.visible && f.type === 'SOLID')?.color
    ?? { r: 1, g: 1, b: 1, a: 1 };

  const hAlignMap: Record<string, number> = { LEFT: 0, RIGHT: 1, CENTER: 2, JUSTIFIED: 0 };
  const vAlignMap: Record<string, number> = { TOP: 0, CENTER: 1, BOTTOM: 2 };

  // Position: auto-layout child → skip (UIListLayout manages), else → parent-relative
  const posXml = parentHasAutoLayout
    ? `<UDim2 name="Position"><XS>0</XS><XO>0</XO><YS>0</YS><YO>0</YO></UDim2>`
    : `<UDim2 name="Position"><XS>0</XS><XO>${Math.round(node.x)}</XO><YS>0</YS><YO>${Math.round(node.y)}</YO></UDim2>`;

  const lines: string[] = [
    `<Item class="TextLabel" referent="${ref}">`,
    `<Properties>`,
    `<string name="Name">${escapeXmlAttr(name)}</string>`,
    `<bool name="Visible">true</bool>`,
    `<int name="ZIndex">${zIndex}</int>`,
    `<int name="BorderSizePixel">0</int>`,
    `<float name="BackgroundTransparency">1</float>`,
    posXml,
    `<UDim2 name="Size"><XS>0</XS><XO>${Math.round(node.width)}</XO><YS>0</YS><YO>${Math.round(node.height)}</YO></UDim2>`,
    `<string name="Text">${escapeXmlAttr(node.characters ?? '')}</string>`,
    `<float name="TextSize">${ts?.fontSize ?? 14}</float>`,
    colorXml('TextColor3', textColor),
    `<Font name="FontFace"><Family><url>${fontFamily}</url></Family><Weight>${fontWeight}</Weight><Style>Normal</Style></Font>`,
    `<token name="TextXAlignment">${hAlignMap[ts?.textAlignHorizontal ?? 'LEFT'] ?? 0}</token>`,
    `<token name="TextYAlignment">${vAlignMap[ts?.textAlignVertical ?? 'TOP'] ?? 0}</token>`,
    `<bool name="TextWrapped">false</bool>`,
  ];

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
  dynamicPrefix: string,
  zIndex: number,
  isRoot: boolean,
  parentHasAutoLayout: boolean = false,
): string {
  const ref = nextRef();
  const isScroll = isScrollContainer(node);
  const className = isScroll ? 'ScrollingFrame' : 'Frame';
  const sizing = mapLayoutSizing(node.layoutSizingHorizontal, node.layoutSizingVertical);
  const sxs = sizing.sizeXScale;
  const sys = sizing.sizeYScale;
  const sxo = sxs > 0 ? 0 : Math.round(node.width);
  const syo = sys > 0 ? 0 : Math.round(node.height);

  // Position: root → screen center, auto-layout child → skip, else → parent-relative
  let posXml: string;
  if (isRoot) {
    posXml = `<UDim2 name="Position"><XS>0.5</XS><XO>0</XO><YS>0.5</YS><YO>0</YO></UDim2>`;
  } else if (parentHasAutoLayout) {
    posXml = `<UDim2 name="Position"><XS>0</XS><XO>0</XO><YS>0</YS><YO>0</YO></UDim2>`;
  } else {
    posXml = `<UDim2 name="Position"><XS>0</XS><XO>${Math.round(node.x)}</XO><YS>0</YS><YO>${Math.round(node.y)}</YO></UDim2>`;
  }

  const lines: string[] = [
    `<Item class="${className}" referent="${ref}">`,
    `<Properties>`,
    `<string name="Name">${escapeXmlAttr(node.name)}</string>`,
    `<bool name="Visible">true</bool>`,
    `<int name="ZIndex">${zIndex}</int>`,
    `<int name="BorderSizePixel">0</int>`,
    `<float name="BackgroundTransparency">1</float>`,
    posXml,
    `<UDim2 name="Size"><XS>${sxs}</XS><XO>${sxo}</XO><YS>${sys}</YS><YO>${syo}</YO></UDim2>`,
  ];

  if (isRoot) {
    lines.push(`<Vector2 name="AnchorPoint"><X>0.5</X><Y>0.5</Y></Vector2>`);
    // Respect Figma's clipsContent — some modals intentionally overflow (e.g. close button, title bar)
    lines.push(`<bool name="ClipsDescendants">${!!node.clipsContent}</bool>`);
  }

  if (sizing.autoSizeToken > 0) {
    lines.push(`<token name="AutomaticSize">${sizing.autoSizeToken}</token>`);
  }

  if (node.clipsContent && !isScroll) {
    lines.push(`<bool name="ClipsDescendants">true</bool>`);
  }

  if (isRoot) {
    lines.push(`<token name="ZIndexBehavior">1</token>`);
  }

  // ScrollingFrame properties
  if (isScroll) {
    const canvasSize = computeCanvasSize(node);
    lines.push(`<Vector2 name="CanvasSize"><X>${Math.round(canvasSize.width)}</X><Y>${Math.round(canvasSize.height)}</Y></Vector2>`);
    lines.push(`<token name="ScrollBarThickness">4</token>`);
    lines.push(`<bool name="ScrollingEnabled">true</bool>`);
  }

  lines.push(`</Properties>`);

  // ── Auto-layout children (UIListLayout + UIPadding) ──
  const al = mapAutoLayout(node);
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
  const thisHasAutoLayout = !!(node.autoLayout && node.autoLayout.mode && node.autoLayout.mode !== 'NONE');
  if (node.children) {
    node.children.forEach((child, i) => {
      lines.push(emitNode(child, dynamicPrefix, i + 1, false, thisHasAutoLayout));
    });
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
 * @param dynamicPrefix - Prefix for identifying dynamic text nodes (default: '$')
 * @returns Complete .rbxmx XML string
 */
export function assembleRbxmx(
  manifest: FigmaForgeManifest,
  dynamicPrefix: string = '$',
): string {
  refCounter = 0;
  const body = emitNode(manifest.root, dynamicPrefix, 1, true);
  const screenGuiRef = nextRef();
  const screenGuiName = manifest.root.name || 'FigmaForgeUI';

  const screenGui = `<Item class="ScreenGui" referent="${screenGuiRef}"><Properties>` +
    `<string name="Name">${escapeXmlAttr(screenGuiName)}</string>` +
    `<bool name="IgnoreGuiInset">true</bool>` +
    `<bool name="ResetOnSpawn">false</bool>` +
    `<token name="ZIndexBehavior">1</token>` +
    `<bool name="Enabled">true</bool>` +
    `</Properties>${body}</Item>`;

  return `<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">${screenGui}</roblox>`;
}
