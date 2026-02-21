# FigmaForge Naming Conventions

> **For Figma designers** — naming your layers correctly enables fully automatic Roblox export and runtime wiring. No code changes needed.

## 3 Ways to Annotate

| Method | Where | Example | Best For |
|---|---|---|---|
| **Name Suffix** | Layer name | `BulletPoint[Template]` | Clear, visible in layer panel |
| **Name Pattern** | Layer name | `$Price`, `CloseBtn` | Compact, familiar conventions |
| **Description** | Figma description | `@template` | Clean names, metadata-driven |

---

## Convention Suffixes

Add these to any Figma layer name:

| Suffix | Effect in Roblox | Example |
|---|---|---|
| `[Template]` | Hidden by default, cloned at runtime for lists | `BulletPoint[Template]` |
| `[Scroll]` | Becomes a `ScrollingFrame` | `ContentPane[Scroll]` |
| `[Flatten]` | Rasterized as single PNG (ignores children) | `IconGroup[Flatten]` |

## Name Patterns

| Pattern | Detection | Roblox Behavior |
|---|---|---|
| `$Price`, `$Timer` | `$` prefix → dynamic text | Emitted as TextLabel, auto-bound |
| `CloseBtn`, `SubmitButton` | `*Btn`, `*Button` suffix | Auto-detected as interactive |
| `Tab_v0_1`, `Tab_Settings` | `Tab_` prefix | Grouped into tab sets |
| `_Interact` suffix | On TextButton overlays | Click handler wiring point |

## Description Metadata

Add these tags to the Figma **node description** (select layer → right panel → description field):

| Tag | Effect | Example |
|---|---|---|
| `@template` | Same as `[Template]` suffix | Add to a repeating row |
| `@scroll` | Same as `[Scroll]` suffix | Add to an overflowing container |
| `@button` | Same as `*Btn` pattern | Mark any frame as clickable |
| `@tab` | Same as `Tab_` prefix | Mark as tab in a group |
| `@bind:keyName` | Explicit data binding key | `@bind:playerLevel` on a TextLabel |

---

## Dynamic Text Detection

Text nodes are classified as **dynamic** (→ TextLabel) or **designed** (→ PNG) based on these rules:

1. Name starts with `$` (e.g. `$Price`, `$Timer`)
2. Name matches a pattern: `price`, `unit`, `socket`, `stats`, `timer`, `count`, `amount`, `level`, `score`, `currency`, `health`
3. Content matches: single `?`, placeholder-style text
4. Has `@bind:key` in description

**All other text** is exported as a PNG ImageLabel (preserving exact Figma styling).

---

## Interactive Elements

Any frame/group with children that has a `TextButton` named `<ParentName>_Interact` is treated as interactive. The `_Interact` overlay is an invisible button used for click detection.

**Close buttons** are auto-detected when the parent name contains `close` (case-insensitive).

---

## Example Layer Tree

```
📁 UpdateLogModal                    ← Root frame
  📁 TitleBar                        ← Container with drop shadow
    🖼️ _BG                           ← Rasterized background (PNG)
    📝 Title                         ← Designed text (PNG)
    📁 CloseBtn                      ← Close button group
      🖼️ _BG                        ← Button background (PNG)
      🔘 CloseBtn_Interact           ← Invisible click target
  📁 TabSidebar                      ← Tab group container
    📁 Tab_v0_2                      ← Tab frame (auto-grouped)
      📝 v0.2 ⚡                     ← Tab label
      🔘 Tab_v0_2_Interact           ← Tab click target
    📁 Tab_v0_1                      ← Another tab
      📝 v0.1 🚀
      🔘 Tab_v0_1_Interact
  📁 ContentPane[Scroll]             ← ScrollingFrame (explicit)
    📝 $UpdateTitle                  ← Dynamic text (bound at runtime)
    📝 $TeaserLine                   ← Dynamic text
    📁 BulletPoint[Template]         ← Template row (cloned per item)
      📝 $LineText                   ← Dynamic text inside template
```

---

## UI Kit Page Conventions

When using `figma-forge-kit` to extract a full UI Kit page:

### Component Sets (Multi-State Atoms)

Figma component sets with variants are auto-assembled into state-aware Kit atoms:

```
📦 TabButton (Component Set)
  ├── State=Default        → Kit.TabButton({ state = "Default" })
  ├── State=Hover          → Kit.TabButton({ state = "Hover" })
  ├── State=Active         → Kit.TabButton({ state = "Active" })
  └── State=Disabled       → Kit.TabButton({ state = "Disabled" })
```

**State switching at runtime:**
```lua
local tab = Kit.TabButton({ text = "Shop", state = "Default" })
-- On hover:
Kit.SetState(tab, "Hover")
-- On click:
Kit.SetState(tab, "Active")
```

### Dedup Behavior

PNGs are deduplicated by SHA-256 visual hash:
- If `State=Default` and `State=Hover` look identical → **1 upload**, both states share the asset
- Saves bandwidth and Roblox assets on iterative re-exports

### Standalone Components

Components without variants (icons, dividers, badges) become simple factory functions:
```lua
local gem = Kit.Icon_Gem()
local divider = Kit.Divider({ size = UDim2.fromOffset(300, 2) })
```

---

## Runtime Usage

```lua
local FFR = require(RS.Packages.FigmaForgeRuntime)

local ui = FFR.Mount("UpdateLogModal", playerGui, {
    UpdateTitle = "⚡ v0.2 — Big Update!",
    TeaserLine = "🔥 COMING SOON: Trading!",
})

ui:SetList("BulletPoint", {
    "🧬 Mutation System: 8 new mutations",
    "⚔️ PvP Arena: 3v3 skill-based combat",
    "🏰 Clan Wars: Territory battles",
})

ui:OnClick("CloseBtn", function() ui:Hide() end)
ui:OnTab("TabSidebar", function(tabKey)
    -- tabKey = "v0_2" or "v0_1"
    loadContent(tabKey)
end)

ui:Show()
```
