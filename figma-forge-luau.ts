/**
 * FigmaForge Luau Generator
 * 
 * Converts FigmaForge IR → Luau code for injection into Roblox Studio
 * via `mcp_roblox-studio_run_code`.
 * 
 * Architecture: Data-driven approach using a flat instruction table + 
 * a compact interpreter loop. This minimizes code size vs individual 
 * Instance.new() calls for hundreds of nodes.
 * 
 * The generated code:
 *   1. Clears any previous FigmaForge output under StarterGui
 *   2. Creates a flat table of {class, name, parentIdx, props} entries
 *   3. A ~40-line interpreter loop creates all instances, sets properties,
 *      and parents them correctly
 *   4. Final result is a single Frame tree under StarterGui
 */

import type { FigmaForgeNode, FigmaFill, FigmaStroke, FigmaColor, FigmaGradientStop } from './figma-forge-ir';

// ─── Helpers ─────────────────────────────────────────────────────

function round(n: number, decimals: number = 5): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

function luaStr(s: string): string {
  // Escape for Lua string literal, handling unicode and special chars
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
}

function toRGB255(c: FigmaColor): string {
  return `Color3.fromRGB(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})`;
}

// ─── Node Classification ─────────────────────────────────────────

function robloxClass(node: FigmaForgeNode): string {
  if (node.type === 'TEXT') return 'TextLabel';
  const hasImageFill = node.fills.some(f => f.type === 'IMAGE' && f.visible);
  if (hasImageFill) return 'ImageLabel';
  return 'Frame';
}

function hasVisibleFills(node: FigmaForgeNode): boolean {
  return node.fills.some(f => f.visible && f.type !== 'IMAGE');
}

function getPrimaryFillColor(node: FigmaForgeNode): FigmaColor {
  const solidFill = node.fills.find(f => f.type === 'SOLID' && f.visible);
  if (solidFill?.color) return solidFill.color;
  const gradientFill = node.fills.find(f => f.type?.startsWith('GRADIENT_') && f.visible);
  if (gradientFill?.gradientStops?.[0]?.color) return gradientFill.gradientStops[0].color;
  return { r: 1, g: 1, b: 1, a: 1 };
}

function getGradientFill(node: FigmaForgeNode): FigmaFill | undefined {
  return node.fills.find(f => f.type?.startsWith('GRADIENT_') && f.visible);
}

function getPrimaryStroke(node: FigmaForgeNode): FigmaStroke | undefined {
  return node.strokes.find(s => s.visible);
}

// ─── Font Mapping ────────────────────────────────────────────────

const FONT_MAP: Record<string, string> = {
  'Fredoka One': 'rbxassetid://12187365364',
  'Fredoka': 'rbxassetid://12187365364',
  'Inter': 'rbxasset://fonts/families/SourceSansPro.json',
  'Roboto': 'rbxasset://fonts/families/SourceSansPro.json',
  'Arial': 'rbxasset://fonts/families/SourceSansPro.json',
};

function getFontFamily(family: string): string {
  return FONT_MAP[family] ?? 'rbxasset://fonts/families/SourceSansPro.json';
}

function getFontWeight(weight: number): string {
  const w = Math.round(weight / 100) * 100;
  const map: Record<number, string> = {
    100: 'Enum.FontWeight.Thin',
    200: 'Enum.FontWeight.ExtraLight',
    300: 'Enum.FontWeight.Light',
    400: 'Enum.FontWeight.Regular',
    500: 'Enum.FontWeight.Medium',
    600: 'Enum.FontWeight.SemiBold',
    700: 'Enum.FontWeight.Bold',
    800: 'Enum.FontWeight.ExtraBold',
    900: 'Enum.FontWeight.Heavy',
  };
  return map[w] ?? 'Enum.FontWeight.Regular';
}

function textXAlignment(align: string): string {
  switch (align) {
    case 'LEFT': return 'Enum.TextXAlignment.Left';
    case 'CENTER': return 'Enum.TextXAlignment.Center';
    case 'RIGHT': return 'Enum.TextXAlignment.Right';
    default: return 'Enum.TextXAlignment.Left';
  }
}

