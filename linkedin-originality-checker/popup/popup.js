// ============================================================
// FILE: popup.js
// PURPOSE: Drives all UI logic in the extension popup — handles
//          user interactions, orchestrates the analysis flow,
//          and renders results to the panel.
// DEPENDS ON: ../utils/storage.js, ../utils/keywords.js,
//             ../utils/search.js, ../api/gemini.js, ../api/serper.js
// USED BY: popup.html (loaded as a <script type="module">)
// ============================================================

// ============================================================
// SECTION 1 — IMPORTS
// Pull in the helpers and API wrappers this file coordinates
// ============================================================

import { loadKeys, hasRequiredKeys } from '../utils/storage.js';
import { extractKeywords }           from '../utils/keywords.js';
import { runAllSearches }            from '../utils/search.js';
import { analyzeOriginality, rewritePost } from '../api/gemini.js';


// ============================================================
// SECTION 2 — STATE
// Tracks everything the panel needs to remember while open.
// All mutable state lives here so it is easy to find and reset.
// ============================================================

const state = {
  // The raw text of the LinkedIn draft currently being inspected
  postText: null,

  // Keywords extracted from the draft — shared with the search step
  keywords: [],

  // Deduplicated LinkedIn posts returned by Serper (set after search phase)
  searchResults: [],

  // How many days back to search — bound to the active time window button
  windowDays: 7,

  // Parsed analysis object returned by analyzeOriginality() (set after analysis phase)
  analysisResult: null,

  // Results from the last successful originality check
  lastResult: null,

  // Whether a check is currently in progress (prevents double-clicks)
  isLoading: false,
};


// ============================================================
// PHASE 7 — NOTIFICATION TIMERS & LOADING ANIMATION HANDLE
// Module-level so showError/showWarning/showSuccess can clear any
// previously running auto-dismiss timer before starting a new one,
// and hideLoading can cancel the cycling ellipsis interval.
// ============================================================

let _errorDismissTimer   = null;   // auto-dismiss timer for the red error banner
let _warningDismissTimer = null;   // auto-dismiss timer for the yellow warning banner
let _successDismissTimer = null;   // auto-dismiss timer for the green success banner
let _ellipsisInterval    = null;   // setInterval handle for animated loading dots


// ============================================================
// SECTION 3 — DOM REFERENCES
// Grab all elements once on load rather than querying repeatedly.
// Any element popup.js touches should have an entry here.
// ============================================================

const dom = {
  btnSettings:        document.getElementById('btn-settings'),
  btnCheck:           document.getElementById('btn-check'),
  btnRetry:           document.getElementById('btn-retry'),

  // Phase 7 — key status dot inside the settings button
  keyStatusDot:       document.getElementById('key-status-dot'),

  // Phase 7 — info banner (non-LinkedIn tab tip)
  infoBanner:         document.getElementById('info-banner'),
  btnDismissInfo:     document.getElementById('btn-dismiss-info'),

  keysWarning:        document.getElementById('keys-warning'),
  // Phase 7 — "Open settings" link inside the keys-warning banner
  btnOpenSettings:    document.getElementById('btn-open-settings'),

  errorBanner:        document.getElementById('error-banner'),
  errorBannerMessage: document.getElementById('error-banner-message'),
  btnDismissError:    document.getElementById('btn-dismiss-error'),

  // Phase 7 — yellow warning banner (showWarning)
  warningBanner:        document.getElementById('warning-banner'),
  warningBannerMessage: document.getElementById('warning-banner-message'),
  btnDismissWarning:    document.getElementById('btn-dismiss-warning'),

  // Phase 7 — green success banner (showSuccess)
  successBanner:        document.getElementById('success-banner'),
  successBannerMessage: document.getElementById('success-banner-message'),
  btnDismissSuccess:    document.getElementById('btn-dismiss-success'),

  draftInput:         document.getElementById('draft-input'),

  keywordsSection:    document.getElementById('keywords-section'),
  keywordsPills:      document.getElementById('keywords-pills'),
  timeWindowBtns:     document.querySelectorAll('.time-window__btn'),

  searchStatus:       document.getElementById('search-status'),
  noResultsWarning:   document.getElementById('no-results-warning'),

  searchResultsSection: document.getElementById('search-results-section'),

  analysisSection:    document.getElementById('analysis-section'),
  scoreNumber:        document.getElementById('score-number'),
  scoreBarFill:       document.getElementById('score-bar-fill'),
  repeatedList:       document.getElementById('repeated-list'),
  suggestionsList:    document.getElementById('suggestions-list'),

  rewriteOutputSection: document.getElementById('rewrite-output-section'),

  // Phase 7 — footer Reset button
  btnFooterReset:     document.getElementById('btn-footer-reset'),

  resultsArea:        document.getElementById('results-area'),
  verdictEl:          document.getElementById('verdict'),
  verdictLabel:       document.getElementById('verdict-label'),
  verdictScore:       document.getElementById('verdict-score'),
  resultsSummary:     document.getElementById('results-summary'),
  sourcesList:        document.getElementById('sources-list'),

  errorArea:          document.getElementById('error-area'),
  errorMessage:       document.getElementById('error-message'),
};


