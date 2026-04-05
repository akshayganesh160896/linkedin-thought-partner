// ============================================================
// FILE: gemini.js
// PURPOSE: The single point of contact for all Gemini API calls —
//          every request to Google's AI goes through this file.
// DEPENDS ON: nothing (pure fetch calls)
// USED BY: utils/keywords.js, popup.js
// ============================================================


// ============================================================
// CONSTANTS
// Centralised config for the Gemini API — change model or
// endpoint here without touching calling code
// ============================================================

// gemini-2.5-flash: latest stable Flash model with free tier access via AI Studio
// NOTE: free tier (limit: 0) errors usually mean the key came from Google Cloud
// Console rather than AI Studio — see README for how to get the correct key
const GEMINI_MODEL = 'gemini-2.5-flash';

// Base URL for the Gemini generateContent endpoint
// The API key is appended as a query param at call time
const GEMINI_BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Maximum tokens the model is allowed to return — 2048 comfortably fits the
// analysis JSON (score + repeated array + 3 suggestion objects with full sentences)
const MAX_OUTPUT_TOKENS = 2048;

// Temperature controls creativity — 0 = deterministic, 1 = creative
// We want consistent, factual extraction so we use a low value
const TEMPERATURE = 0.2;

// gemini-2.5-flash has built-in "thinking" that silently consumes output tokens
// before generating any text — setting thinkingBudget: 0 disables it entirely.
// We don't need deep reasoning for structured JSON extraction, and without this
// the model exhausts nearly all of MAX_OUTPUT_TOKENS on hidden thinking steps,
// leaving only ~50 tokens for the actual response (causing truncated JSON).
const THINKING_CONFIG = { thinkingBudget: 0 };


// ============================================================
// EXPORT 1 — KEYWORD EXTRACTION CALL
// ============================================================

// FUNCTION: callGemini
// WHAT IT DOES: Sends a prompt to the Gemini API and returns the text response
// RECEIVES: prompt (string) — the full prompt to send to the model
//           apiKey (string) — the user's Gemini API key from Chrome storage
// RETURNS: Promise<string> — the raw text content from Gemini's response
export async function callGemini(prompt, apiKey) {
  // Build the request body in the shape Gemini expects
  const body = buildRequestBody(prompt);

  // Append the API key as a query parameter — Gemini does not use headers for auth
  const response = await fetch(`${GEMINI_BASE_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // Surface HTTP-level failures with the status code and Gemini's own error message
  // so the user sees something actionable rather than a generic network error
  if (!response.ok) {
    const errJson = await response.json().catch(() => ({}));
    const errMsg = errJson?.error?.message || response.statusText;
    throw new Error(`callGemini: request failed with status ${response.status} — ${errMsg}`);
  }

  // Parse the response body and extract the generated text string
  const json = await response.json();
  return extractTextFromResponse(json);
}


// ============================================================
// EXPORT 2 — ORIGINALITY ANALYSIS CALL
// ============================================================

// FUNCTION: analyzeOriginality
// WHAT IT DOES: Sends the draft + search results to Gemini and returns a structured
//               originality analysis with a score, repeated themes, and suggestions
// RECEIVES: draftText (string) — the user's LinkedIn post draft
//           searchResults (object[]) — deduplicated posts from Serper { title, snippet, link }
//           apiKey (string) — the user's Gemini API key from Chrome storage
// RETURNS: Promise<object> — { score, repeated, suggestions } parsed from Gemini's JSON
export async function analyzeOriginality(draftText, searchResults, apiKey) {
  const prompt = buildAnalysisPrompt(draftText, searchResults);

  // Re-use callGemini — same endpoint, same auth, same response extraction logic
  const rawText = await callGemini(prompt, apiKey);

  // Gemini sometimes wraps JSON in markdown code fences despite explicit instructions —
  // strip them before parsing so we always get clean JSON input to JSON.parse
  const cleaned = rawText.replace(/```json|```/g, '').trim();

  try {
    const result = JSON.parse(cleaned);
    return result;
  } catch (parseErr) {
    // Surface the raw response in the error so we can debug prompt issues easily
    throw new Error(
      `analyzeOriginality: failed to parse Gemini response as JSON — ${parseErr.message}. Raw: ${cleaned.slice(0, 200)}`
    );
  }
}


// ============================================================
// EXPORT 3 — POST REWRITE CALL
// ============================================================

// FUNCTION: rewritePost
// WHAT IT DOES: Sends the original draft and the chosen suggestion direction to
//               Gemini and returns a fully rewritten post ready to copy and paste
// RECEIVES: originalDraft (string) — the user's original LinkedIn post draft
//           chosenSuggestion (object) — { title, explanation, newAngle } from analyzeOriginality
//           apiKey (string) — the user's Gemini API key from Chrome storage
// RETURNS: Promise<string> — the rewritten post text, trimmed and stripped of markdown
export async function rewritePost(originalDraft, chosenSuggestion, apiKey) {
  const prompt = buildRewritePrompt(originalDraft, chosenSuggestion);

  // Re-use callGemini — same endpoint, same auth, same response extraction logic
  const rawText = await callGemini(prompt, apiKey);

  // Strip any accidental markdown code fences and trim surrounding whitespace
  const cleaned = rawText
    .replace(/^```[\w]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();

  if (!cleaned) {
    throw new Error('rewritePost: Gemini returned an empty response — try again');
  }

  return cleaned;
}


// ============================================================
// PRIVATE HELPERS
// ============================================================

// FUNCTION: buildRequestBody
// WHAT IT DOES: Constructs the JSON payload Gemini's API expects
// RECEIVES: prompt (string) — the prompt text to send
// RETURNS: object — the complete request body ready to JSON.stringify
function buildRequestBody(prompt) {
  return {
    contents: [
      { parts: [{ text: prompt }] },
    ],
    generationConfig: {
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      temperature: TEMPERATURE,
      thinkingConfig: THINKING_CONFIG,
    },
  };
}

// FUNCTION: extractTextFromResponse
// WHAT IT DOES: Safely navigates the nested Gemini response to get the text
// RECEIVES: responseJson (object) — the parsed JSON response from the API
// RETURNS: string — the generated text, or throws if structure is unexpected
function extractTextFromResponse(responseJson) {
  // Gemini nests the output several levels deep — use optional chaining to
  // avoid a TypeError crash if any level of the structure is missing
  const text = responseJson?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    throw new Error('callGemini: response did not contain any generated text');
  }

  return text;
}

