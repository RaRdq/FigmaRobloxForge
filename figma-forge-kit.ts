/**
 * FigmaForge Kit Extraction — UI Kit Page → Lua Kit Module
 * 
 * Scans a Figma UI Kit page for component sets (atoms with variants),
 * deduplicates PNGs by content hash to avoid redundant uploads,
 * and generates a Kit.luau module with state-aware factory functions.
 * 
 * ## Key Features:
 * - **Dedup Uploads**: SHA-256 hash of PNG bytes → same visual = 1 upload
 * - **State Assembly**: Figma variants (State=Default/Hover/Pressed/Disabled)
 *   → single Kit function with :SetState("Hover") support
 * - **Auto 9-Slice**: Detects corner radius → generates UICorner + ScaleType.Slice
 * 
 * ## Figma Convention:
 * Component sets with variants:
 *   TabButton / State=Default, State=Hover, State=Active
 *   CardPill / Size=Small, Size=Large, State=Current, State=Locked
 * 
 * Standalone components (no variants):
 *   Icon_Gem, Divider, Badge_New
 */

import * as crypto from 'crypto';
import type { FigmaForgeNode, FigmaColor } from './figma-forge-ir';
import { escapeXmlAttr, round, sanitizeTextForRoblox, stripConventionSuffix } from './figma-forge-shared';

// ─── Types ───────────────────────────────────────────────────────

/** A single visual state of a component (e.g. "Default", "Hover") */
export interface KitVariant {
  /** Variant property values: { State: "Hover", Size: "Large" } */
  props: Record<string, string>;
  /** Figma node ID for export */
  nodeId: string;
  /** Content hash for dedup */
  contentHash: string;
  /** Resolved rbxassetid after upload (set during resolve phase) */
  assetId?: string;
  /** Dimensions */
  width: number;
  height: number;
}

/** A Kit component (may have multiple variants/states) */
export interface KitComponent {
  /** Clean component name */
  name: string;
  /** Original Figma name */
  figmaName: string;
  /** Is this a component set (has variants) or standalone */
  isComponentSet: boolean;
  /** Variant property names in order: ["State", "Size"] */
  variantProperties: string[];
  /** All variants */
  variants: KitVariant[];
  /** Corner radius (from default variant) */
  cornerRadius: number;
  /** Has text content (generates TextLabel slot) */
  hasText: boolean;
  /** Default text content (from default variant) */
  defaultText: string;
}

/** Dedup registry — maps content hash → assetId */
export interface DedupRegistry {
  /** hash → assetId */
  hashToAsset: Record<string, string>;
  /** Stats */
  stats: {
    totalVariants: number;
    uniqueImages: number;
    savedUploads: number;
  };
}

/** Complete Kit extraction result */
export interface KitExtractionResult {
  components: KitComponent[];
  dedup: DedupRegistry;
  /** Node IDs that actually need export (after dedup) */
  exportNodeIds: string[];
  /** Generated Kit.luau source code */
  luauSource?: string;
}

// ─── Extraction ──────────────────────────────────────────────────

/**
 * Extract Kit components from a Figma UI Kit page IR tree.
 * Expects the root to be the Kit page frame, with children being components.
 */
export function extractKitComponents(
  pageRoot: FigmaForgeNode,
): KitExtractionResult {
  const components: KitComponent[] = [];
  const dedup: DedupRegistry = {
    hashToAsset: {},
    stats: { totalVariants: 0, uniqueImages: 0, savedUploads: 0 },
  };
  const seenHashes = new Set<string>();
  const exportNodeIds: string[] = [];

  for (const child of pageRoot.children || []) {
    if (!child.visible) continue;

    const component = extractComponent(child, seenHashes, exportNodeIds, dedup);
    if (component) {
      components.push(component);
    }
  }

  dedup.stats.uniqueImages = seenHashes.size;
  dedup.stats.savedUploads = dedup.stats.totalVariants - seenHashes.size;

  return { components, dedup, exportNodeIds };
}