// ============================================================
// SECTION 4 — INITIALISATION
// Runs once when the popup opens. Checks for API keys and
// enables the Scan button if both are present.
// ============================================================

// FUNCTION: init
// WHAT IT DOES: Entry point — sets up the popup when it first opens.
//               Checks API key storage, colours the status dot, and checks
//               whether the active tab is on LinkedIn.
// RECEIVES: nothing
// RETURNS: nothing (async side effects only)
async function init() {
  const keys = await loadKeys();

  // ── API key status dot + warning banner ─────────────────────────────────────
  if (hasRequiredKeys(keys)) {
    // Both keys present — green dot, Scan button enabled, warning hidden
    dom.keyStatusDot.classList.add('key-status-dot--green');
    dom.keysWarning.hidden = true;
    dom.btnCheck.disabled  = false;
  } else {
    // At least one key missing — yellow dot, Scan disabled, warning visible
    dom.keyStatusDot.classList.add('key-status-dot--yellow');
    dom.keysWarning.hidden = false;
    dom.btnCheck.disabled  = true;
  }

  // ── LinkedIn tab check ───────────────────────────────────────────────────────
  // If the active tab is not on linkedin.com, show a soft blue info tip.
  // Wrapped in try/catch because tab URL may be unavailable in some contexts
  // (e.g. chrome:// pages where activeTab grants no URL access).
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && !tab.url.includes('linkedin.com')) {
      dom.infoBanner.hidden = false;
    }
  } catch {
    // Silently skip — the tip is non-critical and must never break the popup
  }
}


// ============================================================
// SECTION 5 — EVENT HANDLERS
// One handler per interactive element. Keep these thin — each
// one delegates real work to a dedicated function below.
// ============================================================

// FUNCTION: handleCheckClick
// WHAT IT DOES: Runs the full pipeline — keyword extraction then LinkedIn search
// RECEIVES: event (Event) — the click event
// RETURNS: nothing (async)
async function handleCheckClick(event) {
  // Guard: prevent re-entry while a request is already in flight
  if (state.isLoading) return;

  // Reset all result UI from any previous run before starting fresh
  dom.errorBanner.hidden        = true;
  dom.keywordsSection.hidden    = true;
  dom.searchResultsSection.hidden = true;
  dom.searchStatus.hidden       = true;
  dom.noResultsWarning.hidden   = true;
  dom.analysisSection.hidden    = true;
  dom.rewriteOutputSection.hidden = true;

  const draftText = dom.draftInput.value.trim();

  // Validate — surface a clear message rather than letting the API return an error
  if (!draftText) {
    showError('Please paste a post draft before scanning.');
    return;
  }

  if (draftText.length < 80) {
    showError('Your draft is too short — write at least 2 sentences for accurate results');
    return;
  }

  state.postText = draftText;

  showLoading(dom.btnCheck, 'Extracting keywords');

  try {
    const keys = await loadKeys();

    // ── PHASE 3: Keyword extraction ─────────────────────────────────────────
    const keywords = await extractKeywords(draftText, keys.gemini);

    // Guard: if Gemini returned nothing useful, stop before wasting a Serper call
    if (!keywords || keywords.length === 0) {
      throw new Error('ZERO_KEYWORDS');
    }

    state.keywords = keywords;
    renderKeywords(keywords);

    // ── PHASE 4: LinkedIn search ─────────────────────────────────────────────
    // updateLoadingMessage restarts the animated ellipsis with the new base text
    updateLoadingMessage(dom.btnCheck, 'Searching LinkedIn posts');

    const results = await runAllSearches(keywords, state.windowDays, keys.serper);
    state.searchResults = results;

    renderSearchResults(results);
    renderSearchStatus(results, keywords.length);

    // ── PHASE 5: Originality analysis ────────────────────────────────────────
    updateLoadingMessage(dom.btnCheck, 'Analysing originality');

    const analysis = await analyzeOriginality(draftText, results, keys.gemini);
    state.analysisResult = analysis;

    renderAnalysis(analysis);

  } catch (err) {
    // Map every known failure mode to a clear, actionable user-facing message.
    // The error source (callGemini vs callSerper) is embedded in the thrown
    // message text by the respective API wrapper, which lets us distinguish them.
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
    hideLoading(dom.btnCheck, 'Scan');
  }
}

