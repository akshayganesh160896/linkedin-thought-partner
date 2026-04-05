// ============================================================
// FILE: settings.js
// PURPOSE: Handles saving, loading, and clearing API keys
//          using Chrome's local storage via the storage utility.
// DEPENDS ON: ../utils/storage.js
// USED BY: settings.html
// ============================================================

import { saveKeys, loadKeys, clearKeys } from '../utils/storage.js';


// ============================================================
// DOM REFERENCES
// ============================================================

const dom = {
  form:             document.getElementById('settings-form'),
  geminiInput:      document.getElementById('input-gemini-key'),
  serperInput:      document.getElementById('input-serper-key'),
  errorGemini:      document.getElementById('error-gemini'),
  errorSerper:      document.getElementById('error-serper'),
  saveConfirmation: document.getElementById('save-confirmation'),
  btnSave:          document.getElementById('btn-save'),
  btnClear:         document.getElementById('btn-clear'),
  btnBack:          document.getElementById('btn-back'),
  revealBtns:       document.querySelectorAll('.btn-reveal'),
};


// ============================================================
// INITIALISATION
// Pre-fill inputs with any keys already stored in Chrome storage
// ============================================================

// FUNCTION: init
// WHAT IT DOES: Loads existing API keys from storage and pre-populates the form fields
// RECEIVES: nothing
// RETURNS: nothing (async)
async function init() {
  // Load whatever keys are already saved so the user can see and edit them
  const keys = await loadKeys();

  if (keys.gemini) dom.geminiInput.value = keys.gemini;
  if (keys.serper) dom.serperInput.value = keys.serper;
}


// ============================================================
// FORM SUBMISSION — Save keys
// ============================================================

// FUNCTION: handleSave
// WHAT IT DOES: Validates inputs and persists API keys to Chrome storage
// RECEIVES: event (Event) — the form submit event
// RETURNS: nothing (async)
async function handleSave(event) {
  // Prevent the form from doing a page reload on submit
  event.preventDefault();

  const gemini = dom.geminiInput.value.trim();
  const serper = dom.serperInput.value.trim();

  // Validate — surface inline errors and bail out if either field is empty
  let hasError = false;

  if (!gemini) {
    dom.errorGemini.hidden = false;
    hasError = true;
  } else {
    dom.errorGemini.hidden = true;
  }

  if (!serper) {
    dom.errorSerper.hidden = false;
    hasError = true;
  } else {
    dom.errorSerper.hidden = true;
  }

  if (hasError) return;

  // Persist both keys in a single atomic write
  await saveKeys({ gemini, serper });

  // Show the green "Saved ✓" confirmation, then hide it after 2 seconds
  dom.saveConfirmation.hidden = false;
  setTimeout(() => {
    dom.saveConfirmation.hidden = true;
  }, 2000);
}


// ============================================================
// CLEAR KEYS — Danger zone action
// ============================================================

// FUNCTION: handleClear
// WHAT IT DOES: Wipes all stored API keys after user confirms the action
// RECEIVES: event (Event) — the button click event
// RETURNS: nothing (async)
async function handleClear(event) {
  // Ask the user to confirm before destroying their saved keys
  const confirmed = window.confirm(
    'This will delete your saved API keys. You will need to re-enter them. Continue?'
  );

  if (!confirmed) return;

  // Remove all keys from storage and reset the form to blank
  await clearKeys();
  dom.geminiInput.value = '';
  dom.serperInput.value = '';

  // Reuse the confirmation element to acknowledge the clear action
  dom.saveConfirmation.textContent = '✓ Keys cleared';
  dom.saveConfirmation.hidden = false;
  setTimeout(() => {
    dom.saveConfirmation.hidden = true;
    dom.saveConfirmation.textContent = '✓ Saved';
  }, 2000);
}


// ============================================================
// REVEAL TOGGLE — Show/hide key text in each input
// ============================================================

// FUNCTION: handleRevealToggle
// WHAT IT DOES: Switches a password input between masked and plain-text modes
// RECEIVES: event (Event) — the button click; uses data-target to find its input
// RETURNS: nothing
function handleRevealToggle(event) {
  // Read which input this button controls via its data-target attribute
  const targetId = event.currentTarget.dataset.target;
  const input = document.getElementById(targetId);

  if (!input) return;

  // Flip between masked (password) and visible (text) states
  const isHidden = input.type === 'password';
  input.type = isHidden ? 'text' : 'password';
  event.currentTarget.title = isHidden ? 'Hide key' : 'Show key';
}


// ============================================================
// BACK BUTTON — Close this tab to return to the popup
// ============================================================

// FUNCTION: handleBack
// WHAT IT DOES: Closes the settings tab when the back arrow is clicked
// RECEIVES: event (Event) — the click event
// RETURNS: nothing
function handleBack(event) {
  window.close();
}


// ============================================================
// EVENT LISTENERS
// ============================================================

dom.form.addEventListener('submit', handleSave);
dom.btnClear.addEventListener('click', handleClear);
dom.btnBack.addEventListener('click', handleBack);

// Wire the reveal toggle to every show/hide button on the page
dom.revealBtns.forEach((btn) => {
  btn.addEventListener('click', handleRevealToggle);
});


// ============================================================
// BOOTSTRAP
// ============================================================

init();