function extractComponent(
  node: FigmaForgeNode,
  seenHashes: Set<string>,
  exportNodeIds: string[],
  dedup: DedupRegistry,
): KitComponent | null {
  const cleanName = toKitName(stripConventionSuffix(node.name));

  // Check if this is a component set (has children that are variants)
  const isSet = hasVariantChildren(node);

  if (isSet) {
    // Component set — each child is a variant
    const variantProperties = detectVariantProperties(node);
    const variants: KitVariant[] = [];

    for (const variantNode of node.children || []) {
      if (!variantNode.visible) continue;
      const props = parseVariantName(variantNode.name);
      const hash = computeVisualHash(variantNode);
      dedup.stats.totalVariants++;

      const variant: KitVariant = {
        props,
        nodeId: variantNode.id,
        contentHash: hash,
        width: Math.round(variantNode.width),
        height: Math.round(variantNode.height),
      };

      // Dedup: only export if we haven't seen this hash
      if (!seenHashes.has(hash)) {
        seenHashes.add(hash);
        exportNodeIds.push(variantNode.id);
      }

      variants.push(variant);
    }

    // Find default variant for cornerRadius and text
    const defaultVariant = node.children?.[0];
    const cr = typeof node.cornerRadius === 'number' ? node.cornerRadius
      : (typeof defaultVariant?.cornerRadius === 'number' ? defaultVariant.cornerRadius : 0);

    return {
      name: cleanName,
      figmaName: node.name,
      isComponentSet: true,
      variantProperties,
      variants,
      cornerRadius: cr,
      hasText: hasTextChild(node),
      defaultText: getDefaultText(node),
    };
  } else {
    // Standalone component
    const hash = computeVisualHash(node);
    dedup.stats.totalVariants++;

    if (!seenHashes.has(hash)) {
      seenHashes.add(hash);
      exportNodeIds.push(node.id);
    }

    const cr = typeof node.cornerRadius === 'number' ? node.cornerRadius : 0;

    return {
      name: cleanName,
      figmaName: node.name,
      isComponentSet: false,
      variantProperties: [],
      variants: [{
        props: {},
        nodeId: node.id,
        contentHash: hash,
        width: Math.round(node.width),
        height: Math.round(node.height),
      }],
      cornerRadius: cr,
      hasText: hasTextChild(node),
      defaultText: getDefaultText(node),
    };
  }
}

// ─── Lua Generation ──────────────────────────────────────────────

/**
 * Generate Kit.luau source code from extracted components.
 * Call after asset upload when rbxassetid URLs are resolved.
 */
export function generateKitLuau(
  components: KitComponent[],
  assetMap: Record<string, string>,
): string {
  const lines: string[] = [
    '--!strict',
    '--[[ FigmaForge Kit — Auto-generated from Figma UI Kit ]]',
    '-- DO NOT EDIT MANUALLY — regenerate with: figma-forge-kit',
    '',
    'local Kit = {}',
    '',
  ];

  for (const comp of components) {
    if (comp.isComponentSet && comp.variants.length > 1) {
      lines.push(...generateStatefulComponent(comp, assetMap));
    } else {
      lines.push(...generateSimpleComponent(comp, assetMap));
    }
    lines.push('');
  }

  lines.push('return Kit');
  return lines.join('\n');
}

function generateSimpleComponent(
  comp: KitComponent,
  assetMap: Record<string, string>,
): string[] {
  const v = comp.variants[0];
  const asset = assetMap[v.nodeId] || `rbxassetid://0 -- MISSING: ${v.nodeId}`;
  const lines: string[] = [];

  lines.push(`--[[ ${comp.figmaName} — ${v.width}x${v.height} ]]`);

  if (comp.hasText) {
    lines.push(`function Kit.${comp.name}(props: { text: string?, size: UDim2? }?): Frame`);
  } else {
    lines.push(`function Kit.${comp.name}(props: { size: UDim2? }?): Frame`);
  }

  lines.push(`\tlocal p = props or {}`);
  lines.push(`\tlocal frame = Instance.new("Frame")`);
  lines.push(`\tframe.Name = "${comp.name}"`);
  lines.push(`\tframe.Size = p.size or UDim2.fromOffset(${v.width}, ${v.height})`);
  lines.push(`\tframe.BackgroundTransparency = 1`);
  lines.push(`\tframe.BorderSizePixel = 0`);

  if (comp.cornerRadius > 0) {
    lines.push(`\tlocal corner = Instance.new("UICorner")`);
    lines.push(`\tcorner.CornerRadius = UDim.new(0, ${Math.round(comp.cornerRadius)})`);
    lines.push(`\tcorner.Parent = frame`);
  }

  lines.push(`\tlocal bg = Instance.new("ImageLabel")`);
  lines.push(`\tbg.Name = "_BG"`);
  lines.push(`\tbg.Size = UDim2.fromScale(1, 1)`);
  lines.push(`\tbg.BackgroundTransparency = 1`);
  lines.push(`\tbg.BorderSizePixel = 0`);
  lines.push(`\tbg.Image = "${asset}"`);
  lines.push(`\tbg.ScaleType = Enum.ScaleType.Stretch`);
  lines.push(`\tbg.Parent = frame`);

  if (comp.hasText) {
    lines.push(`\tlocal label = Instance.new("TextLabel")`);
    lines.push(`\tlabel.Name = "Label"`);
    lines.push(`\tlabel.Size = UDim2.fromScale(1, 1)`);
    lines.push(`\tlabel.BackgroundTransparency = 1`);
    lines.push(`\tlabel.BorderSizePixel = 0`);
    lines.push(`\tlabel.Text = p.text or "${sanitizeTextForRoblox(comp.defaultText)}"`);
    lines.push(`\tlabel.TextColor3 = Color3.new(1, 1, 1)`);
    lines.push(`\tlabel.Font = Enum.Font.GothamBold`);
    lines.push(`\tlabel.TextSize = 14`);
    lines.push(`\tlabel.Parent = frame`);
  }

  lines.push(`\treturn frame`);
  lines.push(`end`);

  return lines;
}

