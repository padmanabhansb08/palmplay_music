# CSS ARCHITECTURE AUDIT

## 1. File Forensics
The frontend styles are primarily split between two major CSS files:
- `style.css`: ~58.9 KB, ~2690 lines, ~350 selectors, 7 media queries, 30 custom variables.
- `palmplay-ux.css`: ~44.5 KB, ~2130 lines, ~320 selectors, 9 media queries, 4 custom variables.

**Observations:**
- `!important` usage is moderate (around 92 instances total across both files).
- Variable usage is somewhat disjointed, with 30 variables defined in `style.css` and 4 in `palmplay-ux.css`.

## 2. CSS Ownership Map

### Global Foundation
- Roots, typography (`body`, `h1`-`h6`), scrollbar resets, and base button utilities are predominantly stored in `style.css` under global contexts.
- Utility classes (e.g. text clamping, visual hidden) are scattered across both.

### Layout
- The core skeleton (`.sidebar`, `.main-content`, `#app-container`, `.bottom-nav`) lives in `style.css` with responsive tweaks scattered throughout both files.

### Components
- `palmplay-ux.css` heavily owns the UI components layer: `.card-desc`, `.meta-line`, modal overlays, player controls (`.player`), toast notifications, context menus.
- `style.css` retains older component definitions like `.genre-card`, specific Hero sections, and header modules.

### Page/View Specific
- `style.css` contains highly specific selectors for Library, Language, Mood, and Artist/Album specific layout grids.
- Search layout styles are mixed between the two files.

### Responsive Behavior
- Desktop/tablet/mobile toggling (e.g., hiding sidebar, showing bottom nav) is handled via `@media` queries mainly centered around max-width `1024px`, `768px`, and `480px`.

## 3. Duplication Audit
- `.track-card`, `.card-desc`, `.meta-line` properties are well-consolidated inside `palmplay-ux.css`. No egregious duplication was found for these elements.
- Typography classes show some overlap, with `font-size` declarations sometimes aggressively overriding inherited variables.

## 4. Dead CSS Audit
- **Dead:** `.lang-track-artist` inside `style.css` (orphaned by Track Card refactor).
- **Dead:** `.meta-sep` inside `palmplay-ux.css` (removed after inline bullet removal).
- Both selectors were classified as definitely dead and slated for removal.

## 5. CSS Variable Audit
- Variables focus heavily on theme colors (`--bg-base`, `--text-main`, `--text-subdued`), z-indexes, and spacing.
- **Findings:** A few hardcoded values (like `#121212` or `rgba(255,255,255,0.7)`) exist where theme variables should ideally be used. However, per the rules of this audit, we are merely documenting them, not redesigning.

## 6. Track Card Regression
- Track Cards conform strictly to the Level 4 DOM contract. `.card-desc` acts as a flex column.
- `.meta-line` (with `overflow: hidden`, `text-overflow: ellipsis`, `white-space: nowrap`) correctly contains long strings (Artist/Album) across both desktop and mobile viewports.
- No viewport breakage detected.

## 7. Responsive Forensics
- Breakpoints: Primarily `1024px` (tablet/desktop transition) and `768px` / `480px` (mobile transitions).
- Mobile layout successfully replaces the left sidebar with a fixed bottom navigation bar. Grids transition from `repeat(auto-fill, minmax(180px, 1fr))` to tighter `140px` blocks.

## 8. Overflow Audit
- Main layouts use `overflow-x: hidden` defensively (`.main-view`, `.content-wrapper`, `#main-content`).
- Grid templates use `minmax(..., 1fr)` preventing fixed-width overflow explosions.
- No viewport-breaking overflow was identified in the core UI.

## 9. Z-Index / Stacking Audit
- The stacking context follows a generally logical progression:
  - Base Layout: `z-index: 1` to `10`
  - Player/Header: `z-index: 50` to `100`
  - Overlays/Modals: `z-index: 1000+`
  - Toasts/Context Menus: `z-index: 9999`
- No severe stacking traps were discovered that required immediate intervention.

## 10. Animation Audit
- Animations are mostly lightweight transforms and opacity fades (`transition: all 0.2s ease`).
- No heavy JavaScript-driven style manipulation found for simple state changes.

## 11. Mobile Navigation
- Explore fragments have been completely expunged. Mobile bottom navigation actively tracks and routes to Home, Search, Library, and Player.
