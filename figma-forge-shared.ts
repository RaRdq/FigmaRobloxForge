/**
 * FigmaForge Shared Constants & Helpers
 * 
 * Single Source of Truth for values and logic used by both Luau and RBXMX generators.
 * Import from here instead of duplicating across generators.
 */

import type { FigmaForgeNode, FigmaFill, FigmaStroke, FigmaColor, FigmaGradientStop } from './figma-forge-ir';

// ─── Constants ───────────────────────────────────────────────────

/** ZIndex for inner shadow overlay frames — sits behind child content (which starts at 2) */
export const INNER_SHADOW_ZINDEX = 1;

// ─── Math ────────────────────────────────────────────────────────

export function round(n: number, decimals: number = 5): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

// ─── String Escaping ─────────────────────────────────────────────

/** Escape a string for safe embedding in Lua string literals (double-quoted) */
export function luaEscape(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
}

/** Escape a string for safe embedding in XML attribute values */
export function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Font Mapping (SSOT) ─────────────────────────────────────────

/** Map Figma font families to Roblox font asset paths */
export const FONT_MAP: Record<string, string> = {
  // ─── Exact matches (Roblox has these natively) ──────────
  'Fredoka One': 'rbxassetid://12187365364',
  'Fredoka': 'rbxassetid://12187365364',

  // ─── Inter → BuilderSans (closest Roblox equivalent, geometric sans, full weight range) ──
  'Inter': 'rbxasset://fonts/families/BuilderSans.json',

  // ─── Sans-serif mappings ────────────────────────────────
  'Roboto': 'rbxasset://fonts/families/BuilderSans.json',
  'Open Sans': 'rbxasset://fonts/families/SourceSansPro.json',
  'Lato': 'rbxasset://fonts/families/SourceSansPro.json',
  'Arial': 'rbxasset://fonts/families/SourceSansPro.json',
  'Helvetica': 'rbxasset://fonts/families/SourceSansPro.json',
  'DM Sans': 'rbxasset://fonts/families/BuilderSans.json',
  'Work Sans': 'rbxasset://fonts/families/BuilderSans.json',
  'Outfit': 'rbxasset://fonts/families/BuilderSans.json',

  // ─── Display / rounded mappings ─────────────────────────
  'Poppins': 'rbxasset://fonts/families/GothamSSm.json',
  'Montserrat': 'rbxasset://fonts/families/GothamSSm.json',
  'Nunito': 'rbxasset://fonts/families/GothamSSm.json',
  'Raleway': 'rbxasset://fonts/families/GothamSSm.json',
  'Quicksand': 'rbxasset://fonts/families/GothamSSm.json',

  // ─── Game / display fonts ───────────────────────────────
  'Bangers': 'rbxasset://fonts/families/Bangers.json',
  'Bungee': 'rbxasset://fonts/families/PressStart2P.json',
  'Comic Neue': 'rbxasset://fonts/families/ComicNeueAngular.json',
  'Luckiest Guy': 'rbxasset://fonts/families/LuckiestGuy.json',
  'Permanent Marker': 'rbxasset://fonts/families/IndieFlower.json',
  'Titan One': 'rbxasset://fonts/families/Bangers.json',
  'Boogaloo': 'rbxasset://fonts/families/Bangers.json',
  'Lilita One': 'rbxasset://fonts/families/Bangers.json',
  'Creepster': 'rbxasset://fonts/families/Creepster.json',
  'Special Elite': 'rbxasset://fonts/families/SpecialElite.json',

  // ─── Serif mappings ─────────────────────────────────────
  'Georgia': 'rbxasset://fonts/families/Merriweather.json',
  'Times New Roman': 'rbxasset://fonts/families/Merriweather.json',
  'Playfair Display': 'rbxasset://fonts/families/Merriweather.json',

  // ─── Monospace ──────────────────────────────────────────
  'Fira Code': 'rbxasset://fonts/families/RobotoMono.json',
  'JetBrains Mono': 'rbxasset://fonts/families/RobotoMono.json',
  'Source Code Pro': 'rbxasset://fonts/families/RobotoMono.json',
  'Courier New': 'rbxasset://fonts/families/RobotoMono.json',
};

