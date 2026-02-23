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

// ─── Unicode Sanitization ────────────────────────────────────────

/**
 * Sanitize text for Roblox font rendering.
 * Roblox fonts don't support many Unicode symbols that Figma designers use.
 * This map converts them to safe ASCII equivalents.
 */
const UNICODE_REPLACEMENTS: [RegExp, string][] = [
  // Close buttons / multiplication signs
  [/[✕✖✗✘×]/g, 'X'],
  // Dashes (keep em/en dash as regular hyphen)
  [/[─━]/g, '-'],
  // Vertical lines
  [/[│┃]/g, '|'],
  // Ellipsis
  [/…/g, '...'],
  // Fancy quotes → standard quotes
  [/[""]/g, '"'],
  [/['']/g, "'"],
  // Bullet variants → standard bullet (Roblox supports •)
  [/[◦▪▸▹►▻‣⁃]/g, '•'],
  // Arrows (keep → ← ↑ ↓ as Roblox supports these basic ones)
  [/[⟶⟵⟹⟸➔➜➝➞]/g, '->'],
];

/** Sanitize text content for safe Roblox rendering. Call BEFORE escapeXmlAttr. */
export function sanitizeTextForRoblox(text: string): string {
  let result = text;
  for (const [pattern, replacement] of UNICODE_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ─── Naming Conventions ──────────────────────────────────────────

/** Convention suffixes that FigmaForge recognizes in Figma layer names */
const CONVENTION_SUFFIXES = ['[Template]', '[Flatten]', '[Scroll]', '[Repeat]'];

/** Check if a node name has the [Template] convention suffix */
export function isTemplateNode(name: string): boolean {
  return name.includes('[Template]');
}

/** Check if a node name has the [Scroll] convention suffix */
export function isScrollConvention(name: string): boolean {
  return name.includes('[Scroll]');
}

/** Strip all FigmaForge convention suffixes from a name, returning the clean display name */
export function stripConventionSuffix(name: string): string {
  let clean = name;
  for (const suffix of CONVENTION_SUFFIXES) {
    clean = clean.replace(suffix, '');
  }
  // Also strip any trailing whitespace from removed suffixes
  return clean.trim();
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

/** Reset warning state between files (e.g. batch/watch mode) */
export function clearFontWarnings(): void {
  _warnedFonts.clear();
}

// ─── Node Classification ─────────────────────────────────────────

/**
 * Determine if a node should become a ScrollingFrame in Roblox.
 * 
 * Uses 3 detection methods:
 * 1. Content overflow heuristic (children exceed frame bounds)
 * 2. [Scroll] name convention suffix
 * 3. @scroll annotation in Figma node description
 */
export function isScrollContainer(node: FigmaForgeNode): boolean {
  // Method 1: Figma native scrolling (Prototype > Scroll behavior)
  if (node.overflowDirection && node.overflowDirection !== 'NONE') return true;
  // Method 2: [Scroll] name convention
  if (isScrollConvention(node.name)) return true;
  // Method 3: @scroll in Figma description
  if (node.description && /@scroll\b/i.test(node.description)) return true;
  
  return false;
}

// ─── Configuration Types & Defaults ───────────────────────────────

export interface FigmaForgeConfig {
  dynamicPrefix: string;
  dynamicNamePatterns: string[];
  dynamicTextPatterns: string[];
  interactivePatterns: string[];
  textExportMode: 'all' | 'dynamic' | 'none';
  /** When true, emit UDim2.fromScale() proportional to root frame instead of pixel offsets */
  responsive: boolean;
  /** Design token color map: hex → token name for runtime theming */
  themeTokens: Record<string, string>;
  /** Color matching tolerance for theme tokens (0-255 RGB space, default: 10) */
  themeTokenTolerance: number;
}

export const DEFAULT_CONFIG: FigmaForgeConfig = {
  dynamicPrefix: '$',
  dynamicNamePatterns: [
    '^price', '^unit', '^socket', '^stats', '^timer', '^count',
    '^amount', '^level', '^score', '^currency', '^health',
    '^progress', '^rank', '^value', '^quantity'
  ],
  dynamicTextPatterns: [
    '^\\{.+\\}$',              // {value}, {playerName}
    '^\\$[\\d.,]+[KMBkmb]?$',  // $1,234, $1.2K, $10.5M
    '^[\\d,]+$',               // 1234, 1,000
    '^\\d+:\\d+$',             // 00:00
    '^x[\\d.]+$',              // x3, X10
    '^Level \\d+$',            // Level 5
    '^Lv\\.?\\d+$',            // Lv.42, Lv5
    '^Player ?Name$',          // Player Name
    '^0$',                     // Single zero
    '^\\d+%$',                 // 50%
    '^\\.\\.\\.',              // ...
    '→',                       // Arrow
    '^\\p{Emoji}+$',           // Single emoji
    '^\\?$'                    // Single "?"
  ],
  interactivePatterns: [
    'btn', 'button', 'close', 'submit', 'toggle', 'tab_', 'back', '_tab'
  ],
  textExportMode: 'all',
  responsive: false,
  themeTokens: {},
  themeTokenTolerance: 10,
};

export interface RuntimeConfig extends FigmaForgeConfig {
  _compiledNamePatterns: RegExp[];
  _compiledTextPatterns: RegExp[];
  _compiledInteractivePatterns: RegExp[];
}

export function compileConfig(config: Partial<FigmaForgeConfig>): RuntimeConfig {
  const merged = { ...DEFAULT_CONFIG, ...config };
  return {
    ...merged,
    _compiledNamePatterns: merged.dynamicNamePatterns.map(p => new RegExp(p, 'i')),
    // dynamic text requires unicode support for emoji regex
    _compiledTextPatterns: merged.dynamicTextPatterns.map(p => new RegExp(p, p.includes('Emoji') ? 'iu' : 'i')),
    _compiledInteractivePatterns: merged.interactivePatterns.map(p => new RegExp(p, 'i')),
  };
}

// ─── Dynamic Text Classification ──────────────────────────────────

/** Classify whether a text node contains dynamic (runtime-bound) content.
 *  Uses the compiled RuntimeConfig patterns.
 */
export function isDynamicText(node: FigmaForgeNode, config: RuntimeConfig): boolean {
  if (node.name.startsWith(config.dynamicPrefix)) return true;
  if (config._compiledNamePatterns.some(p => p.test(node.name))) return true;
  const text = (node.characters ?? '').trim();
  if (!text) return false;
  return config._compiledTextPatterns.some(p => p.test(text));
}

/** Check if any descendant of a node contains dynamic text. */
export function hasDescendantDynamicText(node: FigmaForgeNode, config: RuntimeConfig): boolean {
  if (node.type === 'TEXT' && isDynamicText(node, config)) return true;
  if (!node.children) return false;
  return node.children.some(child => hasDescendantDynamicText(child, config));
}

/** Check if any descendant is a TEXT node (any text, not just dynamic).
 *  Used to decide hierarchy preservation — ANY text means "keep children". */
export function hasDescendantText(node: FigmaForgeNode): boolean {
  if (node.type === 'TEXT') return true;
  if (!node.children) return false;
  return node.children.some(child => hasDescendantText(child));
}

/**
 * Generate JavaScript source code for isDynText/hasDescDynamic functions.
 * Used by extract.ts to embed SSOT patterns into Figma sandbox scripts.
 * Returns a JS function block that can be inserted into template literals.
 */
export function generateDynamicTextJS(config: FigmaForgeConfig): string {
  // We need to convert string patterns back to strings that construct regexes in the Figma sandbox
  const nameRegexes = config.dynamicNamePatterns.map(p => `/^${p.replace(/^\^/, '')}/i`).join(', ');
  // Handle unicode flag for emoji pattern
  const textRegexes = config.dynamicTextPatterns.map(p => {
    return `/${p.replace(/^\^/, '^')}/${p.includes('Emoji') ? 'iu' : 'i'}`;
  }).join(', ');

  return `
  var _dynNamePats = [${nameRegexes}];
  var _dynTextPats = [${textRegexes}];

  function isDynText(n) {
    if (n.type !== 'TEXT') return false;
    if (n.name.startsWith('${config.dynamicPrefix}')) return true;
    if (_dynNamePats.some(function(p) { return p.test(n.name); })) return true;
    var text = (n.characters || '').trim();
    if (!text) return false;
    return _dynTextPats.some(function(p) { return p.test(text); });
  }

  function hasDescDynamic(n) {
    if (isDynText(n)) return true;
    if ('children' in n && n.children) {
      for (var di = 0; di < n.children.length; di++) {
        if (hasDescDynamic(n.children[di])) return true;
      }
    }
    return false;
  }

  function hasDescText(n) {
    if (n.type === 'TEXT') return true;
    if ('children' in n && n.children) {
      for (var di = 0; di < n.children.length; di++) {
        if (hasDescText(n.children[di])) return true;
      }
    }
    return false;
  }`;
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
  if (!node.children || node.children.length === 0) {
    return { width: Math.ceil(node.width), height: Math.ceil(node.height) };
  }
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
  return (node.fills || []).some(f => f.visible && f.type !== 'IMAGE');
}

export function getPrimaryFillColor(node: FigmaForgeNode): FigmaColor {
  // Any gradient fill → return white so UIGradient colors render at full fidelity.
  // Without this, Roblox multiplies BackgroundColor3 × UIGradient → double-tinted/pastel.
  const gradFill = (node.fills || []).find(f => f.type?.startsWith('GRADIENT_') && f.visible);
  if (gradFill) return { r: 1, g: 1, b: 1, a: 1 };

  const solidFill = (node.fills || []).find(f => f.type === 'SOLID' && f.visible);
  if (solidFill?.color) return solidFill.color;

  return { r: 1, g: 1, b: 1, a: 1 };
}

export function getGradientFill(node: FigmaForgeNode): FigmaFill | undefined {
  return (node.fills || []).find(f => f.type?.startsWith('GRADIENT_') && f.visible);
}

export function getPrimaryStroke(node: FigmaForgeNode): FigmaStroke | undefined {
  return (node.strokes || []).find(s => s.visible);
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
  const primaryFill = (node.fills || []).find(f => f.visible && f.type !== 'IMAGE');
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
  /** Cross-axis spacing for wrapped layouts (Roblox UIListLayout has no native equivalent yet) */
  counterAxisSpacing: number;
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
    counterAxisSpacing: Math.round(al.counterAxisSpacing ?? 0),
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
