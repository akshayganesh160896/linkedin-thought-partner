# LinkedIn Thought Partner — Progress Document

---

## Project Overview

A Chrome Extension (Manifest V3) that checks how original a LinkedIn post draft is before publishing.
The user pastes a draft, the extension extracts keywords with Gemini, searches LinkedIn via Serper,
scores originality with Gemini, and suggests rewrite angles. Built across 8 phases.

---

## Phases Completed

### Phase 1 — Project Scaffold
- Created the full folder structure and `manifest.json` (MV3)
- Set up `background/service-worker.js` (stub), `popup/popup.html`, `popup/popup.css`, `popup/popup.js`
- Added `icons/` (16, 48, 128px), `.gitignore`, placeholder `api/` and `utils/` modules
- Extension loads in Chrome with no errors

### Phase 2 — Settings Panel + API Key Storage
- Created `settings/settings.html`, `settings/settings.css`, `settings/settings.js`
- Created `utils/storage.js` — exports `saveKeys`, `loadKeys`, `clearKeys`, `hasRequiredKeys`
- Keys (`geminiApiKey`, `serperApiKey`) saved to `chrome.storage.local`
- Settings opens from popup gear icon; keys persist across sessions
- Status dot on gear button turns green when both keys are set

### Phase 3 — Keyword Extraction
- Created `api/gemini.js` — exports `callGemini`
- Created `utils/keywords.js` — exports `extractKeywords` (calls Gemini, returns 3–5 phrase array)
- Popup textarea added; Scan button calls `extractKeywords` and renders keyword pills
- Keyword pills are removable; `+ Add` pill lets user add custom keywords
- Time-window selector (24 h / 7 d / 30 d) added below pills
- Resolved API errors: switched from `gemini-2.0-flash` to `gemini-2.5-flash` on `v1beta`
- Added `thinkingConfig: { thinkingBudget: 0 }` to prevent thinking tokens consuming output budget

### Phase 4 — LinkedIn Search via Serper
- Created `api/serper.js` — exports `callSerper`
- Created `utils/search.js` — exports `buildQueries` and `runAllSearches`
- Queries formatted as `site:linkedin.com/posts "keyword" after:YYYY-MM-DD`
- All keyword searches fire in parallel with `Promise.all`
- Results deduplicated by URL using a `Map`
- Search results section renders cards with title, snippet, keyword label, and "Open post →" link

### Phase 5 — Originality Analysis
- Added `analyzeOriginality` to `api/gemini.js`
- Sends draft + up to 15 search results to Gemini; receives `{ score, repeated, suggestions }`
- Score displayed as a bar (1–10 scale, green/amber/red)
- Repeated angles shown as pills; 3 suggestion cards shown with title, explanation, new angle
- Fixed JSON parse error: Gemini was wrapping output in markdown fences — added cleanup regex

### Phase 6 — Post Rewrite
- Added `rewritePost` to `api/gemini.js`
- Each suggestion card has "Accept and rewrite" button; calls `rewritePost` with chosen suggestion
- Rewritten post shown in a read-only textarea with "Copy to clipboard" and "Try a different suggestion"
- "Start over" resets everything
- All suggestion buttons disabled while rewrite is running

### Phase 7 — Polish, Error Handling, UX
- Full error banner system: red (error), yellow (warning), green (success) — all auto-dismiss after 6s
- Loading state: button shows animated ellipsis + spinner; text updates between pipeline phases
- `revealSection()` added — double-rAF fade+slide animation for each result section
- Keys-missing warning banner with "Open settings" link
- LinkedIn tip banner when extension used on a non-LinkedIn page
- Panel footer: lock icon + "Keys stored locally" text + Reset button
- `README.md` rewritten with prerequisites table, setup steps, file structure, limitations

### Phase 8 — Permanent Persistent Sidebar (Complete UI Rebuild)
Replaced the popup entirely with a permanent sidebar injected into every page as a content script.

**Architecture changes:**
- Removed `default_popup` from `manifest.json` so `chrome.action.onClicked` fires in the service worker
- Added `content_scripts` block in `manifest.json` matching `http://*/*` and `https://*/*`
- Permissions changed to `["storage", "scripting", "tabs"]`
- `content/sidebar.js` — new ~1,000 line self-contained IIFE (no ES module imports)
- `content/sidebar.css` — new ~900 line stylesheet, all selectors scoped to `#loc-sidebar`

