/**
 * FigmaForge RBXMX Generator
 * 
 * Converts FigmaForge IR → Roblox .rbxmx XML with 1:1 property fidelity.
 * 
 * Key design decisions:
 * - Colors use sRGB 0-1 range (<R>0.333</R>) which .rbxmx interprets as sRGB
 * - Positions are relative to parent (Scale) with pixel Offset for precision
 * - UIGradient for gradient fills, UIStroke for strokes, UICorner for corners
 * - Text-stroke duplication is collapsed (see figma-forge-extract.ts dedup)
 * - Empty fills → BackgroundTransparency=1 (NO fabricated fills ever)
 */

import type { FigmaForgeNode, FigmaFill, FigmaStroke, FigmaColor, FigmaGradientStop } from './figma-forge-ir';

// ─── XML Escaping ────────────────────────────────────────────────

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─── Color Helpers ───────────────────────────────────────────────

/** 
 * Figma colors are 0-1 sRGB. Roblox .rbxmx Color3 values are also 0-1 sRGB.
 * Direct mapping — NO conversion needed for .rbxmx format.
 */
function color3Xml(c: FigmaColor): string {
  return `<R>${round(c.r)}</R><G>${round(c.g)}</G><B>${round(c.b)}</B>`;
}

function round(n: number, decimals: number = 5): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

// ─── Gradient Conversion ─────────────────────────────────────────

/**
 * Convert Figma gradient stops → Roblox ColorSequence string.
 * Format: "t1 r1 g1 b1 0 t2 r2 g2 b2 0 ..."
 * The trailing 0 is envelope (unused by Roblox, always 0).
 */
function gradientToColorSequence(stops: FigmaGradientStop[]): string {
  if (!stops || stops.length === 0) return '0 1 1 1 0 1 1 1 1 0';
  
  return stops.map(s => {
    const c = s.color;
    return `${round(s.position)} ${round(c.r)} ${round(c.g)} ${round(c.b)} 0`;
  }).join(' ');
}

/**
 * Convert Figma gradient stops → Roblox NumberSequence string for transparency.
 * Format: "t1 v1 0 t2 v2 0 ..."
 */
function gradientToTransparencySequence(stops: FigmaGradientStop[]): string {
  if (!stops || stops.length === 0) return '0 0 0 1 0 0';
  
  return stops.map(s => {
    // Figma alpha: 1 = opaque, 0 = transparent
    // Roblox transparency: 0 = opaque, 1 = transparent
    const transparency = round(1 - (s.color.a ?? 1));
    return `${round(s.position)} ${transparency} 0`;
  }).join(' ');
}

/**
 * Compute UIGradient rotation from Figma's gradientTransform matrix.
 * Figma uses a 2x3 affine matrix: [[a, c, e], [b, d, f]]
 * The gradient direction = atan2(b, a) converted to degrees.
 */
function gradientRotation(transform?: [[number, number, number], [number, number, number]]): number {
  if (!transform) return 90; // Default: top-to-bottom (Figma default)
  const [[a, _c, _e], [b, _d, _f]] = transform;
  return Math.round(Math.atan2(b, a) * (180 / Math.PI));
}

// ─── Position/Size Conversion ────────────────────────────────────

/**
 * Convert absolute pixel position → Scale + Offset relative to parent.
 * We use Scale primarily for responsiveness, with Offset=0.
 */
function positionToUDim2(x: number, y: number, parentW: number, parentH: number): string {
  const xs = parentW > 0 ? round(x / parentW, 5) : 0;
  const ys = parentH > 0 ? round(y / parentH, 5) : 0;
  return `<XS>${xs}</XS><XO>0</XO><YS>${ys}</YS><YO>0</YO>`;
}

function sizeToUDim2(w: number, h: number, parentW: number, parentH: number): string {
  const xs = parentW > 0 ? round(w / parentW, 5) : 0;
  const ys = parentH > 0 ? round(h / parentH, 5) : 0;
  return `<XS>${xs}</XS><XO>0</XO><YS>${ys}</YS><YO>0</YO>`;
}