// FUNCTION: handleTimeWindowClick
// WHAT IT DOES: Updates the active time window when the user picks 24h / 7d / 30d
// RECEIVES: event (Event) — click on a .time-window__btn
// RETURNS: nothing
function handleTimeWindowClick(event) {
  const days = parseInt(event.currentTarget.dataset.days, 10);
  if (!days) return;

  // Update state and toggle the active class across all buttons
  state.windowDays = days;
  dom.timeWindowBtns.forEach(btn => {
    btn.classList.toggle('time-window__btn--active',
      parseInt(btn.dataset.days, 10) === days);
  });
}

// FUNCTION: handleRetryClick
// WHAT IT DOES: Hides the legacy error area and re-runs the check
// RECEIVES: event (Event) — the click event
// RETURNS: nothing
function handleRetryClick(event) {
  dom.errorArea.hidden = true;
  handleCheckClick(event);
}

// FUNCTION: handleSettingsClick
// WHAT IT DOES: Opens the settings page in a new Chrome tab
// RECEIVES: event (Event) — the click event
// RETURNS: nothing
function handleSettingsClick(event) {
  // Open settings.html as a new tab — chrome.tabs.create gives us a full page
  // rather than a small popup, which suits a form with two inputs
  chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') });
}

// FUNCTION: handleDismissError
// WHAT IT DOES: Hides the error banner when the user clicks ×
// RECEIVES: event (Event) — the click event
// RETURNS: nothing
function handleDismissError(event) {
  dom.errorBanner.hidden = true;
}

// Wire up all event listeners in one place so they are easy to audit
dom.btnCheck.addEventListener('click', handleCheckClick);
dom.btnRetry.addEventListener('click', handleRetryClick);
dom.btnSettings.addEventListener('click', handleSettingsClick);
dom.btnDismissError.addEventListener('click', handleDismissError);

// Phase 7 — dismiss buttons for info, warning, and success banners
dom.btnDismissInfo.addEventListener('click',    () => { dom.infoBanner.hidden    = true; });
dom.btnDismissWarning.addEventListener('click', () => { dom.warningBanner.hidden = true; });
dom.btnDismissSuccess.addEventListener('click', () => { dom.successBanner.hidden = true; });

// Phase 7 — "Open settings" link inside the keys-warning banner
dom.btnOpenSettings.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') });
});

// Phase 7 — footer Reset button maps straight to resetAll
dom.btnFooterReset.addEventListener('click', resetAll);

// Each time window button updates state.windowDays and its own active class
dom.timeWindowBtns.forEach(btn => {
  btn.addEventListener('click', handleTimeWindowClick);
});


// ============================================================
// SECTION 6 — KEYWORD RENDERING
// Builds and injects keyword pills into the keywords section.
// The user can remove existing pills or add custom ones.
// ============================================================

// FUNCTION: renderKeywords
// WHAT IT DOES: Clears the pill container and rebuilds it from the keywords array
// RECEIVES: keywords (string[]) — the current keyword list from state
// RETURNS: nothing
function renderKeywords(keywords) {
  // Wipe previous pills before re-rendering so there are no duplicates
  dom.keywordsPills.innerHTML = '';

  keywords.forEach((kw, index) => {
    dom.keywordsPills.appendChild(createKeywordPill(kw, index));
  });

  // Always append the + Add pill at the end so the user can add custom keywords
  dom.keywordsPills.appendChild(createAddPill());

  // Phase 7 — use revealSection so the fade+slide animation fires
  revealSection(dom.keywordsSection);
}