const DEFAULT_FONT = 'rbxasset://fonts/families/BuilderSans.json';

/** Tracks unmapped fonts to warn only once per font family */
const _warnedFonts = new Set<string>();

export function getFontFamily(family: string): string {
  const mapped = FONT_MAP[family];
  if (mapped) return mapped;
  // Warn once per unmapped font family
  if (!_warnedFonts.has(family)) {
    _warnedFonts.add(family);
    console.warn(`[FigmaForge] ⚠ Font "${family}" not in font map — falling back to BuilderSans`);
  }
  return DEFAULT_FONT;
}

// ─── Node Classification ─────────────────────────────────────────

/**
 * Determine if a node should become a ScrollingFrame in Roblox.
 * Heuristic: a non-leaf frame with clipsContent AND children that overflow its bounds.
 */
export function isScrollContainer(node: FigmaForgeNode): boolean {
  if (!node.clipsContent) return false;
  if (!node.children || node.children.length === 0) return false;
  // Calculate children bounding box
  let maxChildBottom = 0;
  let maxChildRight = 0;
  for (const child of node.children) {
    if (!child.visible) continue;
    maxChildBottom = Math.max(maxChildBottom, child.y + child.height);
    maxChildRight = Math.max(maxChildRight, child.x + child.width);
  }
  // If children overflow the frame by more than a small tolerance (2px for rounding), it scrolls
  const overflowY = maxChildBottom > node.height + 2;
  const overflowX = maxChildRight > node.width + 2;
  return overflowY || overflowX;
}

export function robloxClass(node: FigmaForgeNode): string {
  const hasReactions = node.reactions && node.reactions.length > 0;
  
  if (node.type === 'TEXT') {
    return hasReactions ? 'TextButton' : 'TextLabel';
  }
  
  const hasImageFill = node.fills.some(f => f.type === 'IMAGE' && f.visible);
  const isRasterized = !!node._rasterizedImageHash || !!node._isFlattened || !!node._isHybrid;
  if (hasImageFill || isRasterized) {
    return hasReactions ? 'ImageButton' : 'ImageLabel';
  }
  
  if (isScrollContainer(node)) return 'ScrollingFrame';
  
  return hasReactions ? 'ImageButton' : 'Frame';
}

/**
 * Compute the required CanvasSize for a ScrollingFrame.
 * Returns the bounding box of all visible children.
 */
export function computeCanvasSize(node: FigmaForgeNode): { width: number; height: number } {
  let maxBottom = 0;
  let maxRight = 0;
  for (const child of node.children) {
    if (!child.visible) continue;
    maxBottom = Math.max(maxBottom, child.y + child.height);
    maxRight = Math.max(maxRight, child.x + child.width);
  }
  return { width: Math.ceil(maxRight), height: Math.ceil(maxBottom) };
}

export function isEllipse(node: FigmaForgeNode): boolean {
  return node.type === 'ELLIPSE';
}

// ─── Fill Queries ────────────────────────────────────────────────

export function hasVisibleFills(node: FigmaForgeNode): boolean {
  return node.fills.some(f => f.visible && f.type !== 'IMAGE');
}

export function getPrimaryFillColor(node: FigmaForgeNode): FigmaColor {
  // Any gradient fill → return white so UIGradient colors render at full fidelity.
  // Without this, Roblox multiplies BackgroundColor3 × UIGradient → double-tinted/pastel.
  const gradFill = node.fills.find(f => f.type?.startsWith('GRADIENT_') && f.visible);
  if (gradFill) return { r: 1, g: 1, b: 1, a: 1 };

  const solidFill = node.fills.find(f => f.type === 'SOLID' && f.visible);
  if (solidFill?.color) return solidFill.color;

  return { r: 1, g: 1, b: 1, a: 1 };
}

