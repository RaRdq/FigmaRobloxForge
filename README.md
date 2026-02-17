# 🔨 FigmaRobloxForge

**Pixel-accurate Figma → Roblox UI code generator.**

Extract any Figma design and generate production-ready Luau code or `.rbxmx` files that reproduce your UI 1:1 inside Roblox Studio — gradients, strokes, rounded corners, text styles, and all.

## ✨ Features

- **Pixel-perfect extraction** — captures fills, strokes, gradients, corner radii, text styles, effects, opacity, and layout from Figma
- **Multiple output formats** — generates Luau scripts or `.rbxmx` XML for direct Studio import
- **Automatic ScreenGui wrapping** — output is immediately renderable, no manual setup required
- **Chunked generation** — handles large designs by splitting into sequential execution chunks
- **Fractional precision** — preserves sub-pixel stroke weights and exact color values
- **MCP integration** — works with Figma Desktop Bridge plugin for live extraction

## 🏗️ Architecture

```
Figma Desktop (MCP Bridge)
        ↓
  Extract Script (JS executed inside Figma plugin context)
        ↓
  Intermediate Representation (JSON manifest)
        ↓
  Generator (Luau code  or  .rbxmx XML)
        ↓
  Roblox Studio (via MCP run_code  or  file import)
```

| Module | Purpose |
|---|---|
| `figma-forge-ir.ts` | TypeScript interfaces for the IR — node tree, fills, strokes, text, effects |
| `figma-forge-extract.ts` | Builds the JS extraction script that runs inside Figma via MCP |
| `figma-forge-luau.ts` | Generates Luau Instance-tree code from IR |
| `figma-forge-rbxmx.ts` | Generates `.rbxmx` XML from IR |
| `figma-forge-cli.ts` | CLI orchestrator — extract → generate pipeline |

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Figma Desktop](https://www.figma.com/downloads/) with the MCP Desktop Bridge plugin running
- [Roblox Studio](https://www.roblox.com/create) with MCP server (optional, for direct injection)

### Installation

```bash
git clone https://github.com/RaRdq/FigmaRobloxForge.git
cd FigmaRobloxForge
npm install
```

### Usage

```bash
# Generate Luau from a manifest JSON
npx ts-node figma-forge-cli.ts --input manifest.json --format luau

# Generate rbxmx XML
npx ts-node figma-forge-cli.ts --input manifest.json --format rbxmx
```

Or use programmatically with an AI agent (Claude, Gemini, etc.) via MCP:

1. **Extract** — run the extraction script inside Figma via `figma_execute`
2. **Generate** — pass the JSON manifest to `processManifest()` or `processManifestChunked()`
3. **Inject** — execute the generated Luau in Roblox Studio via `roblox-studio_run_code`

## 🔧 How It Works

1. The **extraction script** traverses the Figma node tree starting from a target node, capturing every visual property into a flat IR
2. The **IR** is a JSON manifest containing all node data — positions, sizes, fills (solid + gradient), strokes, corner radii, text content/styles, effects, and hierarchy
3. The **generator** walks the IR and emits Roblox-native code:
   - `Frame` for rectangles, `TextLabel` for text, `UICorner` for radii
   - `UIGradient` for gradient fills, `UIStroke` for borders
   - Absolute pixel positioning via `UDim2.new(0, px, 0, px)`

## 🗺️ Roadmap

- [ ] Image asset pipeline (auto-upload textures)
- [ ] Auto-layout → UIListLayout mapping
- [ ] Effect mapping (shadows, blurs)
- [ ] Component/variant detection
- [ ] Fusion reactive code generation
- [ ] Interactive CLI with progress bars

## 🤝 Contributing

Contributions welcome! This tool was built to solve a real problem — getting beautiful Figma designs into Roblox without hours of manual recreation.

1. Fork the repo
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.
