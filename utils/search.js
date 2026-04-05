// ============================================================
// FILE: search.js
// PURPOSE: Builds LinkedIn-targeted search queries from keywords,
//          runs all searches in parallel, and deduplicates results.
// DEPENDS ON: ../api/serper.js
// USED BY: popup.js (handleCheckClick)
// ============================================================

import { callSerper } from '../api/serper.js';


// ============================================================
// QUERY BUILDER
// ============================================================

// FUNCTION: buildQueries
// WHAT IT DOES: Converts keyword phrases into LinkedIn-scoped date-filtered queries
// RECEIVES: keywords (string[]) — phrases extracted from the post by Gemini
//           windowDays (number) — how many days back to search (1, 7, or 30)
// RETURNS: string[] — array of ready-to-search query strings
export function buildQueries(keywords, windowDays) {
  // Calculate the cutoff date by stepping back windowDays from today.
  // We use setDate() rather than subtracting milliseconds because it correctly
  // handles month boundaries (e.g. stepping back from March 1 lands on Feb 28/29).
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);

  // toISOString() returns "YYYY-MM-DDTHH:mm:ss.sssZ" — we only need the date part
  const dateStr = cutoff.toISOString().split('T')[0];

  // Build one query per keyword in the format Google understands:
  // site: restricts to LinkedIn posts, quotes enforce exact phrase match,
  // after: filters to content published since the cutoff date
  return keywords.map(kw => `site:linkedin.com/posts "${kw}" after:${dateStr}`);
}


// ============================================================
// SEARCH RUNNER
// ============================================================

// FUNCTION: runAllSearches
// WHAT IT DOES: Runs all keyword searches in parallel and returns deduplicated results
// RECEIVES: keywords (string[]) — extracted keyword phrases
//           windowDays (number) — time window for the after: filter
//           serperApiKey (string) — the user's Serper API key from Chrome storage
// RETURNS: Promise<object[]> — deduplicated array of { title, snippet, link }
export async function runAllSearches(keywords, windowDays, serperApiKey) {
  const queries = buildQueries(keywords, windowDays);

  // Fire all queries at the same time using Promise.all rather than awaiting each
  // one sequentially — this gets all results in the time of the slowest single
  // request instead of multiplying that time by the number of keywords
  const resultArrays = await Promise.all(
    queries.map(q => callSerper(q, serperApiKey))
  );

  // Flatten all per-query result arrays into a single pool to deduplicate across
  const flat = resultArrays.flat();

  // Use a Map keyed by URL to deduplicate — the same LinkedIn post can surface
  // across multiple keyword queries, and we only want to show the user each
  // source once regardless of how many queries matched it
  const seen = new Map();
  for (const result of flat) {
    if (result.link && !seen.has(result.link)) {
      seen.set(result.link, {
        title:   result.title   || '',
        snippet: result.snippet || '',
        link:    result.link,
      });
    }
  }

  return Array.from(seen.values());
}


// ============================================================
// LEGACY STUBS — kept for reference, superseded by buildQueries
// and runAllSearches above for the LinkedIn-specific workflow
// ============================================================

// FUNCTION: buildSearchQueries
// WHAT IT DOES: Converts keyword phrases into generic quoted Google search queries
// RECEIVES: keywords (string[]) — phrases extracted from the post by Gemini
// RETURNS: string[] — array of ready-to-search query strings
export function buildSearchQueries(keywords) {
  return keywords
    .map(kw => `"${kw}"`)
    .filter(Boolean)
    .slice(0, 5);
}

// FUNCTION: deduplicateResults
// WHAT IT DOES: Removes duplicate results that appear across multiple search queries
// RECEIVES: resultsArray (Array[]) — array of result arrays, one per query
// RETURNS: object[] — flat, deduplicated array of { title, link, snippet }
export function deduplicateResults(resultsArray) {
  const flat = resultsArray.flat();
  const seen = new Map();
  for (const r of flat) {
    if (r.link && !seen.has(r.link)) seen.set(r.link, r);
  }
  return Array.from(seen.values());
}

// FUNCTION: filterRelevantResults
// WHAT IT DOES: Removes results that are clearly unrelated to the original post
// RECEIVES: results (object[]) — deduplicated result objects { title, link, snippet }
//           keywords (string[]) — the original keywords to check relevance against
// RETURNS: object[] — results where at least one keyword appears in title or snippet
export function filterRelevantResults(results, keywords) {
  const lowerKeys = keywords.map(k => k.toLowerCase());
  return results.filter(r => {
    const haystack = `${r.title} ${r.snippet}`.toLowerCase();
    return lowerKeys.some(k => haystack.includes(k));
  });
}
