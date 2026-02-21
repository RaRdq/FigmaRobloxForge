/**
 * FigmaForge Bindings Generator
 * 
 * Walks the IR tree and generates a binding manifest JSON describing all
 * interactive, text-bindable, and template nodes for automatic runtime wiring.
 * 
 * ## 3 Annotation Methods (designers can use any):
 * 
 * 1. **Name suffix**: `BulletPoint[Template]`, `ContentPane[Scroll]`
 * 2. **Name pattern**: `*Btn` → button, `*Tab` → tab, `$Price` → dynamic text
 * 3. **Figma description**: Add `@template`, `@scroll`, `@bind:key` in node description
 * 
 * Output: <name>.bindings.json alongside the .rbxmx
 */

import type { FigmaForgeNode } from './figma-forge-ir';
import {
  RuntimeConfig, isDynamicText, isTemplateNode,
  stripConventionSuffix, isScrollConvention,
} from './figma-forge-shared';

// ─── Types ───────────────────────────────────────────────────────

export interface BindingManifest {
  /** Root frame name */
  root: string;
  /** Close button _Interact node names */
  closeButtons: string[];
  /** Text nodes that should be bound to data keys. Maps node name → suggested data key */
  textBindings: Record<string, string>;
  /** Template nodes for dynamic lists. Maps template name → { parent, key } */
  templates: Record<string, { parent: string; key: string }>;
  /** Tab groups. Maps group name → ordered list of tab frame names */
  tabGroups: Record<string, string[]>;
  /** All interactive _Interact node names */
  interactiveNodes: string[];
  /** All container frame names for reference */
  containers: string[];
  /** Scroll containers */
  scrollContainers: string[];
  /** Metadata */
  meta: {
    generatedAt: string;
    figmaForgeVersion: string;
    nodeCount: number;
  };
}

// ─── Annotation Detection (3 methods) ────────────────────────────

/** Pattern-based button detection: names ending with Btn, Button, etc. */
const BUTTON_PATTERNS = /(?:Btn|Button|CTA|Action)$/i;

/** Pattern-based tab detection: names starting with Tab_ or ending with _Tab */
const TAB_PATTERNS = /(?:^Tab_|_Tab$)/i;

/** Pattern-based input detection */
const INPUT_PATTERNS = /(?:Input|Field|TextBox)$/i;

/** Check if node is a template via any of the 3 methods */
function isTemplateAny(node: FigmaForgeNode): boolean {
  // Method 1: Name suffix
  if (isTemplateNode(node.name)) return true;
  // Method 3: Figma description metadata
  if (node.description && /@template\b/i.test(node.description)) return true;
  return false;
}

/** Check if node is a scroll container via any of the 3 methods */
function isScrollAny(node: FigmaForgeNode): boolean {
  if (isScrollConvention(node.name)) return true;
  if (node.description && /@scroll\b/i.test(node.description)) return true;
  return false;
}

/** Check if node is a button via any of the 3 methods */
function isButtonAny(node: FigmaForgeNode): boolean {
  if (node.name.endsWith('_Interact')) return true;
  if (BUTTON_PATTERNS.test(node.name)) return true;
  if (node.description && /@button\b/i.test(node.description)) return true;
  return false;
}

/** Check if node is a tab via any of the 3 methods */
function isTabAny(node: FigmaForgeNode): boolean {
  if (TAB_PATTERNS.test(node.name)) return true;
  if (node.description && /@tab\b/i.test(node.description)) return true;
  return false;
}

/** Extract @bind:key from description. Returns the key or null */
function getBindKey(node: FigmaForgeNode): string | null {
  if (!node.description) return null;
  const match = node.description.match(/@bind:(\w+)/i);
  return match ? match[1] : null;
}

// ─── Generator ───────────────────────────────────────────────────

/**
 * Generate a binding manifest from the IR tree.
 * Call after extraction but before or after assembly.
 */
export function generateBindings(
  root: FigmaForgeNode,
  config: RuntimeConfig,
): BindingManifest {
  const manifest: BindingManifest = {
    root: stripConventionSuffix(root.name),
    closeButtons: [],
    textBindings: {},
    templates: {},
    tabGroups: {},
    interactiveNodes: [],
    containers: [],
    scrollContainers: [],
    meta: {
      generatedAt: new Date().toISOString(),
      figmaForgeVersion: '2.0.0',
      nodeCount: 0,
    },
  };

  const tabFrames: { name: string; parentName: string }[] = [];
  walkForBindings(root, root.name, config, manifest, tabFrames);

  // ── Group tabs by parent container ──
  const tabsByParent = new Map<string, string[]>();
  for (const tab of tabFrames) {
    const group = tabsByParent.get(tab.parentName) || [];
    group.push(tab.name);
    tabsByParent.set(tab.parentName, group);
  }
  for (const [parentName, tabs] of tabsByParent) {
    manifest.tabGroups[parentName] = tabs;
  }

  return manifest;
}

function walkForBindings(
  node: FigmaForgeNode,
  parentName: string,
  config: RuntimeConfig,
  manifest: BindingManifest,
  tabFrames: { name: string; parentName: string }[],
): void {
  if (!node.visible) return;
  manifest.meta.nodeCount++;

  const cleanName = stripConventionSuffix(node.name);

  // ── Interactive overlays (_Interact suffix) ──
  if (isButtonAny(node)) {
    manifest.interactiveNodes.push(node.name);
    // Close buttons: parent name contains 'close'
    const baseName = node.name.replace('_Interact', '');
    if (baseName.toLowerCase().includes('close')) {
      manifest.closeButtons.push(node.name);
    }
  }

  // ── Tab frames (3 methods) ──
  if (isTabAny(node) && !node.name.endsWith('_Interact')) {
    tabFrames.push({ name: cleanName, parentName });
  }

  // ── Template nodes (3 methods) ──
  if (isTemplateAny(node)) {
    manifest.templates[cleanName] = {
      parent: parentName,
      key: toCamelCase(cleanName),
    };
  }

  // ── Text bindings ──
  if (node.type === 'TEXT') {
    // Method 3: explicit @bind:key in description
    const bindKey = getBindKey(node);
    if (bindKey) {
      manifest.textBindings[cleanName] = bindKey;
    } else if (isDynamicText(node, config)) {
      // Method 1 & 2: dynamic text detection via name patterns
      manifest.textBindings[cleanName] = toCamelCase(cleanName);
    }
  }

  // ── Containers ──
  if (node.children && node.children.length > 0) {
    manifest.containers.push(cleanName);
    if (isScrollAny(node)) {
      manifest.scrollContainers.push(cleanName);
    }
  }

  // ── Recurse ──
  if (node.children) {
    for (const child of node.children) {
      walkForBindings(child, cleanName, config, manifest, tabFrames);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Convert a PascalCase/snake_case name to a camelCase key */
function toCamelCase(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, char) => char.toUpperCase())
    .replace(/^[A-Z]/, char => char.toLowerCase());
}
