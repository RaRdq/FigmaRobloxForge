/**
 * FigmaForge Intermediate Representation (IR)
 * 
 * Faithful data model for Figma nodes. Every field maps 1:1 to Figma's plugin API.
 * No Roblox-specific concepts here — this is the "source of truth" layer.
 */

// ─── Color & Paint ───────────────────────────────────────────────

/** sRGB color, 0-1 range per channel */
export interface FigmaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface FigmaGradientStop {
  position: number; // 0-1
  color: FigmaColor;
}

export type FigmaFillType = 'SOLID' | 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'IMAGE';

export interface FigmaFill {
  type: FigmaFillType;
  visible: boolean;
  opacity: number;
  // SOLID
  color?: FigmaColor;
  // GRADIENT_*
  gradientStops?: FigmaGradientStop[];
  gradientTransform?: [[number, number, number], [number, number, number]];
  // IMAGE
  imageHash?: string;
  scaleMode?: 'FILL' | 'FIT' | 'CROP' | 'TILE';
}

export interface FigmaStroke {
  type: 'SOLID' | 'GRADIENT_LINEAR';
  visible: boolean;
  color?: FigmaColor;
  gradientStops?: FigmaGradientStop[];
}

// ─── Effects ─────────────────────────────────────────────────────

export type FigmaEffectType = 'DROP_SHADOW' | 'INNER_SHADOW' | 'LAYER_BLUR' | 'BACKGROUND_BLUR';

export interface FigmaEffect {
  type: FigmaEffectType;
  visible: boolean;
  radius: number;
  color?: FigmaColor;
  offset?: { x: number; y: number };
  spread?: number;
}

// ─── Text ────────────────────────────────────────────────────────

export interface FigmaTextStyle {
  fontFamily: string;
  fontWeight: number;
  fontStyle: 'Normal' | 'Italic';
  fontSize: number;
  lineHeight: number | 'AUTO';
  letterSpacing: number;
  textAlignHorizontal: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  textAlignVertical: 'TOP' | 'CENTER' | 'BOTTOM';
  textDecoration: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
  textCase: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE';
}

// ─── Layout ──────────────────────────────────────────────────────

export type FigmaLayoutMode = 'NONE' | 'HORIZONTAL' | 'VERTICAL';
export type FigmaLayoutAlign = 'MIN' | 'CENTER' | 'MAX' | 'STRETCH' | 'BASELINE';
export type FigmaLayoutWrap = 'NO_WRAP' | 'WRAP';

export interface FigmaAutoLayout {
  mode: FigmaLayoutMode;
  itemSpacing: number;
  counterAxisSpacing?: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  primaryAxisAlignItems: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
  counterAxisAlignItems: FigmaLayoutAlign;
  layoutWrap: FigmaLayoutWrap;
}

// ─── Reactions & Transitions (Prototype animations) ──────────────

export type FigmaTriggerType =
  | 'ON_CLICK'
  | 'ON_HOVER'
  | 'ON_PRESS'
  | 'ON_DRAG'
  | 'AFTER_TIMEOUT'
  | 'MOUSE_ENTER'
  | 'MOUSE_LEAVE'
  | 'MOUSE_UP'
  | 'MOUSE_DOWN';

export type FigmaTransitionType =
  | 'DISSOLVE'
  | 'SMART_ANIMATE'
  | 'MOVE_IN'
  | 'MOVE_OUT'
  | 'PUSH'
  | 'SLIDE_IN'
  | 'SLIDE_OUT';

export type FigmaEasingType =
  | 'LINEAR'
  | 'EASE_IN'
  | 'EASE_OUT'
  | 'EASE_IN_AND_OUT'
  | 'EASE_IN_BACK'
  | 'EASE_OUT_BACK'
  | 'EASE_IN_AND_OUT_BACK'
  | 'CUSTOM_BEZIER';

export interface FigmaEasing {
  type: FigmaEasingType;
  /** Custom bezier control points (only for CUSTOM_BEZIER) */
  controlPoints?: [number, number, number, number];
}

export interface FigmaTransition {
  type: FigmaTransitionType;
  duration: number;  // seconds
  easing: FigmaEasing;
  direction?: 'LEFT' | 'RIGHT' | 'TOP' | 'BOTTOM';
}