// FUNCTION: createKeywordPill
// WHAT IT DOES: Builds a single pill element with keyword text and a remove button
// RECEIVES: keyword (string) — the keyword phrase to display
//           index (number) — its position in state.keywords (used for removal)
// RETURNS: HTMLElement — the complete pill <span>
function createKeywordPill(keyword, index) {
  const pill = document.createElement('span');
  pill.className = 'keyword-pill';

  const text = document.createElement('span');
  text.className = 'keyword-pill__text';
  text.textContent = keyword;

  const removeBtn = document.createElement('button');
  removeBtn.className = 'keyword-pill__remove';
  removeBtn.textContent = '×';
  removeBtn.title = 'Remove keyword';

  // Remove this keyword from state and re-render the whole pill row
  removeBtn.addEventListener('click', () => {
    state.keywords.splice(index, 1);
    renderKeywords(state.keywords);
  });

  pill.appendChild(text);
  pill.appendChild(removeBtn);
  return pill;
}

// FUNCTION: createAddPill
// WHAT IT DOES: Builds the interactive "+ Add" pill that reveals a text input on click
// RECEIVES: nothing
// RETURNS: HTMLElement — the complete add-pill <span>
function createAddPill() {
  const pill = document.createElement('span');
  pill.className = 'keyword-pill keyword-pill--add';

  // The visible label — clicking it hides itself and shows the input
  const label = document.createElement('span');
  label.textContent = '+ Add';

  // Hidden text input — revealed when the user clicks the label
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'keyword-pill__input';
  input.placeholder = 'Type keyword…';
  input.hidden = true;

  label.addEventListener('click', () => {
    label.hidden = true;
    input.hidden = false;
    input.focus();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const value = input.value.trim();
      if (value) {
        // Push the custom keyword into state and re-render with it included
        state.keywords.push(value);
        renderKeywords(state.keywords);
      }
    }
    // Escape cancels the add action without changing the keyword list
    if (e.key === 'Escape') {
      renderKeywords(state.keywords);
    }
  });

  pill.appendChild(label);
  pill.appendChild(input);
  return pill;
}


// ============================================================
// SECTION 4 — SEARCH
// Renders the outcome of the Serper search phase below the
// keyword pills — either a result count or a no-results notice.
// ============================================================

// FUNCTION: renderSearchStatus
// WHAT IT DOES: Shows the result count line or the no-results warning
// RECEIVES: results (object[]) — deduplicated posts returned by runAllSearches
//           queryCount (number) — how many keyword searches were fired
// RETURNS: nothing
function renderSearchStatus(results, queryCount) {
  if (results.length === 0) {
    // Zero results could mean the topic is original OR the date window is too tight —
    // the yellow warning nudges the user to try broader keywords rather than assuming
    dom.noResultsWarning.hidden = false;
    dom.searchStatus.hidden = true;
    return;
  }

  // Show exact numbers so the user can gauge how crowded the topic space is
  dom.searchStatus.textContent =
    `Found ${results.length} posts across ${queryCount} searches`;
  dom.searchStatus.hidden = false;
  dom.noResultsWarning.hidden = true;
}


// FUNCTION: renderSearchResults
// WHAT IT DOES: Builds and injects the search result cards section below the keyword
//               pills, showing one card per deduplicated LinkedIn post found by Serper
// RECEIVES: results (object[]) — deduplicated posts: { title, snippet, link }
// RETURNS: nothing
function renderSearchResults(results) {
  const section = dom.searchResultsSection;

  // Always wipe previous content so re-runs start clean
  section.innerHTML = '';

  if (results.length === 0) {
    section.hidden = true;
    return;
  }

  // ── Header row — title + count ───────────────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'search-results-section__header';

  const titleEl = document.createElement('span');
  titleEl.className = 'search-results-section__title';
  titleEl.textContent = 'Posts found on this topic';

  const countEl = document.createElement('span');
  countEl.className = 'search-results-section__count';
  countEl.textContent = `· ${results.length}`;

  header.appendChild(titleEl);
  header.appendChild(countEl);

  // ── Scrollable card list with bottom-fade wrapper ────────────────────────────
  const scrollWrapper = document.createElement('div');
  scrollWrapper.className = 'search-results-scroll-wrapper';

  const scrollList = document.createElement('div');
  scrollList.className = 'search-results-scroll';

  results.forEach(result => {
    scrollList.appendChild(createSearchResultCard(result));
  });

  scrollWrapper.appendChild(scrollList);
  section.appendChild(header);
  section.appendChild(scrollWrapper);

  // Phase 7 — animate in so the card list doesn't snap into view abruptly
  revealSection(section);
}

