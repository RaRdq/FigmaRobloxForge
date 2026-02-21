# FigmaForge Limitations & Recommendations

## Auto-Fixed (Generic for All Games)

These are handled automatically by the assembler:

| Issue | Fix | Since |
|---|---|---|
| **Dynamic text clipping** | `$`-prefixed TextLabels get `AutomaticSize=Y`, `TextWrapped=true`, and parent-fill width when inside auto-layout | v2.1 |
| **Child overflow warnings** | Console warnings when children have negative positions or exceed parent bounds | v2.1 |
| **Interactive overlays** | Containers matching `Btn`/`Button` patterns auto-get invisible `TextButton` overlays for click detection | v2.0 |
| **Rojo safety validation** | Pre-write check catches `<token>` where `<int>` is needed, duplicate referents, XML malformation | v2.0 |
| **Responsive scaling** | Figma Constraints (e.g., Center, Right, Scale) auto-translated to Roblox `UDim2` Scale and `AnchorPoint` | v2.2 |
| **Scrolling frames** | Containers with Figma "Overflow" set to Horizontal/Vertical/Both automatically emit as `ScrollingFrame` | v2.2 |

## Cannot Auto-Fix (Designer Must Address in Figma)

These require manual Figma layer adjustments before export:

### 1. Decorative Overflow vs Misplacement
**Problem**: Figma allows child elements to intentionally overflow their parent (e.g., an icon bleeding past a card edge for visual effect). FigmaForge cannot distinguish this from genuine misplacement.

**Recommendation**: 
- Use `ClipsDescendants=true` on the Figma frame if overflow is NOT desired (enable "Clip content" in Figma)
- For intentional decorative overflow, ensure the parent frame is large enough to contain all children, or accept the console warning

### 2. Font Substitution
**Problem**: Figma fonts don't always map 1:1 to Roblox fonts. Custom fonts (e.g., "Luckiest Guy") are mapped via a lookup table; unmapped fonts fall back to `BuilderSans`.

**Current mapping**: See `getFontFamily()` in `figma-forge-assemble.ts`

### 4. Complex Gradients & Effects
**Problem**: Figma supports linear, radial, angular, and diamond gradients. Roblox `UIGradient` only supports linear gradients. Complex gradients, multi-shadow stacks, and advanced blending modes are handled by rasterizing the entire visual as a PNG.

**Trade-off**: Rasterized visuals are pixel-perfect but not scalable. For responsive UIs, keep gradients simple (linear) or use solid colors.