function textYAlignment(align: string): string {
  switch (align) {
    case 'TOP': return 'Enum.TextYAlignment.Top';
    case 'CENTER': return 'Enum.TextYAlignment.Center';
    case 'BOTTOM': return 'Enum.TextYAlignment.Bottom';
    default: return 'Enum.TextYAlignment.Top';
  }
}

// ─── Gradient Helpers ────────────────────────────────────────────

function colorSequenceLua(stops: FigmaGradientStop[]): string {
  if (!stops || stops.length === 0) return 'ColorSequence.new(Color3.new(1,1,1))';
  if (stops.length === 1) {
    const c = stops[0].color;
    return `ColorSequence.new(${toRGB255(c)})`;
  }
  const kps = stops.map(s => {
    const c = s.color;
    return `ColorSequenceKeypoint.new(${round(s.position)}, ${toRGB255(c)})`;
  });
  return `ColorSequence.new({${kps.join(', ')}})`;
}

function transparencySequenceLua(stops: FigmaGradientStop[]): string {
  if (!stops || stops.length === 0) return 'NumberSequence.new(0)';
  const hasVariance = stops.some(s => (s.color.a ?? 1) < 0.999);
  if (!hasVariance) return 'NumberSequence.new(0)';
  const kps = stops.map(s => {
    const transparency = round(1 - (s.color.a ?? 1));
    return `NumberSequenceKeypoint.new(${round(s.position)}, ${transparency})`;
  });
  return `NumberSequence.new({${kps.join(', ')}})`;
}

function gradientRotation(transform?: [[number, number, number], [number, number, number]]): number {
  if (!transform) return 90;
  const [[a, _c, _e], [b, _d, _f]] = transform;
  return Math.round(Math.atan2(b, a) * (180 / Math.PI));
}

// ─── Instruction Flattener ───────────────────────────────────────

interface LuaInstruction {
  class: string;
  name: string;
  parentIdx: number; // 0 = root (StarterGui child)
  props: string[];   // Lua property assignments: "inst.Prop = value"
  zIndex: number;
}

/**
 * Flatten the node tree into a sequential list of instructions.
 * Each instruction knows its parent index in the flat list.
 *
 * Uses absolute pixel coordinates (Offset) matching Figma's coordinate system.
 * Figma node x/y/width/height are always absolute pixels relative to parent.
 */