// FUNCTION: createSearchResultCard
// WHAT IT DOES: Builds a single result card element — LinkedIn pill, title, snippet,
//               and a "View post →" link that opens the source URL in a new tab
// RECEIVES: result (object) — { title, snippet, link }
// RETURNS: HTMLElement — the complete card <div>
function createSearchResultCard(result) {
  const card = document.createElement('div');
  card.className = 'search-result-card';

  // "LinkedIn" label pill — top-left visual indicator of the source platform
  const label = document.createElement('span');
  label.className = 'search-result-card__label';
  label.textContent = 'LinkedIn';

  // Post title — clamped to 2 lines via CSS
  const titleEl = document.createElement('p');
  titleEl.className = 'search-result-card__title';
  titleEl.textContent = result.title || 'LinkedIn Post';

  // Snippet — muted excerpt text, clamped to 3 lines via CSS
  const snippetEl = document.createElement('p');
  snippetEl.className = 'search-result-card__snippet';
  snippetEl.textContent = result.snippet || '';

  // "View post →" link — right-aligned, opens in a new tab safely
  const linkEl = document.createElement('a');
  linkEl.className = 'search-result-card__link';
  linkEl.textContent = 'View post →';
  linkEl.href = result.link;
  linkEl.target = '_blank';
  linkEl.rel = 'noopener noreferrer';

  card.appendChild(label);
  card.appendChild(titleEl);
  card.appendChild(snippetEl);
  card.appendChild(linkEl);

  return card;
}


// ============================================================
// SECTION 5 — ANALYSIS
// Renders the originality analysis returned by analyzeOriginality():
// score bar, repeated themes list, and suggestion cards.
// ============================================================

// FUNCTION: renderAnalysis
// WHAT IT DOES: Populates and reveals the analysis section from the Gemini result
// RECEIVES: result (object) — { score, repeated, suggestions } from analyzeOriginality
// RETURNS: nothing
function renderAnalysis(result) {
  const { score, repeated, suggestions } = result;

  // ── Score number ────────────────────────────────────────────────────────────
  dom.scoreNumber.textContent = score;

  // ── Score bar — width is score as a percentage of 10 ───────────────────────
  dom.scoreBarFill.style.width = `${(score / 10) * 100}%`;

  // Colour-code the bar: green (original) → amber (borderline) → red (repetitive)
  dom.scoreBarFill.classList.remove('score-bar__fill--green', 'score-bar__fill--amber', 'score-bar__fill--red');
  if (score <= 3) {
    dom.scoreBarFill.classList.add('score-bar__fill--green');
  } else if (score <= 6) {
    dom.scoreBarFill.classList.add('score-bar__fill--amber');
  } else {
    dom.scoreBarFill.classList.add('score-bar__fill--red');
  }

  // ── Repeated themes — one pill per item in the array ───────────────────────
  dom.repeatedList.innerHTML = '';
  (repeated || []).forEach(theme => {
    const li = document.createElement('li');
    li.className = 'repeated-pill';
    li.textContent = theme;
    dom.repeatedList.appendChild(li);
  });

  // ── Suggestion cards ────────────────────────────────────────────────────────
  dom.suggestionsList.innerHTML = '';
  (suggestions || []).forEach(suggestion => {
    dom.suggestionsList.appendChild(createSuggestionCard(suggestion));
  });

  // Phase 7 — animate in the whole analysis block
  revealSection(dom.analysisSection);
}

