// ============================================================
// FILE: service-worker.js
// PURPOSE: Manages the extension's background lifecycle.
//          Handles toolbar icon clicks to toggle the injected
//          sidebar and relays state changes to the active tab's
//          content script via chrome.tabs.sendMessage.
// DEPENDS ON: nothing (uses Chrome Extension APIs only)
// USED BY: Chrome Extension runtime (declared in manifest.json)
// ============================================================


// ============================================================
// CONSTANTS
// ============================================================

// Storage key for the sidebar visibility state — shared with content/sidebar.js
const SIDEBAR_STATE_KEY = 'loc_sidebar_state';

// The three possible states the sidebar can be in
const SIDEBAR_STATE = {
  HIDDEN:    'hidden',
  EXPANDED:  'expanded',
  MINIMIZED: 'minimized',
};


// ============================================================
// INSTALL — Runs once on first install or update
// ============================================================

// FUNCTION: handleInstall
// WHAT IT DOES: Initialises default sidebar state on first install so the
//               content script always finds a known value in storage
// RECEIVES: event (ExtendableEvent) — the install lifecycle event
// RETURNS: nothing
function handleInstall(event) {
  // Default is HIDDEN — the user must click the toolbar icon deliberately
  // to open the sidebar for the first time
  event.waitUntil(
    chrome.storage.local.get(SIDEBAR_STATE_KEY).then(result => {
      // Only set the default if no state has been saved yet —
      // updating the extension should not reset a previously chosen state
      if (!result[SIDEBAR_STATE_KEY]) {
        return chrome.storage.local.set({ [SIDEBAR_STATE_KEY]: SIDEBAR_STATE.HIDDEN });
      }
    })
  );
}

self.addEventListener('install', handleInstall);


// ============================================================
// ACTIVATE — Service worker takes control
// ============================================================

// FUNCTION: handleActivate
// WHAT IT DOES: Claims all open pages immediately so the content script
//               receives messages from this service worker without a reload
// RECEIVES: event (ExtendableEvent) — the activate lifecycle event
// RETURNS: nothing
function handleActivate(event) {
  event.waitUntil(self.clients.claim());
}

self.addEventListener('activate', handleActivate);


// ============================================================
// TOOLBAR ICON CLICK — Toggle sidebar state
// The popup has been removed from manifest so this fires instead
// ============================================================

// FUNCTION: handleActionClick
// WHAT IT DOES: Reads the current sidebar state and toggles it.
//               HIDDEN    → EXPANDED  (reveal the sidebar)
//               EXPANDED  → HIDDEN    (remove the sidebar)
//               MINIMIZED → HIDDEN    (remove the sidebar)
//               Persists the new state to storage and notifies the
//               active tab's content script so it can update the DOM.
// RECEIVES: tab (Tab) — the Chrome Tab object for the active tab
// RETURNS: nothing (async)
async function handleActionClick(tab) {
  // Read the current state — default to HIDDEN if storage has never been written
  const result = await chrome.storage.local.get(SIDEBAR_STATE_KEY);
  const currentState = result[SIDEBAR_STATE_KEY] || SIDEBAR_STATE.HIDDEN;

  // Only the toolbar icon transitions to/from HIDDEN.
  // The in-sidebar minimize button handles EXPANDED → MINIMIZED separately.
  const newState = currentState === SIDEBAR_STATE.HIDDEN
    ? SIDEBAR_STATE.EXPANDED
    : SIDEBAR_STATE.HIDDEN;

  // Persist before messaging so the state is correct even if the message fails
  await chrome.storage.local.set({ [SIDEBAR_STATE_KEY]: newState });

  // Tell the content script in the active tab to apply the new state.
  // Wrapped in try/catch — some pages (chrome://, new tab) have no content script.
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'LOC_SIDEBAR_SET_STATE',
      state: newState,
    });
  } catch {
    // The state is already saved; it will be restored on the next page the
    // content script runs on, so this failure is safe to ignore.
  }
}

chrome.action.onClicked.addListener(handleActionClick);


// ============================================================
// MESSAGE RELAY — From content script back to service worker
// ============================================================

// FUNCTION: handleMessage
// WHAT IT DOES: Persists sidebar state changes that originate inside the
//               content script (e.g. user clicks the — minimise button).
//               Content scripts cannot call chrome.storage directly from within
//               message handlers bound to chrome.runtime, but they CAN call it
//               directly — we use this relay only for cases where the content
//               script needs acknowledgement that the write completed.
// RECEIVES: message (object) — { type: string, state?: string }
//           sender (MessageSender) — origin context
//           sendResponse (function) — call to return a value
// RETURNS: true to keep the message channel open for the async response
function handleMessage(message, sender, sendResponse) {
  if (message.type === 'LOC_SAVE_SIDEBAR_STATE') {
    chrome.storage.local
      .set({ [SIDEBAR_STATE_KEY]: message.state })
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async sendResponse
  }

  // Content scripts cannot reliably call openOptionsPage() directly —
  // the service worker handles it instead.
  if (message.type === 'LOC_OPEN_SETTINGS') {
    chrome.runtime.openOptionsPage();
  }
}

chrome.runtime.onMessage.addListener(handleMessage);