function flattenNode(
  node: FigmaForgeNode,
  parentIdx: number,
  isRoot: boolean,
  zIndex: number,
  instructions: LuaInstruction[]
): void {
  if (!node.visible) return;
  if (node._isStrokeDuplicate) return;

  const className = robloxClass(node);
  const myIdx = instructions.length + 1; // 1-indexed for Lua
  const props: string[] = [];

  // ── Common properties ──
  props.push(`i.Active = true`);
  props.push(`i.Visible = true`);
  props.push(`i.BorderSizePixel = 0`);
  props.push(`i.Rotation = ${round(node.rotation)}`);
  props.push(`i.ZIndex = ${zIndex}`);
  props.push(`i.LayoutOrder = ${zIndex}`);

  // ── Position & Size (absolute pixels — matching Figma coordinates exactly) ──
  const xPx = Math.round(node.x);
  const yPx = Math.round(node.y);
  const wPx = Math.round(node.width);
  const hPx = Math.round(node.height);

  if (isRoot) {
    // Root node: center on screen for preview
    props.push(`i.AnchorPoint = Vector2.new(0.5, 0.5)`);
    props.push(`i.Position = UDim2.new(0.5, 0, 0.5, 0)`);
  } else {
    props.push(`i.AnchorPoint = Vector2.new(0, 0)`);
    props.push(`i.Position = UDim2.new(0, ${xPx}, 0, ${yPx})`);
  }
  props.push(`i.Size = UDim2.new(0, ${wPx}, 0, ${hPx})`);

  // ── Fill / BackgroundTransparency ──
  if (className === 'TextLabel') {
    props.push(`i.BackgroundTransparency = 1`);
  } else if (!hasVisibleFills(node)) {
    props.push(`i.BackgroundTransparency = 1`);
    props.push(`i.BackgroundColor3 = Color3.new(1, 1, 1)`);
  } else {
    // Use per-fill opacity (Figma fills have their own opacity), combined with node opacity
    const primaryFill = node.fills.find(f => f.visible && f.type !== 'IMAGE');
    const fillOpacity = (primaryFill?.opacity ?? 1) * node.opacity;
    const bgTransparency = round(1 - fillOpacity);
    props.push(`i.BackgroundTransparency = ${bgTransparency}`);
    const fillColor = getPrimaryFillColor(node);
    props.push(`i.BackgroundColor3 = ${toRGB255(fillColor)}`);
  }

  // ClipsDescendants
  if (node.clipsContent) {
    props.push(`i.ClipsDescendants = true`);
  }

  // ── Text-specific ──
  if (className === 'TextLabel' && node.characters !== undefined) {
    const ts = node.textStyle;
    props.push(`i.Text = "${luaStr(node.characters)}"`);
    props.push(`i.TextSize = ${ts?.fontSize ?? 14}`);
    props.push(`i.TextXAlignment = ${textXAlignment(ts?.textAlignHorizontal ?? 'LEFT')}`);
    props.push(`i.TextYAlignment = ${textYAlignment(ts?.textAlignVertical ?? 'TOP')}`);
    props.push(`i.TextWrapped = true`);
    props.push(`i.TextTruncate = Enum.TextTruncate.None`);
    
    const fontFamily = getFontFamily(ts?.fontFamily ?? 'Inter');
    const fontWeight = getFontWeight(ts?.fontWeight ?? 400);
    props.push(`i.FontFace = Font.new("${fontFamily}", ${fontWeight})`);

    const textColor = getPrimaryFillColor(node);
    props.push(`i.TextColor3 = ${toRGB255(textColor)}`);
    props.push(`i.TextTransparency = 0`);
  }

  // ── ImageLabel-specific ──
  if (className === 'ImageLabel') {
    const imageFill = node.fills.find(f => f.type === 'IMAGE' && f.visible);
    if (imageFill) {
      const imageId = (node as any)._resolvedImageId ?? '';
      props.push(`i.Image = "${imageId}"`);
      props.push(`i.ScaleType = Enum.ScaleType.Stretch`);
      props.push(`i.ImageTransparency = 0`);
      props.push(`i.BackgroundTransparency = 1`);
    }
  }

  instructions.push({
    class: className,
    name: node.name,
    parentIdx: parentIdx,
    props: props,
    zIndex: zIndex,
  });

  // ── UICorner ──
  const cr = Array.isArray(node.cornerRadius) ? node.cornerRadius[0] : node.cornerRadius;
  if (cr > 0) {
    instructions.push({
      class: 'UICorner',
      name: 'UICorner',
      parentIdx: myIdx,
      props: [`i.CornerRadius = UDim.new(0, ${Math.round(cr)})`],
      zIndex: 0,
    });
  }

  // ── UIGradient ──
  const gradFill = getGradientFill(node);
  if (gradFill && gradFill.gradientStops) {
    instructions.push({
      class: 'UIGradient',
      name: 'UIGradient',
      parentIdx: myIdx,
      props: [
        `i.Enabled = true`,
        `i.Rotation = ${gradientRotation(gradFill.gradientTransform)}`,
        `i.Offset = Vector2.new(0, 0)`,
        `i.Color = ${colorSequenceLua(gradFill.gradientStops)}`,
        `i.Transparency = ${transparencySequenceLua(gradFill.gradientStops)}`,
      ],
      zIndex: 0,
    });
  }

  // ── UIStroke ──
  const primaryStroke = getPrimaryStroke(node);
  const inferredStroke = (node as any)._inferredStrokeThickness;
  if (primaryStroke || inferredStroke) {
    const strokeColor = primaryStroke?.color
      ?? (node as any)._inferredStrokeColor
      ?? { r: 0, g: 0, b: 0, a: 1 };
    const strokeThickness = node.strokeWeight || inferredStroke || 1;
    // Roblox UIStroke modes:
    //   - Contextual = text stroke (like Figma text stroke layers)
    //   - Border = draws OUTSIDE the element boundary
    // Figma strokeAlign INSIDE has no exact Roblox equivalent.
    // We use Border mode for all non-text and note the alignment mismatch.
    const applyMode = className === 'TextLabel'
      ? 'Enum.ApplyStrokeMode.Contextual'
      : 'Enum.ApplyStrokeMode.Border';

    instructions.push({
      class: 'UIStroke',
      name: 'UIStroke',
      parentIdx: myIdx,
      props: [
        `i.ApplyStrokeMode = ${applyMode}`,
        `i.Color = ${toRGB255(strokeColor)}`,
        `i.LineJoinMode = Enum.LineJoinMode.Round`,
        `i.Thickness = ${round(strokeThickness, 1)}`, // preserve fractional weights (2.5px etc)
        `i.Transparency = 0`,
      ],
      zIndex: 0,
    });
  }

  // ── Children (recursive) ──
  if (node.children && node.children.length > 0) {
    for (let i = 0; i < node.children.length; i++) {
      flattenNode(node.children[i], myIdx, false, i + 1, instructions);
    }
  }
}