export interface FigmaReaction {
  trigger: { type: FigmaTriggerType; delay?: number };
  action: {
    type: 'NAVIGATE' | 'SWAP' | 'OVERLAY' | 'SCROLL_TO' | 'BACK' | 'CLOSE' | 'URL';
    /** Target node ID for NAVIGATE/SWAP/OVERLAY actions */
    destinationId?: string;
    /** Transition animation spec */
    transition?: FigmaTransition;
    /** For OVERLAY actions: whether the overlay closes on outside click */
    closesOnOutsideClick?: boolean;
  };
}

// ─── Node ────────────────────────────────────────────────────────

export type FigmaNodeType =
  | 'FRAME'
  | 'RECTANGLE'
  | 'ELLIPSE'
  | 'TEXT'
  | 'GROUP'
  | 'LINE'
  | 'VECTOR'
  | 'INSTANCE'
  | 'COMPONENT'
  | 'COMPONENT_SET'
  | 'BOOLEAN_OPERATION'
  | 'SECTION';

export interface FigmaForgeNode {
  id: string;
  name: string;
  type: FigmaNodeType;
  visible: boolean;

  // Geometry
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;

  // Corner radius — uniform or per-corner [topLeft, topRight, bottomRight, bottomLeft]
  cornerRadius: number | [number, number, number, number];

  // Visual
  fills: FigmaFill[];
  strokes: FigmaStroke[];
  strokeWeight: number;
  strokeAlign: 'INSIDE' | 'OUTSIDE' | 'CENTER';
  effects: FigmaEffect[];
  opacity: number;
  blendMode: string;
  clipsContent: boolean;

  // Text-specific (only on TEXT nodes)
  characters?: string;
  textStyle?: FigmaTextStyle;
  /** Text sizing behaviour from Figma (maps to Roblox AutomaticSize) */
  textAutoResize?: 'NONE' | 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'TRUNCATE';

  // Auto Layout
  autoLayout?: FigmaAutoLayout;

  // Layout sizing (per-child sizing within an auto-layout parent)
  /** Figma layoutSizingHorizontal: how this node sizes within its parent's auto-layout */
  layoutSizingHorizontal?: 'FIXED' | 'FILL' | 'HUG';
  /** Figma layoutSizingVertical */
  layoutSizingVertical?: 'FIXED' | 'FILL' | 'HUG';

  // Prototype interactions
  reactions?: FigmaReaction[];

  // Children (ordered by z-index, bottom→top)
  children: FigmaForgeNode[];

  // ─── Engine Metadata (added during processing, not from Figma) ───
  /** Flagged true during text-stroke deduplication pass */
  _isStrokeDuplicate?: boolean;
  /** Resolved rbxassetid:// for IMAGE fills, populated by image pipeline */
  _resolvedImageId?: string;
  /** Inferred stroke thickness from text-stroke deduplication pass */
  _inferredStrokeThickness?: number;
  /** Inferred stroke color from text-stroke deduplication pass */
  _inferredStrokeColor?: FigmaColor;
  /** Matched UIAssets key (e.g. "Buttons.GreenPill") if Kit asset recognized */
  _kitAssetKey?: string;
  /** Synthetic imageHash for nodes rasterized during extraction (non-linear gradients) */
  _rasterizedImageHash?: string;
  /** True if this node and its children were flattened into a single rasterized image */
  _isFlattened?: boolean;
  /** True if this node is a [Flatten] container using smart-flatten (preserves TEXT children, rasterizes visual atoms) */
  _smartFlattened?: boolean;
  /** True if this node is a "Hybrid" node (rasterized background, but preserved dynamic children) */
  _isHybrid?: boolean;
}

// ─── Export Manifest ─────────────────────────────────────────────

export interface FigmaForgeManifest {
  version: '1.0.0';
  exportedAt: string;
  sourceFile: string;
  sourceNodeId: string;
  sourceNodeName: string;
  canvasWidth: number;
  canvasHeight: number;
  root: FigmaForgeNode;
  /** Image hashes found that need resolution */
  unresolvedImages: string[];
  /** Base64-encoded PNG data keyed by imageHash (populated by image export script) */
  exportedImages?: Record<string, string>;
  /** Stats for debugging */
  stats: {
    totalNodes: number;
    dedupedTextNodes: number;
    imageNodes: number;
    frameNodes: number;
    textNodes: number;
  };
}