// FUNCTION: createSuggestionCard
// WHAT IT DOES: Builds a single suggestion card element with title, explanation,
//               new angle, and an "Accept and rewrite" button that calls rewritePost()
// RECEIVES: suggestion (object) — { title, explanation, newAngle }
// RETURNS: HTMLElement — the complete card <div>
function createSuggestionCard(suggestion) {
  const card = document.createElement('div');
  card.className = 'suggestion-card';

  const title = document.createElement('p');
  title.className = 'suggestion-card__title';
  title.textContent = suggestion.title;

  const explanation = document.createElement('p');
  explanation.className = 'suggestion-card__explanation';
  explanation.textContent = suggestion.explanation;

  const newAngle = document.createElement('p');
  newAngle.className = 'suggestion-card__new-angle';
  newAngle.textContent = suggestion.newAngle;

  const acceptBtn = document.createElement('button');
  acceptBtn.className = 'suggestion-card__accept';
  acceptBtn.textContent = 'Accept and rewrite';

  // PHASE 6: clicking Accept triggers a full Gemini rewrite of the original draft
  // using this card's angle as the direction
  acceptBtn.addEventListener('click', async () => {
    // Collect all three accept buttons so we can disable them together
    const allAcceptBtns = [
      ...dom.suggestionsList.querySelectorAll('.suggestion-card__accept'),
    ];

    // Disable every accept button — only one rewrite should run at a time
    allAcceptBtns.forEach(btn => { btn.disabled = true; });

    // Show a loading label on just this button so the user knows which one fired
    acceptBtn.textContent = 'Rewriting…';

    try {
      const keys = await loadKeys();
      const rewrittenText = await rewritePost(state.postText, suggestion, keys.gemini);

      // Success — render the output panel; buttons stay disabled until user
      // either clicks "Try a different suggestion" or "Start over"
      renderRewriteOutput(rewrittenText);

    } catch (err) {
      // Phase 7 — same error mapping used in handleCheckClick
      const msg = err.message || '';
      if (msg.includes('Failed to fetch') || err.name === 'TypeError') {
        showError('No internet connection — check your network and try again');
      } else if (msg.includes('429')) {
        showError('Rate limit reached — wait a moment and try again');
      } else if (msg.includes('callGemini') && (msg.includes('401') || msg.includes('403'))) {
        showError('Invalid Gemini API key — open settings and check your key');
      } else {
        showError(`Rewrite failed — ${msg || 'try again'}`);
      }

      // Re-enable all buttons on failure so the user can try a different card
      allAcceptBtns.forEach(btn => {
        btn.disabled = false;
        btn.textContent = 'Accept and rewrite';
      });
    }
  });

  card.appendChild(title);
  card.appendChild(explanation);
  card.appendChild(newAngle);
  card.appendChild(acceptBtn);

  return card;
}

// FUNCTION: renderRewriteOutput
// WHAT IT DOES: Builds and reveals the rewrite output panel below the suggestion
//               cards — contains the finished post, copy button, and reset actions
// RECEIVES: rewrittenText (string) — the AI-generated rewrite returned by rewritePost
// RETURNS: nothing
function renderRewriteOutput(rewrittenText) {
  const section = dom.rewriteOutputSection;

  // Wipe any previous rewrite so re-accepts always show fresh content
  section.innerHTML = '';

  // ── "Your rewritten post" label ──────────────────────────────────────────────
  const label = document.createElement('p');
  label.className = 'rewrite-output__label';
  label.textContent = 'Your rewritten post';

  // ── Read-only textarea — selecting all on click makes copying frictionless ───
  const textarea = document.createElement('textarea');
  textarea.className = 'rewrite-output__textarea';
  textarea.value = rewrittenText;
  textarea.readOnly = true;
  // Auto-select the full text when the user clicks so one Ctrl/Cmd+C copies it all
  textarea.addEventListener('click', () => textarea.select());

  // ── Action buttons ───────────────────────────────────────────────────────────
  const actions = document.createElement('div');
  actions.className = 'rewrite-output__actions';

  // Copy to clipboard — swaps button label AND shows the green success banner
  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn-copy';
  copyBtn.textContent = 'Copy to clipboard';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(rewrittenText);
    } catch {
      // Fallback for environments where clipboard API is unavailable
      textarea.select();
      document.execCommand('copy');
    }
    // Confirm success visually — button label change + top green banner
    copyBtn.textContent = 'Copied!';
    showSuccess('Rewritten post copied to clipboard');
    setTimeout(() => { copyBtn.textContent = 'Copy to clipboard'; }, 2000);
  });

  // Try a different suggestion — hides this panel and re-enables all accept buttons
  const tryAgainBtn = document.createElement('button');
  tryAgainBtn.className = 'btn-try-again';
  tryAgainBtn.textContent = 'Try a different suggestion';
  tryAgainBtn.addEventListener('click', () => {
    section.hidden = true;
    // Re-enable all three accept buttons so the user can pick another angle
    dom.suggestionsList
      .querySelectorAll('.suggestion-card__accept')
      .forEach(btn => {
        btn.disabled = false;
        btn.textContent = 'Accept and rewrite';
      });
  });

  // Start over — resets the entire panel back to the clean initial state
  const startOverBtn = document.createElement('button');
  startOverBtn.className = 'btn-start-over';
  startOverBtn.textContent = 'Start over';
  startOverBtn.addEventListener('click', resetAll);

  actions.appendChild(copyBtn);
  actions.appendChild(tryAgainBtn);
  actions.appendChild(startOverBtn);

  section.appendChild(label);
  section.appendChild(textarea);
  section.appendChild(actions);

  // Phase 7 — animate the rewrite panel in so it doesn't snap open
  revealSection(section);
}

