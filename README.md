# 🔨 FigmaForge

**Pixel-accurate Figma → Roblox UI exporter using the PNG-slice pipeline.**

Extracts any Figma frame and generates a production-ready `.rbxmx` file: every visual element becomes a PNG `ImageLabel`, dynamic text becomes `TextLabel`, and layout hierarchy is preserved as nested `Frame` containers. Drop shadows, gradients, strokes, and effects are all baked into the PNGs — zero approximation, pixel-perfect results.

## ✨ How It Works

![Figma design (left) exported pixel-perfect to Roblox (right) via FigmaForge](docs/figma-forge-process.png)

**Every Layer Sliced** — FigmaForge classifies each node as one of three types:

| Classification | Roblox Instance | Logic |
|---|---|---|
| **PNG** | `ImageLabel` | Any leaf node or subtree without dynamic text → rasterized via `exportAsync` |
| **Dynamic Text** | `TextLabel` | Text nodes with `$` prefix or matching dynamic patterns (`price`, `level`, etc.) |
| **Container** | `Frame` | Parent nodes with dynamic text descendants → preserves hierarchy, self rasterized as background |

Complex Figma features (radial gradients, blurs, complex strokes, shadows) all "just work" because they're baked into the PNG.

## 🏗️ Architecture

```
Figma Desktop (MCP Bridge plugin)
        ↓  figma_execute → extraction script runs in Figma sandbox
  JSON Manifest (IR with node tree + base64 PNGs)
        ↓  figma-forge-cli.ts --resolve-images
  Pipeline: dedup → classify → upload PNGs → assemble .rbxmx → Rojo safety check
        ↓
  .rbxmx + .bindings.json  ──→  Rojo auto-sync  ──→  Roblox Studio
```

### Module Map