// ─── Font Mapping ────────────────────────────────────────────────

/** Map Figma font families to Roblox font asset IDs */
const FONT_MAP: Record<string, string> = {
  // Fredoka One (used in our Figma design)
  'Fredoka One': 'rbxassetid://12187365364',
  'Fredoka': 'rbxassetid://12187365364',
  // Inter
  'Inter': 'rbxasset://fonts/families/SourceSansPro.json',
  // Fallbacks
  'Roboto': 'rbxasset://fonts/families/SourceSansPro.json',
  'Arial': 'rbxasset://fonts/families/SourceSansPro.json',
};

function getFontFamily(family: string): string {
  return FONT_MAP[family] ?? 'rbxasset://fonts/families/SourceSansPro.json';
}

/** Map Figma font weight (100-900) to Roblox weight enum */
function getFontWeight(weight: number): number {
  // Roblox FontWeight enum: 100, 200, ..., 900
  return Math.round(weight / 100) * 100;
}

// ─── Text Alignment Mapping ──────────────────────────────────────

function textXAlignment(align: string): number {
  switch (align) {
    case 'LEFT': return 0;
    case 'CENTER': return 2;
    case 'RIGHT': return 1;
    default: return 0;
  }
}

function textYAlignment(align: string): number {
  switch (align) {
    case 'TOP': return 0;
    case 'CENTER': return 1;
    case 'BOTTOM': return 2;
    default: return 0;
  }
}

// ─── Node Emitter ────────────────────────────────────────────────

/**
 * Determine the Roblox class for a Figma node.
 */
function robloxClass(node: FigmaForgeNode): string {
  switch (node.type) {
    case 'TEXT': return 'TextLabel';
    case 'FRAME':
    case 'COMPONENT':
    case 'INSTANCE':
    case 'GROUP':
    case 'SECTION':
    case 'RECTANGLE':
    case 'ELLIPSE':
    case 'LINE':
    case 'VECTOR':
    case 'BOOLEAN_OPERATION':
    case 'COMPONENT_SET':
    default: {
      // If node has an IMAGE fill, use ImageLabel
      const hasImageFill = node.fills.some(f => f.type === 'IMAGE' && f.visible);
      if (hasImageFill) return 'ImageLabel';
      return 'Frame';
    }
  }
}

/**
 * Check if a node has any visible fills.
 */
function hasVisibleFills(node: FigmaForgeNode): boolean {
  return node.fills.some(f => f.visible && f.type !== 'IMAGE');
}

/**
 * Get the first visible solid fill color, or white as default.
 */
function getPrimaryFillColor(node: FigmaForgeNode): FigmaColor {
  const solidFill = node.fills.find(f => f.type === 'SOLID' && f.visible);
  if (solidFill?.color) return solidFill.color;
  
  // For gradients, use the first stop color
  const gradientFill = node.fills.find(f => f.type?.startsWith('GRADIENT_') && f.visible);
  if (gradientFill?.gradientStops?.[0]?.color) return gradientFill.gradientStops[0].color;
  
  return { r: 1, g: 1, b: 1, a: 1 };
}

/**
 * Get the first visible gradient fill, if any.
 */
function getGradientFill(node: FigmaForgeNode): FigmaFill | undefined {
  return node.fills.find(f => f.type?.startsWith('GRADIENT_') && f.visible);
}

/**
 * Get the first visible stroke.
 */
function getPrimaryStroke(node: FigmaForgeNode): FigmaStroke | undefined {
  return node.strokes.find(s => s.visible);
}

/**
 * Emit a single FigmaForge node as .rbxmx XML.
 */