export function getGradientFill(node: FigmaForgeNode): FigmaFill | undefined {
  return node.fills.find(f => f.type?.startsWith('GRADIENT_') && f.visible);
}

export function getPrimaryStroke(node: FigmaForgeNode): FigmaStroke | undefined {
  return node.strokes.find(s => s.visible);
}

// ─── Opacity Composition ─────────────────────────────────────────

/**
 * Compute BackgroundTransparency from Figma fill-level opacity × node opacity.
 * This is the canonical logic — both generators MUST use this.
 * 
 * Figma: fill.opacity (0-1) controls per-fill opacity, node.opacity (0-1) controls the whole node.
 * Roblox: BackgroundTransparency = 1 - (fill.opacity * node.opacity)
 */
export function computeBackgroundTransparency(node: FigmaForgeNode): number {
  const primaryFill = node.fills.find(f => f.visible && f.type !== 'IMAGE');
  const fillOpacity = (primaryFill?.opacity ?? 1) * node.opacity;
  return round(1 - fillOpacity);
}

// ─── Corner Radius ───────────────────────────────────────────────

/**
 * Get the effective corner radius for a node.
 * ELLIPSE nodes are inherently circular — they have cornerRadius: 0 in the IR
 * because Figma doesn't expose cornerRadius on ELLIPSE nodes.
 * Returns { isFullCircle, radiusPx } to let generators emit the right UICorner.
 */
export function getEffectiveCornerRadius(node: FigmaForgeNode): { isFullCircle: boolean; radiusPx: number } {
  if (isEllipse(node)) {
    return { isFullCircle: true, radiusPx: 0 };
  }
  if (Array.isArray(node.cornerRadius)) {
    const [tl, tr, br, bl] = node.cornerRadius;
    const allSame = tl === tr && tr === br && br === bl;
    if (!allSame) {
      console.warn(
        `[FigmaForge] ⚠ Node "${node.name}" (${node.id}) has per-corner radius [${tl},${tr},${br},${bl}]. ` +
        `Roblox UICorner only supports uniform radius — using max(${Math.max(tl, tr, br, bl)}px).`
      );
    }
    return { isFullCircle: false, radiusPx: Math.max(tl, tr, br, bl) };
  }
  return { isFullCircle: false, radiusPx: node.cornerRadius };
}

// ─── Gradient Transform ──────────────────────────────────────────

export function gradientRotation(transform?: [[number, number, number], [number, number, number]]): number {
  if (!transform) return 90; // Default: top-to-bottom (Figma default)
  const [[a, _c, _e], [b, _d, _f]] = transform;
  return Math.round(Math.atan2(b, a) * (180 / Math.PI));
}

// ─── Auto Layout Mapping ─────────────────────────────────────────

export type RobloxFillDirection = 'Horizontal' | 'Vertical';
export type RobloxHAlign = 'Left' | 'Center' | 'Right';
export type RobloxVAlign = 'Top' | 'Center' | 'Bottom';

export interface AutoLayoutMapping {
  fillDirection: RobloxFillDirection;
  padding: number;
  horizontalAlignment: RobloxHAlign;
  verticalAlignment: RobloxVAlign;
  wraps: boolean;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
}

/**
 * Map Figma AutoLayout → Roblox UIListLayout + UIPadding properties.
 * Returns null if node has no autoLayout.
 */