| Module | Purpose |
|---|---|
| `figma-forge-ir.ts` | TypeScript IR interfaces — node tree, fills, strokes, text, effects, `_renderBounds` |
| `figma-forge-extract.ts` | Builds the JS extraction script for Figma sandbox — node serialization, render bounds, layer classification, text-stroke deduplication |
| `figma-forge-assemble.ts` | `.rbxmx` XML generator — node classification, positioning, ImageLabel/TextLabel/Frame emission, auto-layout → UIListLayout |
| `figma-forge-images.ts` | Image upload pipeline — base64 PNG → Roblox Open Cloud API → `rbxassetid://`, content-hash caching |
| `figma-forge-shared.ts` | Font mapping (Figma→Roblox), dynamic text classification (SSOT), scroll detection, config compilation, XML/Lua escaping |
| `figma-forge-cli.ts` | CLI orchestrator — arg parsing, config loading, Rojo safety validator, binding manifest generation |
| `figma-forge-bindings.ts` | Binding manifest generator — walks IR tree to detect buttons, tabs, templates, text bindings, scroll containers |
| `figma-forge-export.ts` | Batch PNG export script generator — chunked `exportAsync` for Figma's 30s timeout |
| `figma-forge-diff.ts` | Incremental re-export — structural hash diffing, `--incremental` support, saves ~80% upload time |
| `figma-forge-animations.ts` | Prototype transition → TweenService Luau code generation |
| `figma-forge-kit.ts` | UI Kit page extraction — component sets with variants → Lua `Kit` module with state switching |

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Figma Desktop](https://www.figma.com/downloads/) with the MCP Desktop Bridge plugin running
- [Rojo](https://rojo.space/) serving your project (for `.rbxmx` auto-sync)
- Roblox Open Cloud API key (see Image Pipeline section)

### Build

```bash
cd tools/FigmaForge
npm install
npx tsc --outDir dist
```

### Usage

```bash
npx ts-node figma-forge-cli.ts \
  --input manifest.json \
  --output ../../src/StarterGui/MyFrame.rbxmx \
  --resolve-images \
  --api-key YOUR_ROBLOX_API_KEY \
  --creator-id YOUR_ROBLOX_CREATOR_ID \
  --verbose
```

### CLI Options

```
Options:
  --input, -i          Path to FigmaForge manifest JSON (required)
  --output, -o         Path for generated .rbxmx (default: <input>.rbxmx)
  --scale, -s          PNG export scale factor (default: 2)
  --config, -c         Path to custom figmaforge.config.json
  --text-export        Text export mode: 'all' (default), 'dynamic', 'none'
  --resolve-images     Upload exported PNGs to Roblox Cloud
  --merge-images       Path to exported-images JSON to merge into manifest
  --api-key            Roblox Open Cloud API key (highest priority)
  --creator-id         Roblox creator/user ID for asset ownership
  --skip-dedup         Skip text-stroke deduplication pass
  --responsive         Use scale-based sizing proportional to root
  --incremental <prev> Path to previous manifest for incremental re-export
  --save-manifest      Save current state for future --incremental exports
  --verbose, -v        Show detailed processing info
  --help, -h           Show help
```

### Outputs

The CLI produces two files:
- **`<name>.rbxmx`** — the Roblox UI tree (auto-synced via Rojo)
- **`<name>.bindings.json`** — binding manifest listing buttons, text bindings, templates, tabs, scroll containers

## 📸 Image Pipeline

When extraction identifies PNG nodes, they're rasterized via `exportAsync` at 2× scale. The CLI uploads them to Roblox Cloud and patches `rbxassetid://` URIs into the `.rbxmx`.

### Configuration

Config priority for Roblox API credentials:

1. **CLI arguments** (recommended) — `--api-key YOUR_KEY --creator-id YOUR_ID`
2. **Environment variables:** `ROBLOX_API_KEY` + `ROBLOX_CREATOR_ID`
3. **`.env` file** in FigmaForge directory
4. **`scripts/roblox-config.json`** — project-level fallback

> [!WARNING]
> **Always clear stale env vars** before running CLI: `$Env:ROBLOX_API_KEY=$null; $Env:ROBLOX_CREATOR_ID=$null`

### Custom Configuration (`figmaforge.config.json`)

FigmaForge is genre-agnostic. Override default text and button detection heuristics:

```json
{
  "dynamicPrefix": "$",
  "textExportMode": "dynamic",
  "dynamicNamePatterns": [
    "^price", "^level", "^score", "^amount"
  ],
  "dynamicTextPatterns": [
    "^\\\\{[^}]+\\\\}$",
    "^[\\\\d,]+$"
  ],
  "interactivePatterns": [
    "btn", "button", "tab_"
  ]
}
```

- **`textExportMode`** (config default: `"dynamic"`, CLI default: `"all"`):
  - `"all"`: Every text node becomes a Roblox `TextLabel`.
  - `"dynamic"`: Only text nodes matching the dynamic patterns become `TextLabel`s. All other text is baked into the rasterized PNG background.
  - `"none"`: All text is baked into the background PNG.

### Caching

Uploaded images are cached by content hash in `.figmaforge-image-cache.json`. Re-exports reuse existing `rbxassetid://` URIs. Delete the cache file to force re-uploads.

## 🎯 Render Bounds (Drop Shadow Fix)

> [!IMPORTANT]
> This is a critical architectural detail for pixel-perfect exports.

Figma's `exportAsync()` renders at `absoluteRenderBounds` (includes effects like drop shadows, blurs), but the node's `.width/.height` properties only report the logical bounding box. Without correction, PNGs with shadow padding get squeezed into too-small ImageLabels.

**FigmaForge handles this automatically:**

1. **Extraction** (`figma-forge-extract.ts`): Compares `absoluteRenderBounds` vs `absoluteBoundingBox` for nodes with visible effects or strokes. Stores the delta as `_renderBounds` in the IR.
2. **Assembly** (`figma-forge-assemble.ts`): Uses `_renderBounds` for ImageLabel position and size when present, falling back to standard `x/y/width/height` otherwise.

## 🧠 Node Classification

The assembler (`figma-forge-assemble.ts` → `classifyNode`) determines how each IR node is emitted:

| Criterion | Classification | Output |
|---|---|---|
| Text matching config rules / export mode | `text_dynamic` | `TextLabel` |
| Has children with dynamic text descendants | `container` | `Frame` (with background ImageLabel if hybrid) |
| Everything else (leaf, no dynamic children) | `png` | `ImageLabel` |

### Solid Fill Optimization

Nodes with a single solid fill (no strokes, no gradients) skip rasterization entirely — they're emitted as native Roblox `Frame` with `BackgroundColor3`, avoiding unnecessary PNG uploads.

### Naming Conventions

FigmaForge recognizes special suffixes in Figma layer names:

| Suffix | Effect |
|---|---|
| `[Flatten]` / `[Raster]` | Force-rasterize entire subtree as one PNG |
| `[Template]` | Mark as template node for dynamic list cloning |
| `[Scroll]` | Force `ScrollingFrame` output |
| `$` prefix | Force dynamic text classification (TextLabel) |

### 3 Annotation Methods

Designers can annotate nodes via:
1. **Name suffix**: `BulletPoint[Template]`, `ContentPane[Scroll]`
2. **Name pattern**: `*Btn` → button, `Tab_*` → tab, `$Price` → dynamic text
3. **Figma description**: `@template`, `@scroll`, `@bind:key`, `@button`, `@tab`

## 🛡️ Rojo Safety Validator

The CLI validates the generated `.rbxmx` before writing, catching:
- `<token>` tags for properties Rojo expects as `<int>` (AutomaticSize, ScrollBarThickness, etc.)
- Mismatched `<Item>` open/close tags (XML well-formedness)
- Duplicate referent IDs (causes Rojo to silently merge nodes)

Build fails fast with actionable error messages if any check fails.

## ⚠️ Known Limitations

- **Roblox font mapping** — Figma fonts mapped to closest Roblox equivalent (Inter→BuilderSans). Some fonts may not have exact matches.
- **Per-corner radius** — Roblox `UICorner` only supports uniform radius. Per-corner is approximated with max value.
- **`SPACE_BETWEEN` layout** — No Roblox equivalent, falls back to `MIN` alignment.
- **Component instances** — Exported as their expanded tree, not as Roblox component references.

## 🔧 Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Rojo: `invalid digit found in string` | Negative value in `<token>` tag | Tokens must be unsigned ints (0+) |
| Rojo: `duplicate referent` | Two nodes share same referent ID | Check assembler assigns unique referents |
| Empty/white ImageLabels | Unresolved image hashes | Run with `--resolve-images` |
| Squished buttons/shadows | Missing render bounds | Ensure extraction captures `absoluteRenderBounds` |
| `[Flatten]` in node name | Rojo interprets brackets | Post-process: strip `[Flatten]` tags from .rbxmx |
| Rojo won't re-sync destroyed instance | `$ignoreUnknownInstances: true` | Disconnect and reconnect Rojo plugin |
| Images fail to load | Stale image cache | Delete `.figmaforge-image-cache.json` and re-run |
| Dark/squished text | Static text rasterized as PNG | Check `textExportMode` — use `all` to keep all text as TextLabel |

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.