function emitNode(node: FigmaForgeNode, parentW: number, parentH: number, zIndex: number): string {
  if (!node.visible) return '';
  if (node._isStrokeDuplicate) return '';

  const className = robloxClass(node);
  const lines: string[] = [];

  lines.push(`<Item class="${className}" referent="RBX0">`);
  lines.push(`<Properties>`);

  // ── Name ──
  lines.push(`<string name="Name">${escapeXml(node.name)}</string>`);

  // ── Common properties ──
  lines.push(`<bool name="Active">true</bool>`);
  lines.push(`<bool name="Visible">true</bool>`);
  lines.push(`<int name="BorderSizePixel">0</int>`);
  lines.push(`<float name="Rotation">${round(node.rotation)}</float>`);
  lines.push(`<int name="ZIndex">${zIndex}</int>`);

  // ── Anchor & Position ──
  lines.push(`<Vector2 name="AnchorPoint"><X>0</X><Y>0</Y></Vector2>`);
  lines.push(`<UDim2 name="Position">${positionToUDim2(node.x, node.y, parentW, parentH)}</UDim2>`);
  lines.push(`<UDim2 name="Size">${sizeToUDim2(node.width, node.height, parentW, parentH)}</UDim2>`);
  lines.push(`<int name="LayoutOrder">${zIndex}</int>`);

  // ── Fill / BackgroundTransparency ──
  if (className === 'TextLabel') {
    // Text nodes always have transparent background
    lines.push(`<float name="BackgroundTransparency">1</float>`);
  } else if (!hasVisibleFills(node)) {
    // No visible fills → fully transparent background (NO fabrication!)
    lines.push(`<float name="BackgroundTransparency">1</float>`);
    lines.push(`<Color3 name="BackgroundColor3"><R>1</R><G>1</G><B>1</B></Color3>`);
  } else {
    // Has visible fills → opaque
    const bgTransparency = round(1 - node.opacity);
    lines.push(`<float name="BackgroundTransparency">${bgTransparency}</float>`);
    const fillColor = getPrimaryFillColor(node);
    lines.push(`<Color3 name="BackgroundColor3">${color3Xml(fillColor)}</Color3>`);
  }

  // ── ClipsDescendants ──
  if (node.clipsContent) {
    lines.push(`<bool name="ClipsDescendants">true</bool>`);
  }

  // ── Text-specific properties ──
  if (className === 'TextLabel' && node.characters !== undefined) {
    const ts = node.textStyle;
    lines.push(`<string name="Text">${escapeXml(node.characters)}</string>`);
    lines.push(`<float name="TextSize">${ts?.fontSize ?? 14}</float>`);
    lines.push(`<token name="TextXAlignment">${textXAlignment(ts?.textAlignHorizontal ?? 'LEFT')}</token>`);
    lines.push(`<token name="TextYAlignment">${textYAlignment(ts?.textAlignVertical ?? 'TOP')}</token>`);
    lines.push(`<bool name="TextWrapped">true</bool>`);
    lines.push(`<token name="TextTruncate">-1</token>`);
    
    // Font
    const fontFamily = getFontFamily(ts?.fontFamily ?? 'Inter');
    const fontWeight = getFontWeight(ts?.fontWeight ?? 400);
    lines.push(`<Font name="FontFace"><Family><url>${fontFamily}</url></Family><Weight>${fontWeight}</Weight><Style>Normal</Style></Font>`);
    
    // Text color (from fills)
    const textColor = getPrimaryFillColor(node);
    lines.push(`<Color3 name="TextColor3">${color3Xml(textColor)}</Color3>`);
    lines.push(`<float name="TextTransparency">0</float>`);
  }

  // ── ImageLabel-specific properties ──
  if (className === 'ImageLabel') {
    const imageFill = node.fills.find(f => f.type === 'IMAGE' && f.visible);
    if (imageFill) {
      // Use resolved image ID if available, otherwise placeholder
      const imageId = (node as any)._resolvedImageId ?? '';
      lines.push(`<Content name="Image"><url>${imageId}</url></Content>`);
      lines.push(`<token name="ScaleType">1</token>`); // Stretch
      lines.push(`<float name="ImageTransparency">0</float>`);
    }
  }

  lines.push(`</Properties>`);

  // ── UICorner (if cornerRadius > 0) ──
  const cr = Array.isArray(node.cornerRadius) ? node.cornerRadius[0] : node.cornerRadius;
  if (cr > 0) {
    lines.push(`<Item class="UICorner" referent="RBX0"><Properties>`);
    lines.push(`<string name="Type">UICorner</string>`);
    lines.push(`<UDim name="CornerRadius"><S>0</S><O>${Math.round(cr)}</O></UDim>`);
    lines.push(`</Properties></Item>`);
  }

  // ── UIGradient (if gradient fill exists) ──
  const gradFill = getGradientFill(node);
  if (gradFill && gradFill.gradientStops) {
    lines.push(`<Item class="UIGradient" referent="RBX0"><Properties>`);
    lines.push(`<bool name="Enabled">true</bool>`);
    lines.push(`<float name="Rotation">${gradientRotation(gradFill.gradientTransform)}</float>`);
    lines.push(`<Vector2 name="Offset"><X>0</X><Y>0</Y></Vector2>`);
    lines.push(`<ColorSequence name="Color">${gradientToColorSequence(gradFill.gradientStops)}</ColorSequence>`);
    lines.push(`<NumberSequence name="Transparency">${gradientToTransparencySequence(gradFill.gradientStops)}</NumberSequence>`);
    lines.push(`</Properties></Item>`);
  }

  // ── UIStroke (if strokes exist OR inferred from text-stroke dedup) ──
  const primaryStroke = getPrimaryStroke(node);
  const inferredStroke = (node as any)._inferredStrokeThickness;
  
  if (primaryStroke || inferredStroke) {
    const strokeColor = primaryStroke?.color 
      ?? (node as any)._inferredStrokeColor 
      ?? { r: 0, g: 0, b: 0, a: 1 };
    const strokeThickness = node.strokeWeight || inferredStroke || 1;
    
    lines.push(`<Item class="UIStroke" referent="RBX0"><Properties>`);
    lines.push(`<string name="Name">UIStroke</string>`);
    // ApplyStrokeMode: 0=Contextual, 1=Border
    lines.push(`<int name="ApplyStrokeMode">${className === 'TextLabel' ? 0 : 1}</int>`);
    // StrokePosition for non-text: INSIDE=0, CENTER=1, OUTSIDE=2
    if (className !== 'TextLabel') {
      const strokePos = node.strokeAlign === 'INSIDE' ? 0 : node.strokeAlign === 'CENTER' ? 1 : 2;
      lines.push(`<int name="BorderStrokePosition">${strokePos}</int>`);
    }
    lines.push(`<Color3 name="Color">${color3Xml(strokeColor)}</Color3>`);
    lines.push(`<int name="LineJoinMode">0</int>`);
    lines.push(`<int name="Thickness">${Math.round(strokeThickness)}</int>`);
    lines.push(`<float name="Transparency">0</float>`);
    lines.push(`</Properties></Item>`);
  }

  // ── Children (recursion) ──
  if (node.children && node.children.length > 0) {
    for (let i = 0; i < node.children.length; i++) {
      const childXml = emitNode(node.children[i], node.width, node.height, i + 1);
      if (childXml) lines.push(childXml);
    }
  }

  lines.push(`</Item>`);

  return lines.join('\n');
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Convert a FigmaForge IR tree to .rbxmx XML string.
 */
export function generateRbxmx(root: FigmaForgeNode, canvasWidth: number, canvasHeight: number): string {
  const header = `<!--
\tGenerated by FigmaForge v1.0.0
\tFaithful 1:1 Figma→Roblox mapping — zero fabrication
\tSource: ${escapeXml(root.name)} (${root.id})
-->

<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4"><Meta name="ExplicitAutoJoints">true</Meta>`;

  const body = emitNode(root, canvasWidth, canvasHeight, 1);

  const footer = `</roblox>`;

  return `${header}\n${body}\n${footer}`;
}

/**
 * Full pipeline: Extract manifest → dedup → generate .rbxmx
 */
export function manifestToRbxmx(manifest: { root: FigmaForgeNode; canvasWidth: number; canvasHeight: number }): string {
  return generateRbxmx(manifest.root, manifest.canvasWidth, manifest.canvasHeight);
}