// FUNCTION: resetAll
// WHAT IT DOES: Wipes all state and hides every result section, returning the popup
//               to its clean initial state so the user can start a fresh scan
// RECEIVES: nothing
// RETURNS: nothing
function resetAll() {
  // ── Clear state ──────────────────────────────────────────────────────────────
  state.postText      = null;
  state.keywords      = [];
  state.searchResults = [];
  state.analysisResult = null;
  state.lastResult    = null;
  state.isLoading     = false;

  // ── Clear the draft textarea ─────────────────────────────────────────────────
  dom.draftInput.value = '';

  // ── Hide every result and notification section ──────────────────────────────
  dom.errorBanner.hidden          = true;
  dom.warningBanner.hidden        = true;
  dom.successBanner.hidden        = true;
  dom.keywordsSection.hidden      = true;
  dom.searchResultsSection.hidden = true;
  dom.searchStatus.hidden         = true;
  dom.noResultsWarning.hidden     = true;
  dom.analysisSection.hidden      = true;
  dom.rewriteOutputSection.hidden = true;
  dom.resultsArea.hidden          = true;
  dom.errorArea.hidden            = true;

  // Phase 7 — remove section-visible so the fade+slide animation replays on the
  // next scan (without this the element is already at opacity:1 and won't animate)
  [
    dom.keywordsSection,
    dom.searchResultsSection,
    dom.analysisSection,
    dom.rewriteOutputSection,
  ].forEach(el => el.classList.remove('section-visible'));

  // ── Restore Scan button to its default enabled state ────────────────────────
  hideLoading(dom.btnCheck, 'Scan');

  // ── Reset time window toggle back to the 7-day default ───────────────────────
  state.windowDays = 7;
  dom.timeWindowBtns.forEach(btn => {
    btn.classList.toggle(
      'time-window__btn--active',
      parseInt(btn.dataset.days, 10) === 7
    );
  });
}


// ============================================================
// SECTION 7 — RENDER FUNCTIONS (Phase 4+)
// Pure UI operations for displaying originality check results.
// These should never contain business logic or API calls.
// ============================================================

// FUNCTION: renderResults
// WHAT IT DOES: Populates and reveals the results section with analysis data
// RECEIVES: result (object) — { verdict, score, summary, sources }
// RETURNS: nothing
function renderResults(result) {
  // Legacy stub — superseded by the sidebar (content/sidebar.js) in Phase 8
}

// FUNCTION: renderError
// WHAT IT DOES: Displays a human-readable error in the legacy results error area
// RECEIVES: message (string) — the error description to show
// RETURNS: nothing
function renderError(message) {
  // Legacy stub — superseded by the sidebar (content/sidebar.js) in Phase 8
}

// FUNCTION: renderSource
// WHAT IT DOES: Creates a single <li> element for one search result source
// RECEIVES: source (object) — { title: string, url: string, snippet: string }
// RETURNS: HTMLElement — the constructed <li> node
function renderSource(source) {
  // Legacy stub — superseded by the sidebar (content/sidebar.js) in Phase 8
}


// ============================================================
// SECTION 8 — LOADING, NOTIFICATION & ANIMATION HELPERS
// Generic utilities for button loading states, the three banner
// types, and the section reveal animation.
// Intentionally decoupled from any specific button or section.
// ============================================================

// FUNCTION: showError
// WHAT IT DOES: Populates and reveals the dismissable red error banner.
//               Any previously running auto-dismiss timer is cancelled first
//               so repeated errors each get the full 6-second window.
// RECEIVES: message (string) — the human-readable error text to display
// RETURNS: nothing
function showError(message) {
  dom.errorBannerMessage.textContent = message;
  dom.errorBanner.hidden = false;
  clearTimeout(_errorDismissTimer);
  _errorDismissTimer = setTimeout(() => { dom.errorBanner.hidden = true; }, 6000);
}

