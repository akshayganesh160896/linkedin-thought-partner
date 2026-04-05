// ============================================================
// FILE: storage.js
// PURPOSE: Thin wrapper around Chrome's storage.local API —
//          centralises all read/write operations so the rest of
//          the app never touches chrome.storage directly.
// DEPENDS ON: nothing (uses Chrome Extension APIs)
// USED BY: settings.js, popup.js
// ============================================================


// ============================================================
// KEY NAMES
// Using constants avoids typos when reading/writing storage —
// if a key name ever changes, update it here and nowhere else
// ============================================================

const STORAGE_KEYS = {
  GEMINI_API_KEY: 'geminiApiKey',
  SERPER_API_KEY: 'serperApiKey',
};


// ============================================================
// SAVE
// ============================================================

// FUNCTION: saveKeys
// WHAT IT DOES: Persists the user's API keys to Chrome's local storage
// RECEIVES: keys (object) — { gemini: string, serper: string }
// RETURNS: Promise<void> — resolves when the write is complete
export async function saveKeys({ gemini, serper }) {
  // Store both keys in a single write to keep it atomic —
  // chrome.storage.local.set returns a Promise natively in MV3
  await chrome.storage.local.set({
    [STORAGE_KEYS.GEMINI_API_KEY]: gemini,
    [STORAGE_KEYS.SERPER_API_KEY]: serper,
  });
}


// ============================================================
// LOAD
// ============================================================

// FUNCTION: loadKeys
// WHAT IT DOES: Retrieves stored API keys from Chrome's local storage
// RECEIVES: nothing
// RETURNS: Promise<object> — { gemini: string|null, serper: string|null }
export async function loadKeys() {
  // Read both keys in a single get call — pass an array of key names
  // so Chrome returns only those two entries from storage
  const result = await chrome.storage.local.get([
    STORAGE_KEYS.GEMINI_API_KEY,
    STORAGE_KEYS.SERPER_API_KEY,
  ]);

  // Normalise to a consistent shape regardless of whether keys exist yet
  return {
    gemini: result[STORAGE_KEYS.GEMINI_API_KEY] ?? null,
    serper: result[STORAGE_KEYS.SERPER_API_KEY] ?? null,
  };
}


// ============================================================
// CLEAR
// ============================================================

// FUNCTION: clearKeys
// WHAT IT DOES: Removes all stored API keys from Chrome's local storage
// RECEIVES: nothing
// RETURNS: Promise<void> — resolves when the delete is complete
export async function clearKeys() {
  // Remove both keys in a single operation
  await chrome.storage.local.remove([
    STORAGE_KEYS.GEMINI_API_KEY,
    STORAGE_KEYS.SERPER_API_KEY,
  ]);
}


// ============================================================
// VALIDATION HELPER
// ============================================================

// FUNCTION: hasRequiredKeys
// WHAT IT DOES: Checks whether both API keys are present — used to gate the check flow
// RECEIVES: keys (object) — { gemini: string|null, serper: string|null }
// RETURNS: boolean — true only if both keys are non-empty strings
export function hasRequiredKeys({ gemini, serper }) {
  // Both keys must be present; a partial configuration is treated as missing
  return (
    typeof gemini === 'string' && gemini.trim().length > 0 &&
    typeof serper === 'string' && serper.trim().length > 0
  );
}
