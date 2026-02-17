# 🔨 FigmaRobloxForge

**Pixel-accurate Figma → Roblox UI code generator.**

Extract any Figma design and generate production-ready `.rbxmx` files or Luau code that reproduce your UI 1:1 inside Roblox Studio — gradients, strokes, rounded corners, text styles, shadows, and all.

## ✨ Features

- **Pixel-perfect extraction** — captures fills, strokes, gradients, corner radii, text styles, effects, opacity, and layout from Figma
- **Multiple output formats** — `.rbxmx` XML for direct Studio/Rojo import, or Luau scripts for MCP injection
- **Text stroke deduplication** — automatically detects Figma's "duplicate text for outline" hack and collapses it into a native `UIStroke`
- **Image pipeline** — uploads Figma image fills to Roblox Cloud, caches `imageHash → rbxassetid` to avoid re-uploads
- **Shadow synthesis** — `DROP_SHADOW` and `INNER_SHADOW` effects become proper Roblox Frame siblings
- **MCP integration** — works with Figma Desktop Bridge + Roblox Studio MCP for fully automated workflows

## 🏗️ Architecture

```
Figma Desktop (MCP Bridge plugin)
        ↓  figma_execute → extraction script runs in Figma sandbox
  JSON Manifest (Intermediate Representation)
        ↓  figma-forge-cli.ts
  Pipeline: dedup → image resolve → generate
        ↓
  .rbxmx file  ──→  Rojo auto-sync  ──→  Roblox Studio
  (or Luau)         (file watcher)        (StarterGui)
```