export function mapAutoLayout(node: FigmaForgeNode): AutoLayoutMapping | null {
  const al = node.autoLayout;
  if (!al) return null;

  const fillDirection: RobloxFillDirection = al.mode === 'HORIZONTAL' ? 'Horizontal' : 'Vertical';

  // Primary axis alignment → sort direction anchor
  let horizontalAlignment: RobloxHAlign = 'Left';
  let verticalAlignment: RobloxVAlign = 'Top';

  if (al.mode === 'HORIZONTAL') {
    switch (al.primaryAxisAlignItems) {
      case 'MIN': horizontalAlignment = 'Left'; break;
      case 'CENTER': horizontalAlignment = 'Center'; break;
      case 'MAX': horizontalAlignment = 'Right'; break;
      case 'SPACE_BETWEEN': 
        horizontalAlignment = 'Left'; 
        // HACK: Figma SPACE_BETWEEN has no direct UIListLayout equivalent.
        // In Fusion we can use Flexboxes, in rbxmx we'll just align left for now.
        break; 
    }
    switch (al.counterAxisAlignItems) {
      case 'MIN': verticalAlignment = 'Top'; break;
      case 'CENTER': verticalAlignment = 'Center'; break;
      case 'MAX': verticalAlignment = 'Bottom'; break;
    }
  } else {
    // VERTICAL layout
    switch (al.primaryAxisAlignItems) {
      case 'MIN': verticalAlignment = 'Top'; break;
      case 'CENTER': verticalAlignment = 'Center'; break;
      case 'MAX': verticalAlignment = 'Bottom'; break;
      case 'SPACE_BETWEEN': 
        verticalAlignment = 'Top'; 
        break;
    }
    switch (al.counterAxisAlignItems) {
      case 'MIN': horizontalAlignment = 'Left'; break;
      case 'CENTER': horizontalAlignment = 'Center'; break;
      case 'MAX': horizontalAlignment = 'Right'; break;
    }
  }

  return {
    fillDirection,
    padding: Math.round(al.itemSpacing),
    horizontalAlignment,
    verticalAlignment,
    wraps: al.layoutWrap === 'WRAP',
    paddingTop: Math.round(al.paddingTop),
    paddingRight: Math.round(al.paddingRight),
    paddingBottom: Math.round(al.paddingBottom),
    paddingLeft: Math.round(al.paddingLeft),
  };
}

// ─── ScaleType Mapping ───────────────────────────────────────────

/**
 * Map Figma imageFill scaleMode → Roblox ScaleType enum token.
 * Roblox enum: 0=Stretch, 1=Slice, 2=Tile, 3=Fit, 4=Crop
 * Figma modes: FILL (zoom-to-cover), FIT (contain), CROP (manual), TILE (repeat)
 */
export function mapScaleType(scaleMode?: string): { enumToken: number; enumName: string } {
  switch (scaleMode) {
    case 'FIT':  return { enumToken: 3, enumName: 'Fit' };
    case 'FILL': return { enumToken: 4, enumName: 'Crop' };  // Figma FILL ≈ Roblox Crop (cover)
    case 'CROP': return { enumToken: 4, enumName: 'Crop' };
    case 'TILE': return { enumToken: 2, enumName: 'Tile' };
    default:     return { enumToken: 0, enumName: 'Stretch' };
  }
}

// ─── TextAutoResize → AutomaticSize ──────────────────────────────

/**
 * Map Figma textAutoResize → Roblox AutomaticSize + TextWrapped
 * Roblox AutomaticSize enum: 0=None, 1=X, 2=Y, 3=XY
 */
export function mapTextAutoResize(textAutoResize?: string): {
  automaticSizeToken: number;
  automaticSizeName: string;
  textWrapped: boolean;
} {
  switch (textAutoResize) {
    case 'WIDTH_AND_HEIGHT':
      return { automaticSizeToken: 3, automaticSizeName: 'XY', textWrapped: false };
    case 'HEIGHT':
      return { automaticSizeToken: 2, automaticSizeName: 'Y', textWrapped: true };
    case 'TRUNCATE':
      return { automaticSizeToken: 0, automaticSizeName: 'None', textWrapped: true };
    case 'NONE':
    default:
      return { automaticSizeToken: 0, automaticSizeName: 'None', textWrapped: true };
  }
}

// ─── GroupTransparency ───────────────────────────────────────────

