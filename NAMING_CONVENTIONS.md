# FigmaForge Naming Conventions

> **For Figma designers** — naming layers correctly enables fully automatic Roblox export. No code changes needed.

## Convention Suffixes

Add these to any Figma layer name:

| Suffix | Effect in Roblox | Example |
|---|---|---|
| `[Flatten]` | Rasterized as single PNG (children baked into image) | `TitleGroup[Flatten]` |
| `[Scroll]` | Becomes a `ScrollingFrame` | `ContentPane[Scroll]` |
| `[Template]` | Hidden by default, cloned at runtime for lists | `BulletPoint[Template]` |

## Name Patterns

| Pattern | Detection | Roblox Behavior |
|---|---|---|
| `$Price`, `$Timer` | `$` prefix → dynamic text | TextLabel with `$` prefix, game code sets `.Text` |
| `CloseBtn`, `SubmitButton` | `*Btn`, `*Button`, `*close*` | Auto-gets invisible `_Interact` TextButton overlay |
| `_BG` | Background layer name | Auto-generated for hybrid containers (gradient/image fills) |

## Text Classification (Current Behavior)

**ALL text nodes → TextLabel.** Text is never rasterized as PNG.

Two categories control naming:
- **Dynamic** (`$` prefix added): name starts with `$`, or matches patterns (`price`, `timer`, `count`, `level`, etc.), or content looks like a value (`$1,234`, `x3`, `50%`, `00:00`)
- **Static** (original name kept): everything else — labels, headers, button text

Dynamic pattern list (SSOT in `figma-forge-shared.ts` `DEFAULT_CONFIG`):
```
Name: price, unit, socket, stats, timer, count, amount, level, score, currency, health, progress, rank, value, quantity
Text: {values}, $1.2K, 1234, 00:00, x3, Level 5, Lv.42, PlayerName, 0, 50%, ..., →, emojis, ?
```

## Interactive Detection

Patterns (case-insensitive): `btn`, `button`, `close`, `submit`, `toggle`, `tab_`, `back`, `_tab`

Auto-generates `<ParentName>_Interact` TextButton overlay (invisible, `AutoButtonColor=false`).

`[Flatten]` nodes matching interactive patterns also get `_Interact` overlays injected automatically.

## Scroll Detection

Three methods (any triggers ScrollingFrame):
1. Figma native: `Overflow` set to Horizontal/Vertical/Both
2. Name suffix: `[Scroll]`
3. Description: `@scroll` in Figma node description

## Font Mapping

Unmapped fonts fall back to `BuilderSans`. See `FONT_MAP` in `figma-forge-shared.ts` for full mapping (40+ fonts).

## Root Frame Rules

- Root frame (Figma section/page wrapper) always gets `BackgroundTransparency=1` — Figma section fills are discarded
- Root frame auto-centered: `AnchorPoint(0.5,0.5)` + `Position(0.5,0,0.5,0)`
- Root frame with rounded corners → `ClipsDescendants=true`
- `ZIndexBehavior=Sibling` for proper layering

## Example Layer Tree

```
📁 🔄 Rebirth Modal              ← Figma SECTION (root, bg discarded)
  📁 ModalFrame                   ← Container Frame
    📁 _BG                        ← Rasterized gradient background (ImageLabel)
    📁 TitleGroup[Flatten]        ← Baked: gradient title text → PNG
    📝 $RebirthName               ← Dynamic TextLabel (game sets .Text)
    📁 CloseBtn                   ← Interactive container
      📁 _BG                      ← Button face PNG
      🔘 CloseBtn_Interact        ← Auto-injected click target
    📁 ContentArea
      📝 $MultiplierLabel         ← Dynamic text
      📁 UpgradeRow               ← Container with auto-layout
```