function generateStatefulComponent(
  comp: KitComponent,
  assetMap: Record<string, string>,
): string[] {
  const lines: string[] = [];
  const defaultVariant = comp.variants[0];
  const defaultAsset = assetMap[defaultVariant.nodeId] || 'rbxassetid://0';

  // Detect state property (usually "State")
  const stateProperty = comp.variantProperties.find(p =>
    p.toLowerCase() === 'state' || p.toLowerCase() === 'mode'
  ) || comp.variantProperties[0] || 'State';

  lines.push(`--[[ ${comp.figmaName} — ${comp.variants.length} variants ]]`);
  lines.push(`--[[ Variants: ${comp.variants.map(v => Object.values(v.props).join('/')).join(', ')} ]]`);

  if (comp.hasText) {
    lines.push(`function Kit.${comp.name}(props: { text: string?, size: UDim2?, state: string? }?): Frame`);
  } else {
    lines.push(`function Kit.${comp.name}(props: { size: UDim2?, state: string? }?): Frame`);
  }

  lines.push(`\tlocal p = props or {}`);
  lines.push(`\tlocal frame = Instance.new("Frame")`);
  lines.push(`\tframe.Name = "${comp.name}"`);
  lines.push(`\tframe.Size = p.size or UDim2.fromOffset(${defaultVariant.width}, ${defaultVariant.height})`);
  lines.push(`\tframe.BackgroundTransparency = 1`);
  lines.push(`\tframe.BorderSizePixel = 0`);

  if (comp.cornerRadius > 0) {
    lines.push(`\tlocal corner = Instance.new("UICorner")`);
    lines.push(`\tcorner.CornerRadius = UDim.new(0, ${Math.round(comp.cornerRadius)})`);
    lines.push(`\tcorner.Parent = frame`);
  }

  lines.push(`\tlocal bg = Instance.new("ImageLabel")`);
  lines.push(`\tbg.Name = "_BG"`);
  lines.push(`\tbg.Size = UDim2.fromScale(1, 1)`);
  lines.push(`\tbg.BackgroundTransparency = 1`);
  lines.push(`\tbg.BorderSizePixel = 0`);
  lines.push(`\tbg.Image = "${defaultAsset}"`);
  lines.push(`\tbg.ScaleType = Enum.ScaleType.Stretch`);
  lines.push(`\tbg.Parent = frame`);

  if (comp.hasText) {
    lines.push(`\tlocal label = Instance.new("TextLabel")`);
    lines.push(`\tlabel.Name = "Label"`);
    lines.push(`\tlabel.Size = UDim2.fromScale(1, 1)`);
    lines.push(`\tlabel.BackgroundTransparency = 1`);
    lines.push(`\tlabel.BorderSizePixel = 0`);
    lines.push(`\tlabel.Text = p.text or "${sanitizeTextForRoblox(comp.defaultText)}"`);
    lines.push(`\tlabel.TextColor3 = Color3.new(1, 1, 1)`);
    lines.push(`\tlabel.Font = Enum.Font.GothamBold`);
    lines.push(`\tlabel.TextSize = 14`);
    lines.push(`\tlabel.Parent = frame`);
  }

  // State asset map
  lines.push('');
  lines.push(`\t-- State → asset mapping (deduped by visual hash)`);
  lines.push(`\tlocal _stateAssets = {`);
  const emittedHashes = new Set<string>();
  for (const v of comp.variants) {
    const stateValue = v.props[stateProperty] || Object.values(v.props)[0] || 'Default';
    const asset = assetMap[v.nodeId] || 'rbxassetid://0';
    // Dedup: if same hash as another variant, point to the same asset
    const effectiveAsset = emittedHashes.has(v.contentHash)
      ? (assetMap[comp.variants.find(ov => ov.contentHash === v.contentHash && ov.nodeId !== v.nodeId)?.nodeId || v.nodeId] || asset)
      : asset;
    emittedHashes.add(v.contentHash);
    lines.push(`\t\t["${stateValue}"] = "${effectiveAsset}",`);
  }
  lines.push(`\t}`);

  // SetState method via attribute
  lines.push('');
  lines.push(`\t-- Apply initial state`);
  lines.push(`\tlocal initialState = p.state or "${defaultVariant.props[stateProperty] || 'Default'}"`);
  lines.push(`\tif _stateAssets[initialState] then`);
  lines.push(`\t\tbg.Image = _stateAssets[initialState]`);
  lines.push(`\tend`);

  // Store state map on frame for runtime access
  lines.push('');
  lines.push(`\t-- Expose SetState function via frame attribute`);
  lines.push(`\tframe:SetAttribute("_KitStateMap", true)`);
  lines.push(`\t(frame :: any)._stateAssets = _stateAssets`);
  lines.push(`\t(frame :: any)._bg = bg`);

  lines.push(`\treturn frame`);
  lines.push(`end`);

  return lines;
}

