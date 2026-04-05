// ============================================================
// FILE: sidebar.js
// PURPOSE: Permanent injected sidebar panel. Runs as a content script
//          on every page. Reads its saved state from chrome.storage.local
//          and renders either the full sidebar, the minimized tab, or
//          nothing. Survives page navigation because it is re-injected
//          automatically by Chrome on every page load.
// DEPENDS ON: content/sidebar.css (injected via manifest)
//             chrome.storage.local, chrome.runtime
// USED BY: manifest.json content_scripts declaration
// ============================================================

// Guard against double injection — Chrome can sometimes inject a content
// script twice (e.g. manifest + programmatic). The flag prevents the
// sidebar being added to the DOM more than once per page.
if (window.__locSidebarInjected) {
  // Already running on this page — do nothing
} else {
  window.__locSidebarInjected = true;

  // Wrap everything in an IIFE so nothing leaks into the global scope of the
  // host page (avoids name collisions with LinkedIn's own JS globals).
  (function () {
    'use strict';

    // ============================================================
    // SECTION 1 — CONSTANTS
    // ============================================================

    // Storage key for the three-state sidebar machine
    const SIDEBAR_STATE_KEY = 'loc_sidebar_state';

    // Session storage key for restoring the last scan result after navigation
    const LAST_SCAN_KEY = 'loc_last_scan';

    const SIDEBAR_STATE = {
      HIDDEN:    'hidden',
      EXPANDED:  'expanded',
      MINIMIZED: 'minimized',
    };

    // Gemini API settings — mirrored from api/gemini.js
    // Content scripts cannot use ES module imports, so these are inlined.
    const GEMINI_MODEL   = 'gemini-2.5-flash';
    const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
    const MAX_TOKENS     = 2048;
    const TEMPERATURE    = 0.2;
    const THINKING_CFG   = { thinkingBudget: 0 };

    // Serper API base URL — mirrored from api/serper.js
    const SERPER_URL = 'https://google.serper.dev/search';


    // ============================================================
    // SECTION 2 — RUNTIME STATE
    // All mutable values live here — reset by resetAll()
    // ============================================================

    let currentState  = SIDEBAR_STATE.HIDDEN;  // current sidebar state
    let sidebarEl     = null;                  // #loc-sidebar element reference
    let miniTabEl     = null;                  // .loc-mini-tab element reference
    let spacerEl      = null;                  // fallback spacer div if body margin fails

    const scanState = {
      postText:       null,   // raw draft text
      keywords:       [],     // extracted keyword phrases
      searchResults:  [],     // deduplicated Serper results
      analysisResult: null,   // { score, repeated, suggestions }
      windowDays:     7,      // selected time window
      isLoading:      false,  // prevents concurrent scan runs
    };

    // Module-level timer handles — cleared/reset by notification helpers
    let _errorTimer   = null;
    let _warnTimer    = null;
    let _successTimer = null;
    let _ellipsisInt  = null;   // animated loading dots interval


    // ============================================================
    // SECTION 3 — STORAGE HELPERS
    // Thin wrappers around chrome.storage.local — inlined because
    // content scripts cannot import from utils/storage.js directly.
    // ============================================================

    // FUNCTION: loadKeys
    // WHAT IT DOES: Reads the Gemini and Serper API keys from storage
    // RECEIVES: nothing
    // RETURNS: Promise<{ gemini: string|null, serper: string|null }>
    async function loadKeys() {
      const result = await chrome.storage.local.get(['geminiApiKey', 'serperApiKey']);
      return {
        gemini: result.geminiApiKey ?? null,
        serper: result.serperApiKey ?? null,
      };
    }

    // FUNCTION: hasRequiredKeys
    // WHAT IT DOES: Returns true only when both keys are non-empty strings
    // RECEIVES: keys (object) — { gemini, serper }
    // RETURNS: boolean
    function hasRequiredKeys({ gemini, serper }) {
      return (
        typeof gemini === 'string' && gemini.trim().length > 0 &&
        typeof serper === 'string' && serper.trim().length > 0
      );
    }

    // FUNCTION: saveSidebarState
    // WHAT IT DOES: Persists the current sidebar state to chrome.storage.local
    //               so it survives page reloads and browser restarts.
    //               Wrapped in try/catch to silently handle "Extension context
    //               invalidated" — thrown when the extension is reloaded while
    //               a content script is still running on an open tab.
    // RECEIVES: state (string) — one of SIDEBAR_STATE values
    // RETURNS: Promise<void>
    async function saveSidebarState(state) {
      try {
        await chrome.storage.local.set({ [SIDEBAR_STATE_KEY]: state });
      } catch {
        // Extension context invalidated — extension was reloaded mid-session.
        // The state will be re-read correctly when the tab is next refreshed.
      }
    }


    // ============================================================
    // SECTION 4 — API HELPERS (inlined from api/gemini.js and api/serper.js)
    // Content scripts can fetch to URLs listed in host_permissions without
    // CORS issues. These functions mirror the popup's API modules exactly.
    // ============================================================

    // FUNCTION: callGemini
    // WHAT IT DOES: POSTs a prompt to the Gemini generateContent endpoint
    // RECEIVES: prompt (string), apiKey (string)
    // RETURNS: Promise<string> — the generated text
    async function callGemini(prompt, apiKey) {
      const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: MAX_TOKENS,
          temperature: TEMPERATURE,
          thinkingConfig: THINKING_CFG,
        },
      };

      const response = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        const errMsg  = errJson?.error?.message || response.statusText;
        throw new Error(`callGemini: request failed with status ${response.status} — ${errMsg}`);
      }

      const json = await response.json();
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('callGemini: response did not contain any generated text');
      return text;
    }

    // FUNCTION: callSerper
    // WHAT IT DOES: POSTs a search query to the Serper API and returns results
    // RECEIVES: query (string), apiKey (string)
    // RETURNS: Promise<Array<{ title, snippet, link }>>
    async function callSerper(query, apiKey) {
      const response = await fetch(SERPER_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
        body:    JSON.stringify({ q: query, num: 10 }),
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        const errMsg  = errJson?.message || response.statusText;
        throw new Error(`callSerper: request failed with status ${response.status} — ${errMsg}`);
      }

      const json    = await response.json();
      const organic = json.organic ?? [];
      return organic.map(r => ({
        title:   r.title   || '',
        snippet: r.snippet || '',
        link:    r.link    || '',
      }));
    }


    // ============================================================
    // SECTION 5 — KEYWORD & SEARCH UTILITIES
    // Inlined from utils/keywords.js and utils/search.js
    // ============================================================

    // FUNCTION: extractJsonObject
    // WHAT IT DOES: Robustly pulls a JSON object out of a raw Gemini response.
    //               Gemini sometimes wraps JSON in markdown fences, adds preamble
    //               text ("Here is the analysis:"), or appends explanations even
    //               when told not to. This function finds the first { and the
    //               matching closing } to extract only the object, then parses it.
    // RECEIVES: raw (string) — the raw text returned by callGemini
    // RETURNS: parsed object
    // THROWS: Error if no valid JSON object is found
    function extractJsonObject(raw) {
      // Step 1 — strip markdown code fences of any flavour
      const stripped = raw.replace(/```[\w]*\n?/g, '').trim();

      // Step 2 — find the first { and walk forward tracking brace depth
      //          to find the exactly matching }. This tolerates any text
      //          before or after the JSON object.
      const start = stripped.indexOf('{');
      if (start === -1) throw new Error('no JSON object found in Gemini response');

      let depth = 0;
      let end   = -1;
      for (let i = start; i < stripped.length; i++) {
        if (stripped[i] === '{') depth++;
        else if (stripped[i] === '}') {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }

      if (end === -1) throw new Error('unmatched braces in Gemini response');

      return JSON.parse(stripped.slice(start, end + 1));
    }

    // FUNCTION: extractJsonArray
    // WHAT IT DOES: Same as extractJsonObject but for top-level JSON arrays.
    //               Used by extractKeywords which expects an array back.
    // RECEIVES: raw (string) — the raw text returned by callGemini
    // RETURNS: parsed array
    // THROWS: Error if no valid JSON array is found
    function extractJsonArray(raw) {
      const stripped = raw.replace(/```[\w]*\n?/g, '').trim();

      const start = stripped.indexOf('[');
      if (start === -1) throw new Error('no JSON array found in Gemini response');

      let depth = 0;
      let end   = -1;
      for (let i = start; i < stripped.length; i++) {
        if (stripped[i] === '[') depth++;
        else if (stripped[i] === ']') {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }

      if (end === -1) throw new Error('unmatched brackets in Gemini response');

      return JSON.parse(stripped.slice(start, end + 1));
    }

    // FUNCTION: extractKeywords
    // WHAT IT DOES: Sends the draft to Gemini and parses back a JSON array
    //               of 3–5 keyword phrases for use in the Serper search.
    // RECEIVES: draftText (string), apiKey (string)
    // RETURNS: Promise<string[]>
    async function extractKeywords(draftText, apiKey) {
      const prompt = [
        'Extract the 3 to 5 most important keyword phrases from this LinkedIn post draft.',
        'Return ONLY a valid JSON array of strings — no markdown, no explanation.',
        'Each phrase should be 2 to 4 words. Focus on the core topic and unique angles.\n\n',
        draftText,
      ].join(' ');

      const raw = await callGemini(prompt, apiKey);

      try {
        const keywords = extractJsonArray(raw);
        if (!Array.isArray(keywords)) throw new Error('not an array');
        return keywords.slice(0, 5);
      } catch {
        // Fallback: split on common delimiters and take the longest words
        return draftText
          .split(/\s+/)
          .filter(w => w.length > 5)
          .slice(0, 5)
          .map(w => w.replace(/[^a-zA-Z0-9 ]/g, ''));
      }
    }

    // FUNCTION: buildQueries
    // WHAT IT DOES: Converts keywords into LinkedIn-scoped date-filtered queries
    // RECEIVES: keywords (string[]), windowDays (number)
    // RETURNS: string[]
    function buildQueries(keywords, windowDays) {
      const cutoff  = new Date();
      cutoff.setDate(cutoff.getDate() - windowDays);
      const dateStr = cutoff.toISOString().split('T')[0];
      return keywords.map(kw => `site:linkedin.com/posts "${kw}" after:${dateStr}`);
    }

    // FUNCTION: runAllSearches
    // WHAT IT DOES: Fires all keyword searches in parallel and deduplicates by URL
    // RECEIVES: keywords (string[]), windowDays (number), serperApiKey (string)
    // RETURNS: Promise<Array<{ title, snippet, link }>>
    async function runAllSearches(keywords, windowDays, serperApiKey) {
      const queries     = buildQueries(keywords, windowDays);
      const resultArrays = await Promise.all(queries.map(q => callSerper(q, serperApiKey)));
      const flat        = resultArrays.flat();
      const seen        = new Map();
      for (const r of flat) {
        if (r.link && !seen.has(r.link)) seen.set(r.link, r);
      }
      return Array.from(seen.values());
    }

    // FUNCTION: analyzeOriginality
    // WHAT IT DOES: Sends draft + search results to Gemini for structured analysis
    // RECEIVES: draftText (string), searchResults (object[]), apiKey (string)
    // RETURNS: Promise<{ score, repeated, suggestions }>
    async function analyzeOriginality(draftText, searchResults, apiKey) {
      const capped = searchResults.slice(0, 15);
      const resultLines = capped.length > 0
        ? capped.map((r, i) => `${i + 1}. ${r.title} — ${r.snippet}`).join('\n')
        : '(No recent LinkedIn posts found on this topic)';

      const prompt = [
        `Here is a LinkedIn post draft the user wants to publish:\n\n${draftText}`,
        `\n\nHere are recent public LinkedIn posts on the same topic:\n\n${resultLines}`,
        '\n\nAnalyse how repetitive this draft is. Return ONLY valid JSON — no markdown, no explanation:',
        '\n{ "score": <1–10 where 1=highly original, 10=extremely repetitive>,',
        ' "repeated": <array of 2–4 short strings of already-common angles>,',
        ' "suggestions": <array of exactly 3 objects each with { "title": <≤6 words>, "explanation": <one sentence>, "newAngle": <one sentence> }> }',
      ].join('');

      const raw = await callGemini(prompt, apiKey);

      try {
        return extractJsonObject(raw);
      } catch (parseErr) {
        throw new Error(
          `analyzeOriginality: failed to parse Gemini response as JSON — ${parseErr.message}. Raw: ${raw.slice(0, 200)}`
        );
      }
    }

    // FUNCTION: rewritePost
    // WHAT IT DOES: Asks Gemini to rewrite the draft using the chosen suggestion angle
    // RECEIVES: originalDraft (string), chosenSuggestion (object), apiKey (string)
    // RETURNS: Promise<string> — the rewritten post text
    async function rewritePost(originalDraft, chosenSuggestion, apiKey) {
      const prompt = [
        `Here is the original LinkedIn post draft:\n\n${originalDraft}`,
        `\n\nThe user has chosen this direction to make it more original:`,
        `\nTitle: ${chosenSuggestion.title}`,
        `\nNew angle: ${chosenSuggestion.newAngle}`,
        `\nExplanation: ${chosenSuggestion.explanation}`,
        '\n\nRewrite the post using this new angle. Rules: keep the author\'s original voice and tone,',
        ' keep roughly the same length, do not add hashtags unless the original had them,',
        ' do not start with I, do not use corporate buzzwords like synergy or leverage,',
        ' return only the finished post text with no explanation, no preamble, no label',
        ' — just the rewritten post ready to copy and paste.',
      ].join('');

      const raw     = await callGemini(prompt, apiKey);
      const cleaned = raw.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
      if (!cleaned) throw new Error('rewritePost: Gemini returned an empty response — try again');
      return cleaned;
    }


    // ============================================================
    // SECTION 6 — PAGE MARGIN MANAGEMENT
    // We apply margin-right to document.body rather than a LinkedIn-specific
    // container because the sidebar works on any webpage, not just LinkedIn.
    // body is the safest universal target across all sites.
    // ============================================================

    // FUNCTION: applyPageMargin
    // WHAT IT DOES: Adds 400px right margin to body so page content is not
    //               hidden behind the expanded sidebar. Falls back to a spacer
    //               div if the margin is overridden by the page's own CSS.
    // RECEIVES: nothing
    // RETURNS: nothing
    function applyPageMargin() {
      document.body.style.transition  = 'margin-right 220ms ease';
      document.body.style.marginRight = '400px';

      // Verify the margin was actually applied — some pages override body margin
      // via their own CSS with higher specificity and we cannot win that fight.
      const applied = getComputedStyle(document.body).marginRight;
      if (applied !== '400px') {
        injectSpacerDiv();
      }
    }

    // FUNCTION: removePageMargin
    // WHAT IT DOES: Removes the 400px right margin when the sidebar is minimized or hidden
    // RECEIVES: nothing
    // RETURNS: nothing
    function removePageMargin() {
      document.body.style.transition  = 'margin-right 220ms ease';
      document.body.style.marginRight = '';
      removeSpacerDiv();
    }

    // FUNCTION: injectSpacerDiv
    // WHAT IT DOES: Fallback for pages whose CSS blocks the body margin approach.
    //               Inserts a fixed-width div at the right edge of the body.
    // RECEIVES: nothing
    // RETURNS: nothing
    function injectSpacerDiv() {
      if (spacerEl) return;
      spacerEl = document.createElement('div');
      spacerEl.id = 'loc-page-spacer';
      spacerEl.style.cssText = [
        'position:fixed',
        'top:0',
        'right:0',
        'width:400px',
        'height:100vh',
        'pointer-events:none',
        'z-index:2147483646',
      ].join(';');
      document.body.appendChild(spacerEl);
    }

    // FUNCTION: removeSpacerDiv
    // WHAT IT DOES: Removes the spacer div if it was injected
    // RECEIVES: nothing
    // RETURNS: nothing
    function removeSpacerDiv() {
      if (spacerEl) {
        spacerEl.remove();
        spacerEl = null;
      }
    }


    // ============================================================
    // SECTION 7 — SIDEBAR HTML CONSTRUCTION
    // Builds and returns the full sidebar DOM element.
    // Only called when transitioning to EXPANDED — not in MINIMIZED
    // state, which keeps the DOM lightweight (performance note below).
    //
    // PERFORMANCE NOTE:
    // In MINIMIZED state we only inject the 40px tab div, not the full UI.
    // The full sidebar HTML is only built and inserted when EXPANDED.
    // This avoids unnecessary DOM weight on pages where the user just
    // wants the sidebar out of the way temporarily.
    // ============================================================

    // FUNCTION: buildSidebarHTML
    // WHAT IT DOES: Creates and returns the complete #loc-sidebar element with
    //               all sub-sections built programmatically (no innerHTML template)
    // RECEIVES: nothing
    // RETURNS: HTMLElement — the sidebar root div
    function buildSidebarHTML() {
      const sidebar = document.createElement('div');
      sidebar.id = 'loc-sidebar';
      sidebar.classList.add('loc-expanded');

      // ── Header ────────────────────────────────────────────────────────────────
      const header = document.createElement('div');
      header.className = 'loc-header';

      const title = document.createElement('span');
      title.className = 'loc-header__title';
      title.textContent = 'Thought Partner';

      const controls = document.createElement('div');
      controls.className = 'loc-header__controls';

      // Minimize button (—)
      const btnMinimize = document.createElement('button');
      btnMinimize.className = 'loc-header__btn';
      btnMinimize.id        = 'loc-btn-minimize';
      btnMinimize.title     = 'Minimize sidebar';
      btnMinimize.textContent = '—';

      // Settings button (⚙)
      const btnSettings = document.createElement('button');
      btnSettings.className = 'loc-header__btn';
      btnSettings.id        = 'loc-btn-settings';
      btnSettings.title     = 'Settings';
      btnSettings.innerHTML = '&#9881;';

      // Status dot (coloured by init checks below)
      const dot = document.createElement('span');
      dot.className = 'loc-key-status-dot';
      dot.id        = 'loc-key-status-dot';
      btnSettings.appendChild(dot);

      controls.appendChild(btnMinimize);
      controls.appendChild(btnSettings);
      header.appendChild(title);
      header.appendChild(controls);

      // ── Scrollable body ───────────────────────────────────────────────────────
      const body = document.createElement('div');
      body.id = 'loc-sidebar-body';

      // "Last scan" banner — hidden until session state is restored
      const lastScanBanner = document.createElement('div');
      lastScanBanner.className = 'loc-last-scan-banner';
      lastScanBanner.id        = 'loc-last-scan-banner';
      lastScanBanner.hidden    = true;

      const lastScanMsg = document.createElement('span');
      lastScanMsg.textContent = 'Showing your last scan';

      const lastScanDismiss = document.createElement('button');
      lastScanDismiss.className   = 'loc-last-scan-banner__dismiss';
      lastScanDismiss.textContent = '×';
      lastScanDismiss.title       = 'Dismiss';

      lastScanBanner.appendChild(lastScanMsg);
      lastScanBanner.appendChild(lastScanDismiss);

      // Keys-missing warning banner
      const keysWarning = document.createElement('div');
      keysWarning.className = 'loc-banner loc-banner--warning';
      keysWarning.id        = 'loc-keys-warning';
      keysWarning.hidden    = true;
      keysWarning.innerHTML = '⚠ API keys not set — <a id="loc-open-settings-link" href="#">Open settings</a> to configure.';

      // Error banner
      const errBanner = makeBanner('loc-banner--error',   'loc-error-banner',   'loc-error-message',   'loc-dismiss-error');
      // Warning banner
      const wrnBanner = makeBanner('loc-banner--warning', 'loc-warn-banner',    'loc-warn-message',    'loc-dismiss-warn');
      // Success banner
      const sucBanner = makeBanner('loc-banner--success', 'loc-success-banner', 'loc-success-message', 'loc-dismiss-success');

      // Draft section
      const draftSection = document.createElement('section');
      draftSection.className = 'loc-draft-section';

      const draftLabel = document.createElement('label');
      draftLabel.className  = 'loc-draft-section__label';
      draftLabel.htmlFor    = 'loc-draft-input';
      draftLabel.textContent = 'Paste your LinkedIn draft';

      const draftTA = document.createElement('textarea');
      draftTA.className   = 'loc-draft-section__textarea';
      draftTA.id          = 'loc-draft-input';
      draftTA.placeholder = 'Paste your post here to check its originality…';
      draftTA.rows        = 5;
      draftTA.spellcheck  = false;

      draftSection.appendChild(draftLabel);
      draftSection.appendChild(draftTA);

      // Action area
      const actionArea = document.createElement('section');
      actionArea.className = 'loc-action-area';

      const btnCheck = document.createElement('button');
      btnCheck.className   = 'loc-btn-check';
      btnCheck.id          = 'loc-btn-check';
      btnCheck.disabled    = true;
      btnCheck.textContent = 'Scan';
      actionArea.appendChild(btnCheck);

      // Keywords section (hidden until extraction succeeds)
      const kwSection = document.createElement('section');
      kwSection.className = 'loc-keywords-section loc-animatable';
      kwSection.id        = 'loc-keywords-section';
      kwSection.hidden    = true;

      const kwHeading = document.createElement('h2');
      kwHeading.className   = 'loc-keywords-section__heading';
      kwHeading.textContent = 'Keywords';

      const kwPills = document.createElement('div');
      kwPills.className = 'loc-keywords-section__pills';
      kwPills.id        = 'loc-keywords-pills';

      const timeWindow = buildTimeWindowEl();

      kwSection.appendChild(kwHeading);
      kwSection.appendChild(kwPills);
      kwSection.appendChild(timeWindow);

      // Search results section (hidden until search phase)
      const srSection = document.createElement('section');
      srSection.className = 'loc-search-results-section loc-animatable';
      srSection.id        = 'loc-search-results-section';
      srSection.hidden    = true;

      // Search status line
      const srStatus = document.createElement('p');
      srStatus.className = 'loc-search-status';
      srStatus.id        = 'loc-search-status';
      srStatus.hidden    = true;

      // Analysis section (hidden until analysis phase)
      const analysisSection = document.createElement('section');
      analysisSection.className = 'loc-analysis-section loc-animatable';
      analysisSection.id        = 'loc-analysis-section';
      analysisSection.hidden    = true;

      const scoreDiv = document.createElement('div');
      scoreDiv.className = 'loc-analysis-score';

      // Gauge container — SVG is built dynamically by renderGauge() when
      // analysis completes. Keeping it empty here avoids layout shifts.
      const gaugeContainer = document.createElement('div');
      gaugeContainer.className = 'loc-gauge-container';
      gaugeContainer.id        = 'loc-gauge-container';

      scoreDiv.appendChild(gaugeContainer);

      const repeatedHeading = document.createElement('h2');
      repeatedHeading.className   = 'loc-analysis-heading';
      repeatedHeading.textContent = "What's already been said";

      const repeatedList = document.createElement('ul');
      repeatedList.className = 'loc-repeated-list';
      repeatedList.id        = 'loc-repeated-list';

      const suggestionsHeading = document.createElement('h2');
      suggestionsHeading.className   = 'loc-analysis-heading';
      suggestionsHeading.textContent = 'Ways to stand out';

      const suggestionsList = document.createElement('div');
      suggestionsList.className = 'loc-suggestions-list';
      suggestionsList.id        = 'loc-suggestions-list';

      analysisSection.appendChild(scoreDiv);
      analysisSection.appendChild(repeatedHeading);
      analysisSection.appendChild(repeatedList);
      analysisSection.appendChild(suggestionsHeading);
      analysisSection.appendChild(suggestionsList);

      // Rewrite output section (hidden until rewrite runs)
      const rewriteSection = document.createElement('section');
      rewriteSection.className = 'loc-rewrite-output-section loc-animatable';
      rewriteSection.id        = 'loc-rewrite-output-section';
      rewriteSection.hidden    = true;

      // Footer
      const footer = document.createElement('div');
      footer.className = 'loc-panel-footer';

      const footerLeft = document.createElement('span');
      footerLeft.className = 'loc-panel-footer__left';
      footerLeft.innerHTML = `
        <svg width="11" height="13" viewBox="0 0 11 13" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <rect x="1" y="5.5" width="9" height="7" rx="1.5" stroke="#aaa" stroke-width="1.4"/>
          <path d="M3 5.5V3.5a2.5 2.5 0 0 1 5 0v2" stroke="#aaa" stroke-width="1.4" stroke-linecap="round"/>
        </svg>
        Keys stored locally`;

      const footerReset = document.createElement('button');
      footerReset.className   = 'loc-panel-footer__reset';
      footerReset.id          = 'loc-btn-footer-reset';
      footerReset.textContent = 'Reset';

      footer.appendChild(footerLeft);
      footer.appendChild(footerReset);

      // Assemble body
      body.appendChild(lastScanBanner);
      body.appendChild(keysWarning);
      body.appendChild(errBanner);
      body.appendChild(wrnBanner);
      body.appendChild(sucBanner);
      body.appendChild(draftSection);
      body.appendChild(actionArea);
      body.appendChild(kwSection);
      body.appendChild(srSection);
      body.appendChild(srStatus);
      body.appendChild(analysisSection);
      body.appendChild(rewriteSection);

      sidebar.appendChild(header);
      sidebar.appendChild(body);
      sidebar.appendChild(footer);

      return sidebar;
    }

    // FUNCTION: makeBanner
    // WHAT IT DOES: Creates a reusable notification banner element
    // RECEIVES: colourClass, id, messageId, dismissId (all strings)
    // RETURNS: HTMLElement
    function makeBanner(colourClass, id, messageId, dismissId) {
      const el = document.createElement('div');
      el.className = `loc-banner ${colourClass}`;
      el.id        = id;
      el.hidden    = true;

      const msg = document.createElement('span');
      msg.className = 'loc-banner__message';
      msg.id        = messageId;

      const btn = document.createElement('button');
      btn.className   = 'loc-banner__dismiss';
      btn.id          = dismissId;
      btn.textContent = '×';
      btn.title       = 'Dismiss';

      el.appendChild(msg);
      el.appendChild(btn);
      return el;
    }

    // FUNCTION: buildTimeWindowEl
    // WHAT IT DOES: Creates the 24h / 7d / 30d time window toggle row
    // RECEIVES: nothing
    // RETURNS: HTMLElement
    function buildTimeWindowEl() {
      const wrap = document.createElement('div');
      wrap.className = 'loc-time-window';

      const lbl = document.createElement('span');
      lbl.className   = 'loc-time-window__label';
      lbl.textContent = 'Search within:';

      const btns = document.createElement('div');
      btns.className = 'loc-time-window__buttons';

      [[1, '24 hours'], [7, '7 days'], [30, '30 days']].forEach(([days, label]) => {
        const btn = document.createElement('button');
        btn.className       = 'loc-time-window__btn' + (days === 7 ? ' loc-time-window__btn--active' : '');
        btn.dataset.days    = days;
        btn.textContent     = label;
        btns.appendChild(btn);
      });

      wrap.appendChild(lbl);
      wrap.appendChild(btns);
      return wrap;
    }

    // FUNCTION: buildMiniTab
    // WHAT IT DOES: Creates the 40px blue minimized tab element
    // RECEIVES: nothing
    // RETURNS: HTMLElement
    function buildMiniTab() {
      const tab = document.createElement('div');
      tab.className = 'loc-mini-tab';

      const arrow = document.createElement('span');
      arrow.className   = 'loc-mini-tab__arrow';
      arrow.textContent = '→';

      const label = document.createElement('span');
      label.className   = 'loc-mini-tab__label';
      label.textContent = 'Thought Partner';

      tab.appendChild(arrow);
      tab.appendChild(label);
      return tab;
    }


    // ============================================================
    // SECTION 8 — DOM REFERENCE HELPER
    // After sidebarEl is in the DOM, use this to query children
    // by ID without relying on the global document (avoids conflicts
    // with the host page's own IDs).
    // ============================================================

    // FUNCTION: q
    // WHAT IT DOES: Queries a child of the sidebar by id
    // RECEIVES: id (string) — element id without #
    // RETURNS: HTMLElement | null
    function q(id) {
      return sidebarEl ? sidebarEl.querySelector(`#${id}`) : null;
    }

    // FUNCTION: qAll
    // WHAT IT DOES: Queries all children matching a selector within the sidebar
    // RECEIVES: selector (string)
    // RETURNS: NodeList
    function qAll(selector) {
      return sidebarEl ? sidebarEl.querySelectorAll(selector) : [];
    }

    // FUNCTION: showSection
    // WHAT IT DOES: Un-hides a sidebar section and triggers its fade-in transition.
    //               Uses double-rAF so the browser registers the initial hidden state
    //               before the visible class is added — required for CSS transition to fire.
    //               Null-safe: does nothing if the element is not found.
    // RECEIVES: id (string) — the element ID (without #) to reveal
    // RETURNS: nothing
    function showSection(id) {
      const el = q(id);
      if (!el) return;
      el.hidden = false;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => el.classList.add('loc-section-visible'));
      });
    }


    // ============================================================
    // SECTION 9 — STATE MACHINE
    // Controls transitions between HIDDEN, EXPANDED, and MINIMIZED.
    //
    // SIDEBAR PERSISTENCE STRATEGY:
    // Full page reloads: content script re-injects on every page,
    //   reads saved state from chrome.storage.local and restores UI
    // SPA navigation (LinkedIn, etc): sidebar survives naturally
    //   because it lives in the page DOM and is not destroyed
    // Minimized state: only the 40px tab is injected, full UI is not
    //   rendered until the user expands — keeps page performance light
    // ============================================================

    // FUNCTION: applyState
    // WHAT IT DOES: Transitions the sidebar to the requested state,
    //               injecting or removing DOM elements as needed.
    //               Saves the new state to storage so it persists.
    // RECEIVES: newState (string) — one of SIDEBAR_STATE values
    //           opts (object) — { save: boolean } — default true
    // RETURNS: Promise<void>
    async function applyState(newState, opts = { save: true }) {
      const prev    = currentState;
      currentState = newState;

      if (opts.save) await saveSidebarState(newState);

      if (newState === SIDEBAR_STATE.HIDDEN) {
        _removeFullSidebar();
        _removeMiniTab();
        removePageMargin();

      } else if (newState === SIDEBAR_STATE.EXPANDED) {
        _removeMiniTab();
        if (!sidebarEl) {
          _injectFullSidebar();
          wireEvents();
          await runStartupChecks();
        }
        // Restore last scan from session storage if coming from a navigation
        if (prev !== SIDEBAR_STATE.EXPANDED) {
          tryRestoreLastScan();
        }
        applyPageMargin();

      } else if (newState === SIDEBAR_STATE.MINIMIZED) {
        _removeFullSidebar();
        if (!miniTabEl) _injectMiniTab();
        removePageMargin();
      }
    }

    // FUNCTION: _injectFullSidebar
    // WHAT IT DOES: Builds and appends the full sidebar to document.body
    // RECEIVES: nothing
    // RETURNS: nothing
    function _injectFullSidebar() {
      sidebarEl = buildSidebarHTML();
      document.body.appendChild(sidebarEl);
    }

    // FUNCTION: _removeFullSidebar
    // WHAT IT DOES: Removes the full sidebar from the DOM and clears the reference
    // RECEIVES: nothing
    // RETURNS: nothing
    function _removeFullSidebar() {
      if (sidebarEl) { sidebarEl.remove(); sidebarEl = null; }
    }

    // FUNCTION: _injectMiniTab
    // WHAT IT DOES: Builds and appends the minimized 40px tab to document.body
    // RECEIVES: nothing
    // RETURNS: nothing
    function _injectMiniTab() {
      miniTabEl = buildMiniTab();
      miniTabEl.addEventListener('click', () => applyState(SIDEBAR_STATE.EXPANDED));
      document.body.appendChild(miniTabEl);
    }

    // FUNCTION: _removeMiniTab
    // WHAT IT DOES: Removes the mini tab from the DOM and clears the reference
    // RECEIVES: nothing
    // RETURNS: nothing
    function _removeMiniTab() {
      if (miniTabEl) { miniTabEl.remove(); miniTabEl = null; }
    }


    // ============================================================
    // SECTION 10 — EVENT WIRING
    // Called once after the sidebar HTML is injected into the DOM.
    // ============================================================

    // FUNCTION: wireEvents
    // WHAT IT DOES: Attaches all click and keyboard listeners to sidebar elements
    // RECEIVES: nothing
    // RETURNS: nothing
    function wireEvents() {
      // Header controls
      q('loc-btn-minimize').addEventListener('click', () => applyState(SIDEBAR_STATE.MINIMIZED));
      q('loc-btn-settings').addEventListener('click', openSettings);
      q('loc-btn-footer-reset').addEventListener('click', resetAll);

      // "Open settings" link in keys-warning banner
      const openLink = sidebarEl.querySelector('#loc-open-settings-link');
      if (openLink) openLink.addEventListener('click', e => { e.preventDefault(); openSettings(); });

      // Dismiss buttons for all three notification banners
      q('loc-dismiss-error').addEventListener('click',   () => { q('loc-error-banner').hidden   = true; });
      q('loc-dismiss-warn').addEventListener('click',    () => { q('loc-warn-banner').hidden    = true; });
      q('loc-dismiss-success').addEventListener('click', () => { q('loc-success-banner').hidden = true; });

      // Last-scan banner dismiss
      const lsDismiss = q('loc-last-scan-banner').querySelector('.loc-last-scan-banner__dismiss');
      if (lsDismiss) lsDismiss.addEventListener('click', () => { q('loc-last-scan-banner').hidden = true; });

      // Scan button
      q('loc-btn-check').addEventListener('click', handleCheckClick);

      // Time window buttons (event delegation on the container)
      sidebarEl.querySelector('.loc-time-window__buttons').addEventListener('click', handleTimeWindowClick);
    }

    // FUNCTION: openSettings
    // WHAT IT DOES: Asks the service worker to open the settings page.
    //               openOptionsPage() must be called from a background context —
    //               calling it directly from a content script is unreliable.
    //               Sending a message to the service worker is the correct approach.
    // RECEIVES: nothing
    // RETURNS: nothing
    function openSettings() {
      // The no-op callback suppresses Chrome's "Unchecked runtime.lastError"
      // warning that fires when sendMessage gets no response from the service worker.
      chrome.runtime.sendMessage({ type: 'LOC_OPEN_SETTINGS' }, () => {
        void chrome.runtime.lastError;
      });
    }


    // ============================================================
    // SECTION 11 — STARTUP CHECKS
    // Run once after the sidebar is injected — checks API keys and
    // whether the current page is on linkedin.com.
    // ============================================================

    // FUNCTION: runStartupChecks
    // WHAT IT DOES: Reads stored keys, colours the status dot, shows/hides
    //               the keys-warning banner, enables the Scan button, and
    //               shows the LinkedIn tip if not on linkedin.com.
    // RECEIVES: nothing
    // RETURNS: Promise<void>
    async function runStartupChecks() {
      const keys = await loadKeys();
      const dot  = q('loc-key-status-dot');

      if (hasRequiredKeys(keys)) {
        dot.classList.add('loc-key-status-dot--green');
        q('loc-keys-warning').hidden  = true;
        q('loc-btn-check').disabled   = false;
      } else {
        dot.classList.add('loc-key-status-dot--yellow');
        q('loc-keys-warning').hidden  = false;
        q('loc-btn-check').disabled   = true;
      }

      // Show info tip if not on linkedin.com — content scripts know the current
      // URL directly via window.location, no chrome.tabs.query needed
      if (!window.location.href.includes('linkedin.com')) {
        showBanner('loc-warn-banner', 'loc-warn-message',
          'Tip: open this extension while browsing LinkedIn for the best experience');
      }
    }


    // ============================================================
    // SECTION 12 — SESSION STATE (save & restore last scan)
    // Scan results are saved to sessionStorage so they survive
    // in-tab navigation (sessionStorage persists across same-tab loads).
    // ============================================================

    // FUNCTION: saveLastScan
    // WHAT IT DOES: Serialises the current scan result to sessionStorage
    //               so it can be restored after the user navigates away and back
    // RECEIVES: nothing
    // RETURNS: nothing
    function saveLastScan() {
      const snapshot = {
        postText:       scanState.postText,
        keywords:       scanState.keywords,
        searchResults:  scanState.searchResults,
        analysisResult: scanState.analysisResult,
        windowDays:     scanState.windowDays,
      };
      try {
        sessionStorage.setItem(LAST_SCAN_KEY, JSON.stringify(snapshot));
      } catch {
        // sessionStorage can be blocked by some browsers — fail silently
      }
    }

    // FUNCTION: tryRestoreLastScan
    // WHAT IT DOES: Reads the last scan snapshot from sessionStorage and,
    //               if present, re-renders it with a "Showing your last scan" banner.
    // RECEIVES: nothing
    // RETURNS: nothing
    function tryRestoreLastScan() {
      try {
        const raw = sessionStorage.getItem(LAST_SCAN_KEY);
        if (!raw) return;
        const snap = JSON.parse(raw);
        if (!snap || !snap.analysisResult) return;

        // Restore state variables
        scanState.postText       = snap.postText;
        scanState.keywords       = snap.keywords || [];
        scanState.searchResults  = snap.searchResults || [];
        scanState.analysisResult = snap.analysisResult;
        scanState.windowDays     = snap.windowDays || 7;

        // Restore the draft textarea
        const ta = q('loc-draft-input');
        if (ta && snap.postText) ta.value = snap.postText;

        // Re-render all result sections (no animation needed for restores)
        if (scanState.keywords.length) renderKeywords(scanState.keywords, false);
        if (scanState.searchResults.length) renderSearchResults(scanState.searchResults);
        renderSearchStatus(scanState.searchResults, scanState.keywords.length);
        renderAnalysis(scanState.analysisResult);

        // Show the "last scan" banner
        q('loc-last-scan-banner').hidden = false;

      } catch {
        // Corrupted session data — ignore and start fresh
        sessionStorage.removeItem(LAST_SCAN_KEY);
      }
    }


    // ============================================================
    // SECTION 13 — SCAN PIPELINE
    // Orchestrates keyword extraction → search → analysis in sequence.
    // ============================================================

    // FUNCTION: handleCheckClick
    // WHAT IT DOES: Entry point for the Scan button — validates the draft then
    //               runs the three-phase pipeline: keywords → search → analysis.
    // RECEIVES: event (Event) — the click event from the Scan button
    // RETURNS: nothing (async)
    async function handleCheckClick(event) {
      if (scanState.isLoading) return;

      // Hide all result sections and banners from any previous run
      _resetResultSections();

      const draftText = q('loc-draft-input').value.trim();

      if (!draftText) {
        showError('Please paste a post draft before scanning.');
        return;
      }

      if (draftText.length < 80) {
        showError('Your draft is too short — write at least 2 sentences for accurate results');
        return;
      }

      scanState.postText = draftText;
      const btnCheck     = q('loc-btn-check');
      showLoading(btnCheck, 'Extracting keywords');

      try {
        const keys = await loadKeys();

        // ── PHASE 3: Keyword extraction ─────────────────────────────────────
        const keywords = await extractKeywords(draftText, keys.gemini);
        if (!keywords || keywords.length === 0) throw new Error('ZERO_KEYWORDS');

        scanState.keywords = keywords;
        renderKeywords(keywords);

        // ── PHASE 4: LinkedIn search ─────────────────────────────────────────
        updateLoadingMsg(btnCheck, 'Searching LinkedIn posts');

        const results = await runAllSearches(keywords, scanState.windowDays, keys.serper);
        scanState.searchResults = results;

        renderSearchResults(results);
        renderSearchStatus(results, keywords.length);

        // ── PHASE 5: Originality analysis ────────────────────────────────────
        updateLoadingMsg(btnCheck, 'Analysing originality');

        const analysis = await analyzeOriginality(draftText, results, keys.gemini);
        scanState.analysisResult = analysis;

        renderAnalysis(analysis);

        // Persist the completed scan to session storage so it survives navigation
        saveLastScan();

      } catch (err) {
        const msg = err.message || '';
        if (msg === 'ZERO_KEYWORDS') {
          showError('Could not extract keywords — try adding more detail to your draft');
        } else if (msg.includes('Failed to fetch') || err.name === 'TypeError') {
          showError('No internet connection — check your network and try again');
        } else if (msg.includes('failed to parse') || msg.includes('JSON at position')) {
          showError('Gemini returned an unexpected format — try scanning again');
        } else if (msg.includes('callGemini') && (msg.includes('401') || msg.includes('403'))) {
          showError('Invalid Gemini API key — open settings and check your key');
        } else if (msg.includes('callSerper') && (msg.includes('401') || msg.includes('403'))) {
          showError('Invalid Serper API key — open settings and check your key');
        } else if (msg.includes('429')) {
          showError('Rate limit reached — wait a moment and try again');
        } else {
          showError(msg || 'Something went wrong — try scanning again');
        }
      } finally {
        hideLoading(btnCheck, 'Scan');
      }
    }

    // FUNCTION: handleTimeWindowClick
    // WHAT IT DOES: Updates the active time window via event delegation on the button group
    // RECEIVES: event (Event) — click bubbling up from a .loc-time-window__btn
    // RETURNS: nothing
    function handleTimeWindowClick(event) {
      const btn  = event.target.closest('.loc-time-window__btn');
      if (!btn) return;
      const days = parseInt(btn.dataset.days, 10);
      if (!days) return;

      scanState.windowDays = days;
      qAll('.loc-time-window__btn').forEach(b => {
        b.classList.toggle('loc-time-window__btn--active',
          parseInt(b.dataset.days, 10) === days);
      });
    }

    // FUNCTION: _resetResultSections
    // WHAT IT DOES: Hides and clears all result sections before a new scan run
    // RECEIVES: nothing
    // RETURNS: nothing
    function _resetResultSections() {
      ['loc-error-banner', 'loc-warn-banner', 'loc-success-banner',
       'loc-keywords-section', 'loc-search-results-section',
       'loc-search-status', 'loc-analysis-section',
       'loc-rewrite-output-section', 'loc-last-scan-banner'].forEach(id => {
        const el = q(id);
        if (el) { el.hidden = true; el.classList.remove('loc-section-visible'); }
      });
    }


    // ============================================================
    // SECTION 14 — KEYWORD RENDERING
    // ============================================================

    // FUNCTION: renderKeywords
    // WHAT IT DOES: Builds keyword pills from the extracted array and reveals the section
    // RECEIVES: keywords (string[]), animate (boolean) — default true
    // RETURNS: nothing
    function renderKeywords(keywords, animate = true) {
      const pills = q('loc-keywords-pills');
      pills.innerHTML = '';

      keywords.forEach((kw, i) => pills.appendChild(createKeywordPill(kw, i)));
      pills.appendChild(createAddPill());

      if (animate) {
        showSection('loc-keywords-section');
      } else {
        const section = q('loc-keywords-section');
        if (section) { section.hidden = false; section.classList.add('loc-section-visible'); }
      }
    }

    // FUNCTION: createKeywordPill
    // WHAT IT DOES: Builds a single keyword pill with a remove button
    // RECEIVES: keyword (string), index (number)
    // RETURNS: HTMLElement
    function createKeywordPill(keyword, index) {
      const pill = document.createElement('span');
      pill.className = 'loc-keyword-pill';

      const text = document.createElement('span');
      text.className   = 'loc-keyword-pill__text';
      text.textContent = keyword;

      const removeBtn = document.createElement('button');
      removeBtn.className   = 'loc-keyword-pill__remove';
      removeBtn.textContent = '×';
      removeBtn.title       = 'Remove keyword';
      removeBtn.addEventListener('click', () => {
        scanState.keywords.splice(index, 1);
        renderKeywords(scanState.keywords, false);
      });

      pill.appendChild(text);
      pill.appendChild(removeBtn);
      return pill;
    }

    // FUNCTION: createAddPill
    // WHAT IT DOES: Builds the interactive "+ Add" pill with an inline text input.
    //               Pressing Enter calls addKeywordAndRescan() so the new keyword
    //               is immediately searched and the analysis is updated.
    // RECEIVES: nothing
    // RETURNS: HTMLElement
    function createAddPill() {
      const pill = document.createElement('span');
      pill.className = 'loc-keyword-pill loc-keyword-pill--add';

      const lbl = document.createElement('span');
      lbl.textContent = '+ Add';

      const inp = document.createElement('input');
      inp.type        = 'text';
      inp.className   = 'loc-keyword-pill__input';
      inp.placeholder = 'Type keyword…';
      inp.hidden      = true;

      lbl.addEventListener('click', () => { lbl.hidden = true; inp.hidden = false; inp.focus(); });

      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          const val = inp.value.trim();
          if (val) addKeywordAndRescan(val);
        }
        if (e.key === 'Escape') renderKeywords(scanState.keywords, false);
      });

      pill.appendChild(lbl);
      pill.appendChild(inp);
      return pill;
    }

    // FUNCTION: addKeywordAndRescan
    // WHAT IT DOES: Adds a user-typed keyword then immediately:
    //               1. Runs a Serper search for the new keyword only
    //               2. Merges new results into the existing set (deduplicates by URL)
    //               3. Re-renders the search results section
    //               4. Re-runs originality analysis with the full updated result set
    //               5. Re-renders the gauge and suggestions
    //               Uses the existing scan loading state so the UI stays consistent.
    // RECEIVES: keyword (string) — the new keyword the user typed
    // RETURNS: nothing (async)
    async function addKeywordAndRescan(keyword) {
      if (scanState.isLoading) return;
      if (!scanState.postText)  return; // no draft — nothing to re-analyse against

      scanState.keywords.push(keyword);
      renderKeywords(scanState.keywords, false);

      const btnCheck = q('loc-btn-check');
      showLoading(btnCheck, `Searching "${keyword}"`);

      try {
        const keys = await loadKeys();

        // ── Step 1: search only for the new keyword ──────────────────────────
        const query      = buildQueries([keyword], scanState.windowDays)[0];
        const newResults = await callSerper(query, keys.serper);

        // ── Step 2: merge into existing results, dedup by URL ────────────────
        const seen = new Map();
        for (const r of scanState.searchResults) {
          if (r.link) seen.set(r.link, r);
        }
        for (const r of newResults) {
          if (r.link && !seen.has(r.link)) seen.set(r.link, r);
        }
        scanState.searchResults = Array.from(seen.values());

        renderSearchResults(scanState.searchResults);
        renderSearchStatus(scanState.searchResults, scanState.keywords.length);

        // ── Step 3: re-run analysis with the full updated result set ─────────
        updateLoadingMsg(btnCheck, 'Re-analysing originality');
        const analysis = await analyzeOriginality(
          scanState.postText, scanState.searchResults, keys.gemini
        );
        scanState.analysisResult = analysis;
        renderAnalysis(analysis);
        saveLastScan();

      } catch (err) {
        const msg = err.message || '';
        if (msg.includes('429')) {
          showError('Rate limit reached — wait a moment and try again');
        } else if (msg.includes('Failed to fetch') || err.name === 'TypeError') {
          showError('No internet connection — check your network and try again');
        } else if (msg.includes('callSerper') && (msg.includes('401') || msg.includes('403'))) {
          showError('Invalid Serper API key — open settings and check your key');
        } else {
          showError(msg || 'Search failed — try again');
        }
      } finally {
        hideLoading(btnCheck, 'Scan');
      }
    }


    // ============================================================
    // SECTION 15 — SEARCH RESULTS RENDERING
    // ============================================================

    // FUNCTION: renderSearchResults
    // WHAT IT DOES: Builds search result cards and reveals the section.
    //               "Open post →" navigates in the same tab — the sidebar
    //               re-injects on the next page from saved EXPANDED state.
    // RECEIVES: results (object[]) — { title, snippet, link }[]
    // RETURNS: nothing
    function renderSearchResults(results) {
      const section = q('loc-search-results-section');
      section.innerHTML = '';

      if (results.length === 0) { section.hidden = true; return; }

      const header = document.createElement('div');
      header.className = 'loc-search-results-section__header';

      const titleEl = document.createElement('span');
      titleEl.className   = 'loc-search-results-section__title';
      titleEl.textContent = 'Posts found on this topic';

      const countEl = document.createElement('span');
      countEl.className   = 'loc-search-results-section__count';
      countEl.textContent = `· ${results.length}`;

      header.appendChild(titleEl);
      header.appendChild(countEl);

      const scrollWrapper = document.createElement('div');
      scrollWrapper.className = 'loc-search-results-scroll-wrapper';

      const scrollList = document.createElement('div');
      scrollList.className = 'loc-search-results-scroll';
      results.forEach(r => scrollList.appendChild(createSearchResultCard(r)));

      scrollWrapper.appendChild(scrollList);
      section.appendChild(header);
      section.appendChild(scrollWrapper);
      showSection('loc-search-results-section');
    }

    // FUNCTION: renderSearchStatus
    // WHAT IT DOES: Shows "Found X posts across Y searches" or hides the line if zero
    // RECEIVES: results (object[]), queryCount (number)
    // RETURNS: nothing
    function renderSearchStatus(results, queryCount) {
      const el = q('loc-search-status');
      if (!el) return;
      if (results.length === 0) { el.hidden = true; return; }
      el.textContent = `Found ${results.length} posts across ${queryCount} searches`;
      el.hidden      = false;
    }

    // FUNCTION: createSearchResultCard
    // WHAT IT DOES: Builds a single result card.
    //               "Open post →" uses window.location.href so the sidebar
    //               re-injects automatically on the target page.
    // RECEIVES: result (object) — { title, snippet, link }
    // RETURNS: HTMLElement
    function createSearchResultCard(result) {
      const card = document.createElement('div');
      card.className = 'loc-search-result-card';

      const badge = document.createElement('span');
      badge.className   = 'loc-search-result-card__label';
      badge.textContent = 'LinkedIn';

      const titleEl = document.createElement('p');
      titleEl.className   = 'loc-search-result-card__title';
      titleEl.textContent = result.title || 'LinkedIn Post';

      const snippetEl = document.createElement('p');
      snippetEl.className   = 'loc-search-result-card__snippet';
      snippetEl.textContent = result.snippet || '';

      // "Open post →" navigates the current tab — sidebar re-injects on the
      // destination page from the saved EXPANDED state in chrome.storage.local
      const linkBtn = document.createElement('button');
      linkBtn.className   = 'loc-search-result-card__link';
      linkBtn.textContent = 'Open post →';
      linkBtn.addEventListener('click', () => {
        if (result.link) window.location.href = result.link;
      });

      card.appendChild(badge);
      card.appendChild(titleEl);
      card.appendChild(snippetEl);
      card.appendChild(linkBtn);
      return card;
    }


    // ============================================================
    // SECTION 16 — ANALYSIS RENDERING
    // ============================================================

    // FUNCTION: renderAnalysis
    // WHAT IT DOES: Draws the SVG gauge, repeated-themes pills, and 3 suggestion cards
    // RECEIVES: result (object) — { score, repeated, suggestions }
    // RETURNS: nothing
    function renderAnalysis(result) {
      const { score, repeated, suggestions } = result;

      // Draw the animated SVG gauge (replaces old score bar)
      renderGauge(score, q('loc-gauge-container'));

      // Repeated themes — null-safe
      const rList = q('loc-repeated-list');
      if (rList) {
        rList.innerHTML = '';
        (repeated || []).forEach(theme => {
          const li = document.createElement('li');
          li.className   = 'loc-repeated-pill';
          li.textContent = theme;
          rList.appendChild(li);
        });
      }

      // Suggestion cards — pass index so each Accept button knows which suggestion to use
      const sList = q('loc-suggestions-list');
      if (sList) {
        sList.innerHTML = '';
        (suggestions || []).forEach((s, i) => sList.appendChild(createSuggestionCard(s, i)));
      }

      showSection('loc-analysis-section');
    }

    // FUNCTION: renderGauge
    // WHAT IT DOES: Builds an animated SVG half-circle gauge inside a container element.
    //               Animates from 0 to the target score over 800ms using stroke-dashoffset.
    //               Score colours: 1-3 green, 4-6 amber, 7-10 red.
    // RECEIVES: score (number 1-10), container (HTMLElement) — the div to render into
    // RETURNS: nothing
    function renderGauge(score, container) {
      if (!container) return;

      const R      = 60;
      const CIRC   = Math.PI * R;   // ≈ 188.5 — half-circle arc length
      const colour = score <= 3 ? '#1D9E75' :
                     score <= 6 ? '#EF9F27' :
                                  '#E24B4A';
      const targetOffset = (CIRC * (1 - score / 10)).toFixed(1);

      // Build SVG — start with dashoffset = full CIRC (empty) then animate to target
      container.innerHTML = `
        <svg class="loc-gauge" viewBox="0 0 140 84" xmlns="http://www.w3.org/2000/svg" aria-label="Originality score ${score} out of 10">
          <path d="M 10,70 A ${R},${R} 0 0 1 130,70"
                stroke="#e8e8e8" stroke-width="10" fill="none" stroke-linecap="round"/>
          <path class="loc-gauge__fill"
                d="M 10,70 A ${R},${R} 0 0 1 130,70"
                stroke="${colour}" stroke-width="10" fill="none" stroke-linecap="round"
                stroke-dasharray="${CIRC.toFixed(1)}"
                stroke-dashoffset="${CIRC.toFixed(1)}"/>
          <text x="70" y="62" text-anchor="middle" class="loc-gauge__score">${score}</text>
          <text x="70" y="78" text-anchor="middle" class="loc-gauge__subscale">/ 10</text>
        </svg>
        <p class="loc-gauge__label">1 = highly original &middot; 10 = very repetitive</p>
      `;

      // Animate fill after initial paint so transition fires correctly
      requestAnimationFrame(() => {
        const fill = container.querySelector('.loc-gauge__fill');
        if (fill) {
          fill.style.transition    = 'stroke-dashoffset 800ms ease';
          fill.style.strokeDashoffset = targetOffset;
        }
      });
    }

    // FUNCTION: createSuggestionCard
    // WHAT IT DOES: Builds one suggestion card with an async "Accept and rewrite" button.
    //               The index is stored on the button so the correct suggestion is passed
    //               to rewritePost() even if the DOM is later mutated.
    // RECEIVES: suggestion (object) — { title, explanation, newAngle }
    //           index (number) — position in the suggestions array (0-based)
    // RETURNS: HTMLElement
    function createSuggestionCard(suggestion, index) {
      const card = document.createElement('div');
      card.className = 'loc-suggestion-card';

      const titleEl = document.createElement('p');
      titleEl.className   = 'loc-suggestion-card__title';
      titleEl.textContent = suggestion.title;

      const explEl = document.createElement('p');
      explEl.className   = 'loc-suggestion-card__explanation';
      explEl.textContent = suggestion.explanation;

      const angleEl = document.createElement('p');
      angleEl.className   = 'loc-suggestion-card__new-angle';
      angleEl.textContent = suggestion.newAngle;

      const acceptBtn = document.createElement('button');
      acceptBtn.className          = 'loc-suggestion-card__accept';
      acceptBtn.textContent        = 'Accept and rewrite';
      acceptBtn.dataset.suggestionIndex = index;

      acceptBtn.addEventListener('click', async () => {
        const allBtns = [...qAll('.loc-suggestion-card__accept')];
        allBtns.forEach(b => { b.disabled = true; });
        acceptBtn.textContent = 'Rewriting…';

        try {
          const keys         = await loadKeys();
          const rewrittenText = await rewritePost(scanState.postText, suggestion, keys.gemini);
          renderRewriteOutput(rewrittenText);
        } catch (err) {
          const msg = err.message || '';
          if (msg.includes('429')) {
            showError('Rate limit reached — wait a moment and try again');
          } else if (msg.includes('callGemini') && (msg.includes('401') || msg.includes('403'))) {
            showError('Invalid Gemini API key — open settings and check your key');
          } else {
            showError(`Rewrite failed — ${msg || 'try again'}`);
          }
          allBtns.forEach(b => { b.disabled = false; b.textContent = 'Accept and rewrite'; });
        }
      });

      card.appendChild(titleEl);
      card.appendChild(explEl);
      card.appendChild(angleEl);
      card.appendChild(acceptBtn);
      return card;
    }


    // ============================================================
    // SECTION 17 — REWRITE OUTPUT RENDERING
    // ============================================================

    // FUNCTION: renderRewriteOutput
    // WHAT IT DOES: Builds the estimated gauge, rewrite textarea, and action buttons,
    //               then reveals the section. The estimated gauge shows a projected
    //               lower originality score to signal the rewrite is more original.
    // RECEIVES: rewrittenText (string)
    // RETURNS: nothing
    function renderRewriteOutput(rewrittenText) {
      const section = q('loc-rewrite-output-section');
      if (!section) return;
      section.innerHTML = '';

      // ── Estimated originality gauge ───────────────────────────────────────────
      // Projected score: 40% of original score, clamped to minimum 1.
      // This is a heuristic estimate shown to signal improvement — not an API call.
      if (scanState.analysisResult && scanState.analysisResult.score) {
        const estScore = Math.max(1, Math.round(scanState.analysisResult.score * 0.4));

        const estWrap = document.createElement('div');
        estWrap.className = 'loc-est-gauge-wrap';

        const estLabel = document.createElement('p');
        estLabel.className   = 'loc-rewrite-output__label';
        estLabel.textContent = 'Estimated originality after rewrite';

        const estGaugeCont = document.createElement('div');
        estGaugeCont.className = 'loc-gauge-container loc-gauge-container--small';

        estWrap.appendChild(estLabel);
        estWrap.appendChild(estGaugeCont);
        section.appendChild(estWrap);

        // Render gauge directly into the element (not via q() — element not in sidebar yet)
        renderGauge(estScore, estGaugeCont);
      }

      // ── Rewritten post label + textarea ──────────────────────────────────────
      const label = document.createElement('p');
      label.className   = 'loc-rewrite-output__label';
      label.textContent = 'Your rewritten post';

      const textarea = document.createElement('textarea');
      textarea.className = 'loc-rewrite-output__textarea';
      textarea.value     = rewrittenText;
      textarea.readOnly  = true;
      textarea.addEventListener('click', () => textarea.select());

      // ── Action buttons ────────────────────────────────────────────────────────
      const actions = document.createElement('div');
      actions.className = 'loc-rewrite-output__actions';

      const copyBtn = document.createElement('button');
      copyBtn.className   = 'loc-btn-copy';
      copyBtn.textContent = 'Copy to clipboard';
      copyBtn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(rewrittenText); }
        catch { textarea.select(); document.execCommand('copy'); }
        copyBtn.textContent = 'Copied!';
        showSuccess('Rewritten post copied to clipboard');
        setTimeout(() => { copyBtn.textContent = 'Copy to clipboard'; }, 2000);
      });

      const tryAgainBtn = document.createElement('button');
      tryAgainBtn.className   = 'loc-btn-try-again';
      tryAgainBtn.textContent = 'Try a different suggestion';
      tryAgainBtn.addEventListener('click', () => {
        section.hidden = true;
        qAll('.loc-suggestion-card__accept').forEach(b => {
          b.disabled    = false;
          b.textContent = 'Accept and rewrite';
        });
      });

      const startOverBtn = document.createElement('button');
      startOverBtn.className   = 'loc-btn-start-over';
      startOverBtn.textContent = 'Start over';
      startOverBtn.addEventListener('click', resetAll);

      actions.appendChild(copyBtn);
      actions.appendChild(tryAgainBtn);
      actions.appendChild(startOverBtn);

      section.appendChild(label);
      section.appendChild(textarea);
      section.appendChild(actions);
      showSection('loc-rewrite-output-section');
    }


    // ============================================================
    // SECTION 18 — RESET
    // ============================================================

    // FUNCTION: resetAll
    // WHAT IT DOES: Clears all scan state, clears the draft textarea, hides all
    //               result sections, and removes session storage so the next page
    //               load starts completely fresh.
    // RECEIVES: nothing
    // RETURNS: nothing
    function resetAll() {
      // Clear scan state
      scanState.postText       = null;
      scanState.keywords       = [];
      scanState.searchResults  = [];
      scanState.analysisResult = null;
      scanState.isLoading      = false;

      // Clear draft textarea
      const ta = q('loc-draft-input');
      if (ta) ta.value = '';

      // Clear session storage so no stale results appear on the next navigation
      try { sessionStorage.removeItem(LAST_SCAN_KEY); } catch { /* ignored */ }

      // Hide all result sections and remove their animation class
      _resetResultSections();

      // Reset time window to 7-day default
      scanState.windowDays = 7;
      qAll('.loc-time-window__btn').forEach(b => {
        b.classList.toggle('loc-time-window__btn--active',
          parseInt(b.dataset.days, 10) === 7);
      });
    }


    // ============================================================
    // SECTION 19 — NOTIFICATION & LOADING HELPERS
    // ============================================================

    // FUNCTION: showBanner
    // WHAT IT DOES: Generic helper — populates a named banner and shows it,
    //               auto-dismissing after 6 seconds.
    // RECEIVES: bannerId (string), messageId (string), message (string),
    //           timerRef (ref to a module-level timer variable)
    // RETURNS: the new timer ID (caller should store it to cancel later)
    function showBanner(bannerId, messageId, message) {
      const bannerEl = q(bannerId);
      const msgEl    = q(messageId);
      if (!bannerEl || !msgEl) return;
      msgEl.textContent    = message;
      bannerEl.hidden      = false;
    }

    // FUNCTION: showError
    // WHAT IT DOES: Shows the red error banner and auto-dismisses after 6s
    // RECEIVES: message (string)
    // RETURNS: nothing
    function showError(message) {
      const bannerEl = q('loc-error-banner');
      const msgEl    = q('loc-error-message');
      if (!bannerEl || !msgEl) return;
      msgEl.textContent = message;
      bannerEl.hidden   = false;
      clearTimeout(_errorTimer);
      _errorTimer = setTimeout(() => { if (bannerEl) bannerEl.hidden = true; }, 6000);
    }

    // FUNCTION: showWarning
    // WHAT IT DOES: Shows the yellow warning banner and auto-dismisses after 6s
    // RECEIVES: message (string)
    // RETURNS: nothing
    function showWarning(message) {
      const bannerEl = q('loc-warn-banner');
      const msgEl    = q('loc-warn-message');
      if (!bannerEl || !msgEl) return;
      msgEl.textContent = message;
      bannerEl.hidden   = false;
      clearTimeout(_warnTimer);
      _warnTimer = setTimeout(() => { if (bannerEl) bannerEl.hidden = true; }, 6000);
    }

    // FUNCTION: showSuccess
    // WHAT IT DOES: Shows the green success banner and auto-dismisses after 6s
    // RECEIVES: message (string)
    // RETURNS: nothing
    function showSuccess(message) {
      const bannerEl = q('loc-success-banner');
      const msgEl    = q('loc-success-message');
      if (!bannerEl || !msgEl) return;
      msgEl.textContent = message;
      bannerEl.hidden   = false;
      clearTimeout(_successTimer);
      _successTimer = setTimeout(() => { if (bannerEl) bannerEl.hidden = true; }, 6000);
    }

    // FUNCTION: showLoading
    // WHAT IT DOES: Disables a button and starts the animated ellipsis
    // RECEIVES: buttonEl (HTMLButtonElement), message (string)
    // RETURNS: nothing
    function showLoading(buttonEl, message) {
      scanState.isLoading = true;
      buttonEl.disabled   = true;
      buttonEl.classList.add('loc-btn-check--loading');
      _startEllipsis(buttonEl, message);
    }

    // FUNCTION: hideLoading
    // WHAT IT DOES: Re-enables a button and cancels the ellipsis animation
    // RECEIVES: buttonEl (HTMLButtonElement), originalText (string)
    // RETURNS: nothing
    function hideLoading(buttonEl, originalText) {
      clearInterval(_ellipsisInt);
      _ellipsisInt        = null;
      scanState.isLoading = false;
      buttonEl.disabled   = false;
      buttonEl.classList.remove('loc-btn-check--loading');
      buttonEl.textContent = originalText;
    }

    // FUNCTION: updateLoadingMsg
    // WHAT IT DOES: Swaps the ellipsis base text mid-loading without stopping the animation
    // RECEIVES: buttonEl (HTMLButtonElement), message (string)
    // RETURNS: nothing
    function updateLoadingMsg(buttonEl, message) {
      clearInterval(_ellipsisInt);
      _startEllipsis(buttonEl, message);
    }

    // FUNCTION: _startEllipsis  (private)
    // WHAT IT DOES: Cycles "message." → "message.." → "message..." every 400ms
    // RECEIVES: buttonEl (HTMLButtonElement), message (string)
    // RETURNS: nothing
    function _startEllipsis(buttonEl, message) {
      const base  = message.replace(/[.…]+$/, '').trim();
      let dots    = 0;
      buttonEl.textContent = base + '.';
      _ellipsisInt = setInterval(() => {
        dots = (dots + 1) % 3;
        buttonEl.textContent = base + '.'.repeat(dots + 1);
      }, 400);
    }

    // FUNCTION: revealSection
    // WHAT IT DOES: Un-hides a section and triggers its fade+slide-up animation
    //               by adding .loc-section-visible on the next animation frame.
    // RECEIVES: el (HTMLElement)
    // RETURNS: nothing
    function revealSection(el) {
      el.hidden = false;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => el.classList.add('loc-section-visible'));
      });
    }


    // ============================================================
    // SECTION 20 — MESSAGE LISTENER
    // Listens for state-change commands from the service worker
    // (fired when the user clicks the toolbar icon).
    // ============================================================

    // FUNCTION: handleRuntimeMessage
    // WHAT IT DOES: Receives LOC_SIDEBAR_SET_STATE from the service worker
    //               and applies the requested state change to the DOM.
    // RECEIVES: message (object), sender (MessageSender), sendResponse (function)
    // RETURNS: nothing
    function handleRuntimeMessage(message, sender, sendResponse) {
      if (message.type === 'LOC_SIDEBAR_SET_STATE') {
        // State was already persisted by the service worker before sending this message.
        // Pass save: false to avoid a redundant second write to storage.
        try {
          applyState(message.state, { save: false });
          sendResponse({ ok: true });
        } catch {
          // Extension context invalidated — orphaned content script, safe to ignore.
        }
      }
    }

    chrome.runtime.onMessage.addListener(handleRuntimeMessage);


    // ============================================================
    // SECTION 21 — BOOTSTRAP
    // Reads the saved state from storage and restores the correct UI.
    // ============================================================

    // FUNCTION: init
    // WHAT IT DOES: Entry point — reads chrome.storage.local for the saved sidebar
    //               state and calls applyState() to restore the correct UI on load.
    // RECEIVES: nothing
    // RETURNS: nothing (async)
    async function init() {
      const result = await chrome.storage.local.get(SIDEBAR_STATE_KEY);
      const saved  = result[SIDEBAR_STATE_KEY] || SIDEBAR_STATE.HIDDEN;

      // Restore the sidebar state from the previous session.
      // save: false because the state is already in storage — no need to re-write it.
      await applyState(saved, { save: false });
    }

    init();

  })(); // end IIFE
} // end double-injection guard