**Three-state sidebar machine:**
- `HIDDEN` (default) — nothing visible; no DOM elements injected
- `EXPANDED` (400px) — full sidebar visible; `document.body` gets `margin-right: 400px`
- `MINIMIZED` (40px) — only a thin blue tab visible; body margin removed
- State persisted in `chrome.storage.local` under key `loc_sidebar_state`
- Toolbar icon toggles HIDDEN ↔ EXPANDED only
- In-sidebar `—` button handles EXPANDED → MINIMIZED
- Clicking the blue tab expands back to EXPANDED

**Navigation persistence:**
- Full page reload: content script re-injects and reads saved state from storage
- SPA navigation: sidebar survives naturally (lives in DOM, not destroyed)
- `sessionStorage` stores last scan result under `loc_last_scan`
- "Showing your last scan" banner restores results after navigation
- "Open post →" uses `window.location.href` so sidebar re-injects on the destination page

**CSS isolation:**
- All classes prefixed `loc-`; all rules scoped to `#loc-sidebar` or `.loc-mini-tab`
- `z-index: 2147483647` (maximum) so sidebar floats above all page content
- `body.style.marginRight = '400px'` with fallback spacer div if host CSS overrides it

**Settings fix:**
- `openSettings()` sends `LOC_OPEN_SETTINGS` message to service worker
- Service worker calls `chrome.runtime.openOptionsPage()` — avoids ad-blocker blocks on `window.open()`

**SVG gauge (added during Phase 8 debug):**
- Replaced score bar with animated half-circle SVG gauge
- `renderGauge(score, container)` builds SVG inline; animates via `stroke-dashoffset` over 800ms
- Colours: score 1–3 = `#1D9E75` (green), 4–6 = `#EF9F27` (amber), 7–10 = `#E24B4A` (red)
- Second smaller estimated gauge shown after rewrite (projected score = `max(1, round(score × 0.4))`)

**JSON parsing fix:**
- Added `extractJsonObject(raw)` and `extractJsonArray(raw)` helpers
- Brace-walking algorithm finds first `{` / `[` and matching closer — tolerates any preamble text,
  markdown fences, or trailing explanation Gemini adds despite being told not to

---

## Current Known Issues

### 1. Gauge and suggestions section not appearing after scan
**Symptom:** Keyword pills and search result cards appear correctly, but the analysis section
(gauge + repeated angles + suggestion cards) does not render after the scan completes.

**Root cause identified:** `renderAnalysis()` was calling `q('loc-score-number').textContent`
and `q('loc-score-bar-fill').style.width` without null checks. If either element was not found
(timing edge case, or sidebar minimised mid-scan), a `TypeError` was thrown, caught silently by
the outer `catch` block, and shown only as "Something went wrong" — the analysis section
never appeared.

**Fix applied (in this session):**
- Replaced score bar with SVG gauge rendered by `renderGauge()` — no more `loc-score-bar-fill`
- All element lookups in `renderAnalysis()` now null-safe
- Added `showSection(id)` helper that wraps `q(id)` + double-rAF reveal — used everywhere
- Added `extractJsonObject` / `extractJsonArray` to handle Gemini's non-standard JSON wrapping

**Status:** Fix applied. Needs verification with a full scan run.

---

## Exact Fix Reference (sidebarEl scoping — already implemented as `q()`)

The spec called for a `sidebarEl(id)` helper function. The existing codebase already implements
this as `q(id)`:

```javascript
// Already exists in content/sidebar.js — Section 8
function q(id) {
  return sidebarEl ? sidebarEl.querySelector(`#${id}`) : null;
}
```

This scopes all queries to the `#loc-sidebar` element, preventing any collision with IDs used
by LinkedIn or other host pages. **No unscoped `document.getElementById()` calls exist in
`content/sidebar.js`** — the `q()` helper is used throughout.

The `showSection(id)` helper was added in the same session:

```javascript
function showSection(id) {
  const el = q(id);
  if (!el) return;
  el.hidden = false;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('loc-section-visible'));
  });
}
```

---

## Next Steps — Phase 9 Polish (to do after scan fix is confirmed)