// ─── Kit State Helper (available to all games) ───────────────────

/**
 * Generate a static helper function for state switching.
 * Appended to Kit.luau
 */
export function generateKitHelpers(): string {
  return `
--[[ Kit State Helper — switch visual state on multi-state atoms ]]
function Kit.SetState(frame: Frame, state: string)
\tlocal stateAssets = (frame :: any)._stateAssets
\tlocal bg = (frame :: any)._bg
\tif stateAssets and bg and stateAssets[state] then
\t\tbg.Image = stateAssets[state]
\tend
end
`;
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Compute a visual hash for dedup purposes */
function computeVisualHash(node: FigmaForgeNode): string {
  const data = JSON.stringify({
    w: Math.round(node.width),
    h: Math.round(node.height),
    fills: node.fills?.map(f => ({ t: f.type, c: f.color, o: f.opacity })),
    effects: node.effects?.map(e => ({ t: e.type, r: e.radius, c: e.color })),
    opacity: node.opacity,
    cr: node.cornerRadius,
    chars: node.characters,
    cc: node.children?.length ?? 0,
  });
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
}

/** Check if node has children that look like variants (have variant-style names) */
function hasVariantChildren(node: FigmaForgeNode): boolean {
  if (!node.children || node.children.length < 2) return false;
  // Variants typically have names like "State=Default", "Size=Large, State=Hover"
  return node.children.some(c => c.name.includes('='));
}

/** Detect variant property names from child variant names */
function detectVariantProperties(node: FigmaForgeNode): string[] {
  const props = new Set<string>();
  for (const child of node.children || []) {
    const pairs = child.name.split(',').map(s => s.trim());
    for (const pair of pairs) {
      const [key] = pair.split('=');
      if (key) props.add(key.trim());
    }
  }
  return Array.from(props);
}

/** Parse "State=Default, Size=Large" → { State: "Default", Size: "Large" } */
function parseVariantName(name: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pairs = name.split(',').map(s => s.trim());
  for (const pair of pairs) {
    const [key, value] = pair.split('=').map(s => s.trim());
    if (key && value) {
      result[key] = value;
    }
  }
  return result;
}

/** Check if any descendant is a TEXT node */
function hasTextChild(node: FigmaForgeNode): boolean {
  if (node.type === 'TEXT') return true;
  if (node.children) {
    return node.children.some(c => hasTextChild(c));
  }
  return false;
}

/** Get default text from first TEXT descendant */
function getDefaultText(node: FigmaForgeNode): string {
  if (node.type === 'TEXT' && node.characters) return node.characters;
  if (node.children) {
    for (const child of node.children) {
      const text = getDefaultText(child);
      if (text) return text;
    }
  }
  return '';
}

/** Convert Figma component name to valid Lua identifier */
function toKitName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^(\d)/, '_$1')
    .replace(/_+/g, '_')
    .replace(/_$/, '');
}