// FUNCTION: showWarning
// WHAT IT DOES: Populates and reveals the dismissable yellow warning banner.
//               Used for non-critical issues that the user should still notice.
// RECEIVES: message (string) — the warning text to display
// RETURNS: nothing
function showWarning(message) {
  dom.warningBannerMessage.textContent = message;
  dom.warningBanner.hidden = false;
  clearTimeout(_warningDismissTimer);
  _warningDismissTimer = setTimeout(() => { dom.warningBanner.hidden = true; }, 6000);
}

// FUNCTION: showSuccess
// WHAT IT DOES: Populates and reveals the dismissable green success banner.
//               Used for positive confirmations like "Copied to clipboard".
// RECEIVES: message (string) — the confirmation text to display
// RETURNS: nothing
function showSuccess(message) {
  dom.successBannerMessage.textContent = message;
  dom.successBanner.hidden = false;
  clearTimeout(_successDismissTimer);
  _successDismissTimer = setTimeout(() => { dom.successBanner.hidden = true; }, 6000);
}

// FUNCTION: showLoading
// WHAT IT DOES: Puts a button into a loading state — disables it, adds the
//               loading CSS class, and starts the animated ellipsis cycling.
// RECEIVES: buttonEl (HTMLButtonElement) — the button to put into loading state
//           message (string) — the base text to show (dots are appended by the interval)
// RETURNS: nothing
function showLoading(buttonEl, message) {
  state.isLoading = true;
  buttonEl.disabled = true;
  buttonEl.classList.add('btn-check--loading');
  // Store original text on the element so hideLoading can restore it
  buttonEl.dataset.originalText = buttonEl.textContent;
  // Start the animated ellipsis immediately
  _startEllipsis(buttonEl, message);
}

// FUNCTION: hideLoading
// WHAT IT DOES: Restores a button from its loading state back to normal
//               and cancels the ellipsis animation.
// RECEIVES: buttonEl (HTMLButtonElement) — the button to restore
//           originalText (string) — the label text to put back
// RETURNS: nothing
function hideLoading(buttonEl, originalText) {
  clearInterval(_ellipsisInterval);
  _ellipsisInterval = null;
  state.isLoading = false;
  buttonEl.disabled = false;
  buttonEl.classList.remove('btn-check--loading');
  buttonEl.textContent = originalText;
}

// FUNCTION: updateLoadingMessage
// WHAT IT DOES: Changes the base text of the animated ellipsis mid-loading —
//               used when the pipeline moves from one phase to the next while
//               the button is still disabled (e.g. "Extracting…" → "Searching…")
// RECEIVES: buttonEl (HTMLButtonElement) — the button currently in loading state
//           message (string) — the new base text to cycle dots on
// RETURNS: nothing
function updateLoadingMessage(buttonEl, message) {
  // Cancel the current interval before starting a new one to avoid two
  // intervals racing to write to the same button simultaneously
  clearInterval(_ellipsisInterval);
  _startEllipsis(buttonEl, message);
}

// FUNCTION: _startEllipsis  (private)
// WHAT IT DOES: Sets the button text to "message." immediately and then
//               cycles "message.." → "message..." → "message." every 400ms
// RECEIVES: buttonEl (HTMLButtonElement) — the button to animate
//           message (string) — the base text (any trailing punctuation is stripped)
// RETURNS: nothing
function _startEllipsis(buttonEl, message) {
  // Strip any trailing ellipsis or dots the caller may have included so we
  // always start from a clean base — "Scanning…" → "Scanning"
  const base = message.replace(/[.…]+$/, '').trim();
  let dotCount = 0;
  buttonEl.textContent = base + '.';
  _ellipsisInterval = setInterval(() => {
    dotCount = (dotCount + 1) % 3;
    buttonEl.textContent = base + '.'.repeat(dotCount + 1);
  }, 400);
}

// FUNCTION: revealSection
// WHAT IT DOES: Un-hides a section element and triggers its CSS fade+slide
//               animation by adding the .section-visible class on the next
//               animation frame — the double-rAF ensures the browser has
//               painted the element at opacity:0 before the transition fires.
// RECEIVES: el (HTMLElement) — the section to reveal
// RETURNS: nothing
function revealSection(el) {
  el.hidden = false;
  // First rAF: element is now in the render tree at its starting state (opacity:0)
  // Second rAF: transition is triggered by adding section-visible
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('section-visible'));
  });
}


// ============================================================
// SECTION 9 — BOOTSTRAP
// Kick everything off. init() is the single entry point.
// ============================================================

init();