Once a full scan run confirms gauge + suggestions render correctly, apply these polish items:

1. **Onboarding tooltip** — first-time users should see a brief tooltip on the blue tab explaining
   what the extension does, auto-dismissing after 5 seconds

2. **Scan history** — store the last 3 scans in `chrome.storage.local` with timestamp and score;
   show them in a collapsible "Recent scans" section at the bottom of the sidebar

3. **Character counter** on the draft textarea — show live character count; turn red below 80 chars

4. **Score explanation tooltip** — hovering the gauge number shows a one-line interpretation
   ("Your draft is highly repetitive — consider one of the angles below")

5. **Keyword editing UX** — allow inline editing of existing keyword pills (double-click to edit),
   not just remove + re-add

6. **Copy-to-LinkedIn button** — after a rewrite, offer a button that copies and opens
   `https://www.linkedin.com/feed/` in the same tab (sidebar persists)

7. **Empty state illustration** — when no scan has been run, show a subtle placeholder graphic
   and short instruction text instead of a blank body area

8. **Sidebar width toggle** — let users drag or toggle between 400px and 320px for smaller screens

---

## Full Folder Structure

```
linkedin-originality-checker/
│
├── manifest.json                  # MV3 manifest — no popup, content scripts registered here
│
├── background/
│   └── service-worker.js          # Handles toolbar click, LOC_OPEN_SETTINGS, install defaults
│
├── content/
│   ├── sidebar.js                 # ~1,050 line IIFE — full sidebar UI, state machine, scan pipeline
│   └── sidebar.css                # ~900 line stylesheet — all rules scoped to #loc-sidebar
│
├── settings/
│   ├── settings.html              # API key input form
│   ├── settings.css               # Settings page styles
│   ├── settings.js                # Reads/writes geminiApiKey + serperApiKey via storage.js
│   └── serve.py                   # Local dev server (unused in production)
│
├── popup/
│   ├── popup.html                 # Legacy popup UI (kept but no longer active — no default_popup)
│   ├── popup.css                  # Legacy popup styles
│   └── popup.js                   # Legacy popup logic (988 lines, ES modules)
│
├── api/
│   ├── gemini.js                  # callGemini, analyzeOriginality, rewritePost (ES module)
│   └── serper.js                  # callSerper (ES module)
│
├── utils/
│   ├── storage.js                 # saveKeys, loadKeys, clearKeys, hasRequiredKeys
│   ├── keywords.js                # extractKeywords
│   └── search.js                  # buildQueries, runAllSearches
│
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
│
├── PROGRESS.md                    # This file
├── README.md                      # User-facing setup and usage guide
└── .gitignore
```

---

## Key Technical Decisions (reference for future sessions)

| Decision | Reason |
|---|---|
| Content script IIFE — no ES module imports | Chrome doesn't support `import` in manifest-registered content scripts |
| `q(id)` scoped helper instead of `document.getElementById` | Prevents ID collisions with host page elements (especially on LinkedIn) |
| `chrome.storage.local` for sidebar state | Persists across full page reloads and browser restarts |
| `sessionStorage` for last scan results | Survives same-tab navigation; cleared on tab close |
| `chrome.runtime.openOptionsPage()` via service worker | Direct `window.open()` from content scripts is blocked by ad blockers |
| `extractJsonObject` brace-walker | Gemini adds preamble/fences despite instructions — regex cleanup was insufficient |
| `thinkingConfig: { thinkingBudget: 0 }` | Without this, `gemini-2.5-flash` thinking tokens consume `maxOutputTokens` budget |
| `gemini-2.5-flash` on `v1beta` | Only model+endpoint combination that works reliably on free AI Studio tier |
| Body `margin-right: 400px` with spacer fallback | Some pages use `!important` on body margin — spacer div is the reliable fallback |
| Minimized state skips full sidebar HTML | Keeps DOM lightweight when user just wants the sidebar out of the way |

---

## API Keys Required

| Key | Where to get | Storage key |
|---|---|---|
| Gemini API key | [aistudio.google.com](https://aistudio.google.com) — free tier | `geminiApiKey` |
| Serper API key | [serper.dev](https://serper.dev) — 2,500 free searches | `serperApiKey` |

Both stored in `chrome.storage.local` — never sent anywhere except the respective API endpoints.