/**
 * Returns whether a node needs GroupTransparency set.
 * When a Figma node has opacity < 1 AND has children, the opacity should
 * affect the entire group uniformly — Roblox's GroupTransparency handles this.
 */
export function needsGroupTransparency(node: FigmaForgeNode): boolean {
  return node.opacity < 1 && node.children && node.children.length > 0;
}

// ─── LineHeight Mapping (C8) ─────────────────────────────────────

/**
 * Map Figma lineHeight to Roblox LineHeight (UITextSizeConstraint-ish).
 * Roblox TextLabel doesn't have a direct LineHeight property, but we can
 * approximate with RichText `<br/>` spacing or use it for documentation.
 * 
 * Returns the ratio of lineHeight/fontSize. If AUTO, returns null.
 * Roblox's closest equivalent: set TextLabel height to accommodate lineHeight.
 */
export function mapLineHeight(lineHeight: number | 'AUTO', fontSize: number): number | null {
  if (lineHeight === 'AUTO' || !lineHeight) return null;
  const ratio = lineHeight / fontSize;
  // Only meaningful if ratio differs significantly from default (~1.2)
  if (Math.abs(ratio - 1.2) < 0.05) return null;
  return round(ratio, 2);
}

// ─── Gradient Offset (E6) ────────────────────────────────────────

/**
 * Extract gradient translation offset from Figma gradient transform matrix.
 * 
 * Figma uses a 2×3 affine matrix [[a, c, e], [b, d, f]] where:
 * - [a,b] and [c,d] encode rotation/scale
 * - [e,f] encode translation (0..1 range, relative to node size)
 * 
 * Roblox UIGradient.Offset is Vector2 in -1..1 range, centered at (0,0).
 * Figma's gradient space is 0..1 centered at (0.5, 0.5).
 */
export function gradientOffset(transform?: [[number, number, number], [number, number, number]]): { x: number; y: number } | null {
  if (!transform) return null;
  const [[_a, _c, e], [_b, _d, f]] = transform;
  // Convert from Figma 0..1 space (centered at 0.5) to Roblox -1..1 space (centered at 0)
  const ox = round((e - 0.5) * 2, 3);
  const oy = round((f - 0.5) * 2, 3);
  // Skip if near-zero (default center)
  if (Math.abs(ox) < 0.01 && Math.abs(oy) < 0.01) return null;
  return { x: ox, y: oy };
}

// ─── Layout Sizing (D2: FILL/HUG) ───────────────────────────────

/**
 * Map Figma layoutSizing to Roblox Size + AutomaticSize behavior.
 * 
 * Figma sizing modes:
 * - FIXED: explicit width/height (default)
 * - FILL: expand to fill parent container (Roblox: Size = {1,0},{0,height} for horizontal)
 * - HUG: shrink to fit content (Roblox: AutomaticSize)
 * 
 * Returns size scale hint and AutomaticSize token per axis.
 */
export function mapLayoutSizing(
  horizontal?: string,
  vertical?: string,
): {
  sizeXScale: number;  // 0 = use offset, 1 = fill parent
  sizeYScale: number;
  autoSizeToken: number; // 0=None, 1=X, 2=Y, 3=XY
  autoSizeName: string;
} {
  const isHFill = horizontal === 'FILL';
  const isVFill = vertical === 'FILL';
  const isHHug = horizontal === 'HUG';
  const isVHug = vertical === 'HUG';

  let autoSizeToken = 0;
  if (isHHug && isVHug) autoSizeToken = 3;
  else if (isHHug) autoSizeToken = 1;
  else if (isVHug) autoSizeToken = 2;

  const autoSizeNames = ['None', 'X', 'Y', 'XY'];

  return {
    sizeXScale: isHFill ? 1 : 0,
    sizeYScale: isVFill ? 1 : 0,
    autoSizeToken,
    autoSizeName: autoSizeNames[autoSizeToken],
  };
}