// FUNCTION: buildRewritePrompt
// WHAT IT DOES: Constructs the three-part rewrite prompt from the draft + chosen suggestion
// RECEIVES: originalDraft (string) — the user's post draft
//           chosenSuggestion (object) — { title, explanation, newAngle }
// RETURNS: string — the complete prompt ready to send to Gemini
function buildRewritePrompt(originalDraft, chosenSuggestion) {
  // Part 1 — give Gemini the original draft so it has the author's voice as a reference
  const part1 = `Here is the original LinkedIn post draft:\n\n${originalDraft}`;

  // Part 2 — the chosen direction selected by the user from the three suggestions
  const part2 = [
    'The user has chosen this direction to make it more original:',
    `Title: ${chosenSuggestion.title}`,
    `New angle: ${chosenSuggestion.newAngle}`,
    `Explanation: ${chosenSuggestion.explanation}`,
  ].join('\n');

  // Part 3 — precise rewrite rules to keep the output paste-ready with no extra text
  const part3 = [
    'Rewrite the post using this new angle.',
    'Rules: keep the author\'s original voice and tone, keep roughly the same length,',
    'do not add hashtags unless the original had them, do not start with I,',
    'do not use corporate buzzwords like synergy or leverage,',
    'return only the finished post text with no explanation, no preamble, no label',
    '— just the rewritten post ready to copy and paste.',
  ].join(' ');

  return `${part1}\n\n${part2}\n\n${part3}`;
}

// FUNCTION: buildAnalysisPrompt
// WHAT IT DOES: Constructs the three-part analysis prompt from draft + search results
// RECEIVES: draftText (string) — the user's post draft
//           searchResults (object[]) — up to 15 Serper results to include in context
// RETURNS: string — the complete prompt ready to send to Gemini
function buildAnalysisPrompt(draftText, searchResults) {
  // Cap at 15 results to keep the prompt a reasonable size — beyond that,
  // diminishing returns on analysis quality and increasing risk of token limits
  const capped = searchResults.slice(0, 15);

  // Part 1 — give Gemini the user's draft so it knows what to evaluate
  const part1 = `Here is a LinkedIn post draft the user wants to publish:\n\n${draftText}`;

  // Part 2 — give Gemini the search results as numbered context
  // Format each as "N. [title] — [snippet]" for clean, parseable structure
  const resultLines = capped.length > 0
    ? capped.map((r, i) => `${i + 1}. ${r.title} — ${r.snippet}`).join('\n')
    : '(No recent LinkedIn posts found on this topic)';

  const part2 = `Here are recent public LinkedIn posts on the same topic found via Google search:\n\n${resultLines}`;

  // Part 3 — the precise JSON output instruction with the exact shape required
  const part3 = `Analyse how repetitive this draft is compared to what has already been posted. Return ONLY a valid JSON object with no markdown, no explanation, no extra text — just raw JSON in exactly this shape:

{ "score": <number from 1 to 10 where 1 is highly original and 10 is extremely repetitive>, "repeated": <array of 2 to 4 short strings each describing a specific angle or phrase that is already common>, "suggestions": <array of exactly 3 objects each with { "title": <short label under 6 words>, "explanation": <one sentence on what to change>, "newAngle": <one sentence describing the specific reframe> }> }`;

  return `${part1}\n\n${part2}\n\n${part3}`;
}
