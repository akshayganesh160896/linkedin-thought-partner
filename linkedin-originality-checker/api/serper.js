// ============================================================
// FILE: serper.js
// PURPOSE: The single point of contact for all Serper web search
//          API calls — every search request goes through this file.
// DEPENDS ON: nothing (pure fetch calls)
// USED BY: utils/search.js
// ============================================================


// ============================================================
// CONSTANTS
// ============================================================

// Serper's search endpoint — returns Google search results as JSON
const SERPER_BASE_URL = 'https://google.serper.dev/search';

// Number of results to request per query
// 10 gives us enough to detect patterns without burning through quota
const RESULTS_PER_QUERY = 10;


// ============================================================
// MAIN EXPORT
// ============================================================

// FUNCTION: callSerper
// WHAT IT DOES: Sends a search query to Serper and returns the organic results
// RECEIVES: query (string) — the search string to look up
//           apiKey (string) — the user's Serper API key from Chrome storage
// RETURNS: Promise<Array> — array of result objects { title, link, snippet }
export async function callSerper(query, apiKey) {
  // Send the search request — Serper authenticates via a header, not a query param
  const response = await fetch(SERPER_BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
    },
    body: JSON.stringify({ q: query, num: 10 }),
  });

  // Surface HTTP-level failures with the status code so the caller
  // can distinguish auth errors (401/403) from network issues
  if (!response.ok) {
    const errJson = await response.json().catch(() => ({}));
    const errMsg = errJson?.message || response.statusText;
    throw new Error(`callSerper: request failed with status ${response.status} — ${errMsg}`);
  }

  const json = await response.json();

  // Serper returns results under the `organic` key — return empty array
  // rather than throwing if it's missing (e.g. zero results for the query)
  const raw = json.organic ?? [];

  return normaliseResults(raw);
}


// ============================================================
// PRIVATE HELPERS
// ============================================================

// FUNCTION: buildRequestBody
// WHAT IT DOES: Constructs the JSON body Serper expects for a search request
// RECEIVES: query (string) — the search string
// RETURNS: object — the complete request body
function buildRequestBody(query) {
  return { q: query, num: RESULTS_PER_QUERY };
}

// FUNCTION: normaliseResults
// WHAT IT DOES: Strips Serper results down to only the fields the app needs
// RECEIVES: rawResults (Array) — the raw organic array from Serper's response
// RETURNS: Array<object> — cleaned array of { title, link, snippet }
function normaliseResults(rawResults) {
  // Normalise to a consistent shape so the rest of the app never has to
  // worry about which fields Serper chose to include or omit for a given result
  return rawResults
    .filter(r => r.link)   // results without a URL are unusable
    .map(r => ({
      title:   r.title   || '',
      link:    r.link,
      snippet: r.snippet || '',
    }));
}