// ─── Luau Code Generator ─────────────────────────────────────────

/**
 * Generate Luau code string from a FigmaForge IR tree.
 * The code creates the full instance hierarchy under a specified parent.
 * 
 * @param root - The root FigmaForge node
 * @param parentW - Parent canvas width
 * @param parentH - Parent canvas height
 * @param targetParent - Luau expression for the parent (default: StarterGui)
 * @returns Luau code string ready for mcp_roblox-studio_run_code
 */
export function generateLuau(
  root: FigmaForgeNode,
  parentW: number,
  parentH: number,
  targetParent: string = 'game:GetService("StarterGui")',
): string {
  const instructions: LuaInstruction[] = [];
  flattenNode(root, 0, true, 1, instructions);

  const lines: string[] = [];

  // Header
  lines.push(`-- FigmaForge Auto-Generated UI (${instructions.length} instances)`);
  lines.push(`-- Source: "${luaStr(root.name)}" (${root.id})`);
  lines.push(`-- Canvas: ${parentW}×${parentH}`);
  lines.push(`-- Generated: ${new Date().toISOString()}`);
  lines.push(``);

  // Cleanup previous
  lines.push(`local target = ${targetParent}`);
  lines.push(``);

  // Auto-create ScreenGui wrapper (UI only renders inside ScreenGui)
  lines.push(`-- ScreenGui wrapper (required for UI rendering)`);
  lines.push(`local oldScreen = target:FindFirstChild("FigmaForge_Preview")`);
  lines.push(`if oldScreen then oldScreen:Destroy() end`);
  lines.push(`local screenGui = Instance.new("ScreenGui")`);
  lines.push(`screenGui.Name = "FigmaForge_Preview"`);
  lines.push(`screenGui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling`);
  lines.push(`screenGui.ResetOnSpawn = false`);
  lines.push(`screenGui.IgnoreGuiInset = true`);
  lines.push(`screenGui.Parent = target`);
  lines.push(``);

  lines.push(`local refs = {} -- refs[idx] = Instance`);
  lines.push(``);

  // Emit each instruction as a block
  for (let idx = 0; idx < instructions.length; idx++) {
    const inst = instructions[idx];
    const luaIdx = idx + 1;

    lines.push(`-- [${luaIdx}] ${inst.class}: ${inst.name}`);
    lines.push(`do`);
    lines.push(`  local i = Instance.new("${inst.class}")`);
    lines.push(`  i.Name = "${luaStr(inst.name)}"`);

    for (const prop of inst.props) {
      lines.push(`  ${prop}`);
    }

    // Root node parents to ScreenGui, children parent to their parent ref
    if (inst.parentIdx === 0) {
      lines.push(`  i.Parent = screenGui`);
    } else {
      lines.push(`  i.Parent = refs[${inst.parentIdx}]`);
    }

    lines.push(`  refs[${luaIdx}] = i`);
    lines.push(`end`);
    lines.push(``);
  }

  lines.push(`print("[FigmaForge] ✅ Created ${instructions.length} instances under " .. screenGui:GetFullName())`);

  return lines.join('\n');
}

// ─── Chunked Generator (for very large trees) ───────────────────

/**
 * Generate Luau code split into chunks that won't exceed MCP limits.
 * Each chunk creates a subset of instances and stores refs in a shared table.
 * 
 * @param root - The root node
 * @param parentW - Canvas width
 * @param parentH - Canvas height
 * @param maxChunkSize - Max instructions per chunk (default: 80)
 * @returns Array of Luau code strings, each safe to run via run_code
 */
