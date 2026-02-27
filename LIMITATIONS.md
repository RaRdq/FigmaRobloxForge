# FigmaForge Limitations & Recommendations

## Auto-Fixed (Generic for All Games)

| Issue | Fix | Details |
|---|---|---|
| **Root frame bg** | `BackgroundTransparency=1` forced on root (Figma section fills discarded) | `emitContainerNode()` |
| **Dynamic text clipping** | `$`-prefixed TextLabels get `AutomaticSize=Y`, `TextWrapped=true`, parent-fill width in auto-layout | `emitDynamicTextNode()` |
| **Interactive overlays** | Containers matching `Btn`/`Button`/`close` auto-get `_Interact` TextButton (invisible, `AutoButtonColor=false`) | `emitInteractiveOverlay()` |
| **[Flatten] + interactive** | Baked PNG buttons also get `_Interact` overlay auto-injected | `emitPngNode()` |
| **Responsive scaling** | Figma Constraints (Center, Right, Scale, Stretch) → Roblox `UDim2` Scale + `AnchorPoint` | `emitGeometry()` |
| **Scrolling frames** | Figma Overflow / `[Scroll]` / `@scroll` → `ScrollingFrame` with computed `CanvasSize` | `isScrollContainer()` |
| **Solid fill optimization** | Single solid fills → `BackgroundColor3` (no PNG needed) | `_solidFill` in extract |
| **Overflow promotion** | Interactive children exceeding clipped parent bounds → promoted as siblings | `emitContainerNode()` |
| **HUG text centering** | HUG text in centered auto-layout → forced `TextXAlignment=Center` | `emitDynamicTextNode()` |
| **[Flatten] tag stripping** | `[Flatten]`/`[Raster]`/`[Flattened]` stripped from output names | Post-process step |

## Cannot Auto-Fix (Designer Must Address in Figma)

### 1. Decorative Overflow vs Misplacement
Figma allows intentional child overflow. FigmaForge warns but can't distinguish from mistakes.
- Enable "Clip content" in Figma if overflow is NOT desired
- For intentional overflow: accept warning or ensure parent is large enough

### 2. Font Substitution
Figma fonts don't map 1:1 to Roblox. Unmapped fonts fall back to `BuilderSans`.
See `FONT_MAP` in `figma-forge-shared.ts` (40+ mappings).

### 3. Complex Gradients & Effects
Roblox `UIGradient` only supports linear gradients. Radial/angular/diamond gradients trigger automatic PNG rasterization via `_isHybrid` → `_BG` ImageLabel. Trade-off: pixel-perfect but not scalable.

### 4. Mixed Font Properties (Symbol Serialization)
Figma returns `figma.mixed` (a Symbol) for text properties when multiple styles exist in one text node (e.g., bold + regular). The extract script must guard ALL font properties with `!== figma.mixed` checks. Unguarded Symbols cause `Cannot unwrap symbol` errors in `postMessage`.

## Pipeline Notes

- **Output directory**: Turbo extract artifacts go to `../../temp/figmaforge/` (never in FigmaForge source dir)
- **Image upload**: Must use `assetType: 'Image'` (NOT `Decal`) — Decals limit to 420×420 with compression
- **Image cache**: `.figmaforge-image-cache.json` maps hashes → `rbxassetid://` URLs. Delete if images fail to load.
- **Rojo sync**: After generating `.rbxmx`, Rojo auto-syncs. If stale, destroy instance in Studio then touch the file.