| Module | Purpose |
|---|---|
| `figma-forge-ir.ts` | TypeScript interfaces for the IR — node tree, fills, strokes, text, effects |
| `figma-forge-extract.ts` | Builds the JS extraction script + text-stroke deduplication pass |
| `figma-forge-rbxmx.ts` | Generates `.rbxmx` XML from IR (recommended for Rojo workflows) |
| `figma-forge-luau.ts` | Generates Luau Instance-tree code from IR (for MCP injection) |
| `figma-forge-images.ts` | Image upload pipeline — base64 → roblox_upload.py → rbxassetid:// |
| `figma-forge-effects.ts` | Shadow and blur effect synthesis |
| `figma-forge-animations.ts` | Prototype transition → TweenService mapping |
| `figma-forge-cli.ts` | CLI orchestrator — ties everything together |

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Figma Desktop](https://www.figma.com/downloads/) with the MCP Desktop Bridge plugin running
- [Rojo](https://rojo.space/) serving your project (for `.rbxmx` auto-sync)

### Installation

```bash
cd tools/FigmaForge
npm install
npx tsc --outDir dist
```

### Usage

#### Step 1: Extract manifest from Figma

Use `mcp_figma_figma_execute` to run the extraction script inside Figma targeting your frame's node ID. The script traverses the node tree and returns a JSON manifest with all visual properties.

Save the output to `manifest.json`.

#### Step 2: Generate .rbxmx

```bash
# Generate rbxmx (recommended — works with Rojo auto-sync)
node dist/figma-forge-cli.js --input manifest.json --format rbxmx --output ../../src/StarterGui/MyFrame.rbxmx --verbose

# Generate Luau (alternative — for MCP injection via roblox-studio run_code)
node dist/figma-forge-cli.js --input manifest.json --format luau --output MyFrame.luau --verbose
```

#### Step 3: Import to Roblox

- **Rojo workflow (recommended):** Place `.rbxmx` in `src/StarterGui/` — Rojo auto-syncs it into Studio
- **MCP workflow:** Execute generated Luau via `mcp_roblox-studio_run_code`

### CLI Options

```
Options:
  --input, -i        Path to FigmaForge manifest JSON
  --output, -o       Path for generated file (default: <input-name>.rbxmx)
  --format, -f       Output format: 'rbxmx' (default) or 'luau'
  --skip-dedup       Skip text-stroke deduplication pass
  --resolve-images   Upload unresolved IMAGE fills to Roblox (requires API key)
  --verbose, -v      Show detailed processing info
  --help, -h         Show help
```

## 📸 Image Pipeline

When your Figma design contains image fills, the extraction captures `imageHash` identifiers. To upload these to Roblox:

### Configuration

The image pipeline needs a Roblox Open Cloud API key. Config priority:

1. **Environment variables:** `ROBLOX_API_KEY` + `ROBLOX_CREATOR_ID`
2. **`.env` file** in FigmaForge directory (copy `.env.example`)
3. **`scripts/roblox-config.json`** in project root

### Upload flow

1. Export image bytes from Figma (base64 PNG via `figma_execute`)
2. Save to a JSON map: `{ "imageHash": "base64data", ... }`
3. Run CLI with `--resolve-images`
4. The pipeline writes temp PNGs, uploads via `roblox_upload.py`, and patches `rbxassetid://` into the output
5. Results are cached in `.figmaforge-image-cache.json` to avoid re-uploads

## 🧠 Property Mapping

| Figma Property | Roblox Instance | Notes |
|---|---|---|
| `SOLID` fill | `BackgroundColor3` | Direct RGB mapping |
| `GRADIENT_LINEAR` fill | `UIGradient` | ColorSequence + Rotation |
| `cornerRadius` | `UICorner` | UDim(0, px) |
| Stroke (INSIDE) | `UIStroke` | ApplyStrokeMode = Border |
| Drop shadow | Shadow `Frame` sibling | Positioned behind with blur-simulated sizing |
| Inner shadow | Overlay `Frame` | Alpha gradient over element |
| Text content | `TextLabel.Text` | Preserves emoji/unicode |
| Font weight | `FontFace.Weight` | Mapped from Figma weight values |
| Text alignment | `TextXAlignment` / `TextYAlignment` | LEFT→0, CENTER→1, RIGHT→2 |
| Opacity | `BackgroundTransparency` | `1 - opacity` inversion |
| `clipContent` | `ClipsDescendants` | Direct mapping |
| Image fill | `ImageLabel.Image` | Requires image upload pipeline |

## ⚠️ Known Limitations

- **Radial/Angular gradients** → approximated as linear (or rasterized to PNG)
- **Layer blur / Background blur** → not natively supported in Roblox (skipped)
- **SPACE_BETWEEN** → no Roblox UIListLayout equivalent, falls back to MIN alignment
- **Complex text strokes** → dedup pass handles the common Figma outline pattern (N copies with slight offset); exotic stroke setups may need manual tweaking
- **Vector networks / boolean operations** → must be flattened in Figma first
- **Component instances** → exported as their expanded tree, not as Roblox component references

## 🔮 Roadmap: PNG Pipeline Pivot

The current node-tree reconstruction approach (Figma vectors → Roblox Frame/UICorner/UIStroke/UIGradient) is being replaced with a **PNG-based pipeline** for non-text elements. This matches how top Roblox games handle image-heavy Kit UIs:

1. **Extract** node tree from Figma (keep current extraction)
2. **Export** each non-text atom as flat PNG via `exportAsync`
3. **Upload** PNGs to Roblox Cloud (existing image pipeline)
4. **Generate** manifest with asset IDs, dimensions, and SliceCenter data
5. **Text** nodes remain as `TextLabel` instances (only exception)

## 🔧 Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Rojo: `invalid digit found in string` | Negative value in `<token>` XML tag | Ensure all token values are unsigned ints (0+) |
| Rojo: `duplicate referent` | Two nodes share same referent ID | Check rbxmx generator assigns unique referents |
| Missing images in Studio | Unresolved image hashes | Run with `--resolve-images` after exporting image bytes |
| Text looks wrong | Font not available in Roblox | Check font mapping in `figma-forge-shared.ts` |
| Elements overlap incorrectly | Z-order mismatch | FigmaForge uses `ZIndex` based on Figma layer order |

## 🤝 Contributing

1. Fork the repo
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Compile and test: `npx tsc --outDir dist && node dist/figma-forge-cli.js --input test-manifest.json --format rbxmx`
4. Commit your changes
5. Open a Pull Request

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.
