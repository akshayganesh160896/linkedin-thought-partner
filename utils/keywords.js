// ============================================================
// FILE: keywords.js
// PURPOSE: Builds the keyword extraction prompt, calls Gemini,
//          and parses the response into a clean keyword array.
// DEPENDS ON: ../api/gemini.js
// USED BY: popup.js (handleCheckClick)
// ============================================================

import { callGemini } from '../api/gemini.js';


// ============================================================
// MAIN EXPORT — entry point for Phase 3 keyword extraction
// ============================================================

// FUNCTION: extractKeywords
// WHAT IT DOES: Sends the draft to Gemini and returns a keyword array
// RECEIVES: draftText (string) — the raw LinkedIn post draft pasted by the user
//           apiKey (string) — the user's Gemini API key from Chrome storage
// RETURNS: Promise<string[]> — 3 to 5 keyword phrases, or a fallback array
export async function extractKeywords(draftText, apiKey) {
  // Build the prompt that tells Gemini exactly what format to return
  const prompt = buildKeywordPrompt(draftText);

  // Call Gemini and get the raw text response
  const rawResponse = await callGemini(prompt, apiKey);

  // Attempt to parse the response as JSON — Gemini is instructed to return
  // a raw JSON array, but occasionally adds markdown fences or commentary
  try {
    // Strip any code fences Gemini adds despite explicit instructions not to
    const cleaned = rawResponse.replace(/```json|```/g, '').trim();
    const keywords = JSON.parse(cleaned);

    if (!Array.isArray(keywords)) throw new Error('Response was not a JSON array');

    // Cap at 5 in case the model returns more than instructed
    return keywords.slice(0, 5);

  } catch {
    // If parsing fails for any reason, fall back to a simple word-frequency
    // extraction from the draft itself so the user always gets something useful
    return fallbackKeywords(draftText);
  }
}


// ============================================================
// PROMPT BUILDER
// ============================================================

// FUNCTION: buildKeywordPrompt
// WHAT IT DOES: Constructs the instruction prompt asking Gemini to return a
//               JSON array of searchable keyword phrases from the draft
// RECEIVES: draftText (string) — the raw text of the LinkedIn post draft
// RETURNS: string — the complete prompt ready to send to Gemini
function buildKeywordPrompt(draftText) {
  // We instruct Gemini to return ONLY a raw JSON array with no surrounding text —
  // this makes parsing deterministic and avoids having to strip prose from the output
  return `You are a keyword extraction assistant for a LinkedIn originality checker.

Read the following LinkedIn post draft and return ONLY a valid JSON array of 3 to 5 short keyword phrases that best represent the searchable essence of this post.

Focus on:
- The core claim or argument the author is making
- The specific industry or domain being discussed
- The emotional angle or narrative framing (e.g. "overcoming imposter syndrome", "career pivot at 40")
- Any trending or specific framing that makes this post distinct

Skip all generic filler words and phrases such as: "innovation", "excited to share", "my thoughts", "leadership", "passionate", "journey", "game changer", "lessons learned".

Return ONLY the raw JSON array — no explanation, no markdown, no code fences, no extra text before or after.

Example of correct output format:
["AI replacing junior developers", "software career advice 2024", "tech industry job cuts"]

--- POST ---
${draftText}
--- END POST ---`;
}


// ============================================================
// FALLBACK EXTRACTOR
// ============================================================

// FUNCTION: fallbackKeywords
// WHAT IT DOES: Extracts the 3 longest unique words from the draft as a last resort
// RECEIVES: draftText (string) — the raw post draft
// RETURNS: string[] — array of 3 keyword strings
function fallbackKeywords(draftText) {
  // When Gemini's response cannot be parsed, we still need to give the user
  // something to work with — pull the longest words as rough proxies for topics
  const words = draftText.split(/\s+/);

  // Normalise to lowercase, strip punctuation, deduplicate
  const unique = [...new Set(
    words.map(w => w.replace(/[^a-zA-Z]/g, '').toLowerCase())
  )];

  return unique
    .filter(w => w.length > 5)
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
}


// ============================================================
// VALIDATION HELPER
// ============================================================

// FUNCTION: isValidPostText
// WHAT IT DOES: Checks whether a draft string is long enough to be worth analysing
// RECEIVES: postText (string) — the raw draft text to validate
// RETURNS: boolean — true if the text meets the minimum length threshold
export function isValidPostText(postText) {
  // Very short strings cannot yield meaningful keyword extraction —
  // this threshold prevents wasting API calls on trivial content
  const MIN_LENGTH = 80;
  return typeof postText === 'string' && postText.trim().length >= MIN_LENGTH;
}