export function generateLuauChunked(
  root: FigmaForgeNode,
  parentW: number,
  parentH: number,
  maxChunkSize: number = 80,
): string[] {
  const instructions: LuaInstruction[] = [];
  flattenNode(root, 0, true, 1, instructions);

  if (instructions.length <= maxChunkSize) {
    return [generateLuau(root, parentW, parentH)];
  }

  const chunks: string[] = [];
  const totalChunks = Math.ceil(instructions.length / maxChunkSize);

  for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
    const start = chunkIdx * maxChunkSize;
    const end = Math.min(start + maxChunkSize, instructions.length);
    const isFirst = chunkIdx === 0;
    const isLast = chunkIdx === totalChunks - 1;

    const lines: string[] = [];

    if (isFirst) {
      lines.push(`-- FigmaForge Chunk ${chunkIdx + 1}/${totalChunks} (${instructions.length} total instances)`);
      lines.push(`-- Source: "${luaStr(root.name)}" | Canvas: ${parentW}×${parentH}`);
      lines.push(``);
      lines.push(`local target = game:GetService("StarterGui")`);
      lines.push(``);
      // ScreenGui wrapper (required for UI rendering)
      lines.push(`local oldScreen = target:FindFirstChild("FigmaForge_Preview")`);
      lines.push(`if oldScreen then oldScreen:Destroy() end`);
      lines.push(`local screenGui = Instance.new("ScreenGui")`);
      lines.push(`screenGui.Name = "FigmaForge_Preview"`);
      lines.push(`screenGui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling`);
      lines.push(`screenGui.ResetOnSpawn = false`);
      lines.push(`screenGui.IgnoreGuiInset = true`);
      lines.push(`screenGui.Parent = target`);
      lines.push(``);
      // Shared cross-chunk storage
      lines.push(`local storage = Instance.new("Folder")`);
      lines.push(`storage.Name = "_FigmaForgeRefs"`);
      lines.push(`storage.Parent = game:GetService("ReplicatedStorage")`);
      lines.push(``);
      lines.push(`if not _G._figmaForgeRefs then _G._figmaForgeRefs = {} end`);
      lines.push(`_G._figmaForgeRefs.__screenGui = screenGui`);
      lines.push(`local refs = _G._figmaForgeRefs`);
    } else {
      lines.push(`-- FigmaForge Chunk ${chunkIdx + 1}/${totalChunks}`);
      lines.push(`local refs = _G._figmaForgeRefs`);
      lines.push(`local screenGui = refs.__screenGui`);
    }
    lines.push(``);

    for (let idx = start; idx < end; idx++) {
      const inst = instructions[idx];
      const luaIdx = idx + 1;

      lines.push(`do`);
      lines.push(`  local i = Instance.new("${inst.class}")`);
      lines.push(`  i.Name = "${luaStr(inst.name)}"`);

      for (const prop of inst.props) {
        lines.push(`  ${prop}`);
      }

      // Root node parents to ScreenGui, children to their parent ref
      if (inst.parentIdx === 0) {
        lines.push(`  i.Parent = screenGui`);
      } else {
        lines.push(`  i.Parent = refs[${inst.parentIdx}]`);
      }

      lines.push(`  refs[${luaIdx}] = i`);
      lines.push(`end`);
      lines.push(``);
    }

    if (isLast) {
      lines.push(`-- Cleanup globals`);
      lines.push(`_G._figmaForgeRefs = nil`);
      lines.push(`local storage = game:GetService("ReplicatedStorage"):FindFirstChild("_FigmaForgeRefs")`);
      lines.push(`if storage then storage:Destroy() end`);
      lines.push(`print("[FigmaForge] ✅ Created ${instructions.length} instances in FigmaForge_Preview")`);
    } else {
      lines.push(`print("[FigmaForge] ✅ Chunk ${chunkIdx + 1}/${totalChunks} done (${end}/${instructions.length} instances)")`);
    }

    chunks.push(lines.join('\n'));
  }

  return chunks;
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Full pipeline: IR → Luau code string(s) ready for Roblox Studio MCP.
 * Returns a single string if small enough, or an array of chunks.
 */
export function manifestToLuau(manifest: {
  root: FigmaForgeNode;
  canvasWidth: number;
  canvasHeight: number;
}): string[] {
  return generateLuauChunked(manifest.root, manifest.canvasWidth, manifest.canvasHeight);
}
