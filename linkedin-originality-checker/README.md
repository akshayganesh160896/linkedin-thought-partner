# LinkedIn Thought Partner

Your AI-powered LinkedIn writing partner — checks if your post idea is repetitive, finds what's already been said, and rewrites your content to stand out. Paste your draft, click Scan, and the extension extracts key ideas with Google Gemini AI, searches for recent LinkedIn posts on the same topic via Serper, scores how repetitive your draft looks on a 1–10 scale, surfaces the angles that are already overused, and offers three rewritten versions that take a fresher angle — each with a one-click "Accept and rewrite" button and a "Copy to clipboard" action.

---

## Prerequisites

| Requirement | Where to get it |
|---|---|
| Google Chrome (desktop) | [chrome.google.com](https://chrome.google.com) |
| Gemini API key (free tier) | [aistudio.google.com](https://aistudio.google.com) — click **Get API key** |
| Serper API key (free tier) | [serper.dev](https://serper.dev) — sign up and copy your key from the dashboard |

> **Important:** Use the key from **Google AI Studio**, not the Google Cloud Console. The Cloud Console key has no free tier and will return quota errors immediately.

---

## Setup

1. **Clone or download this repository**

   ```bash
   git clone https://github.com/your-username/linkedin-originality-checker.git
   ```

2. **Load the extension in Chrome**

   - Open `chrome://extensions`
   - Enable **Developer mode** (toggle, top-right)
   - Click **Load unpacked**
   - Select the `linkedin-originality-checker/` folder (the one that contains `manifest.json`)
   - The extension icon appears in your Chrome toolbar — pin it for easy access

3. **Add your API keys**

   - Click the extension icon, then click the **⚙ gear** icon (or click the yellow dot if it appears)
   - Paste your Gemini API key and your Serper API key
   - Click **Save keys**
   - The gear icon dot turns green to confirm both keys are stored

4. **Run your first scan**

   - Paste a LinkedIn post draft into the text area
   - Choose a time window (24 hours / 7 days / 30 days)
   - Click **Scan**
   - Results appear in order: extracted keywords → posts found → originality score → rewrite suggestions

---

## How to reload after code changes

Go to `chrome://extensions` and click the **↺ refresh** icon on the extension card. The popup picks up the updated files immediately.

---

## File structure

| Path | Role |
|---|---|
| `manifest.json` | Chrome Extension config — MV3 permissions and entry points |
| `popup/popup.html` | HTML structure of the main popup panel |
| `popup/popup.css` | All visual styles for the popup |
| `popup/popup.js` | UI logic, pipeline orchestration, and render functions |
| `settings/settings.html` | API key configuration page (full-tab) |
| `settings/settings.css` | Styles for the settings page |
| `settings/settings.js` | Saves, loads, and clears API keys via Chrome storage |
| `background/service-worker.js` | Extension lifecycle management (MV3 service worker) |
| `api/gemini.js` | All calls to the Gemini API — keyword extraction, analysis, rewrite |
| `api/serper.js` | All calls to the Serper search API |
| `utils/keywords.js` | Keyword extraction prompt builder and response parser |
| `utils/search.js` | LinkedIn-scoped query builder and result deduplicator |
| `utils/storage.js` | Thin wrapper around `chrome.storage.local` |
| `icons/` | Extension icons at 16 px, 48 px, and 128 px |

---

## Limitations

- **24-hour window returns fewer results.** Google's index lags behind real-time LinkedIn posts by several hours, so very recent posts may not surface in the 24-hour window. Use 7 days for more representative results.
- **Only public LinkedIn posts are found.** Posts set to "Connections only" or "Only me" are not indexed by Google and will not appear in search results.
- **Gemini free tier has a daily request limit.** Each full scan makes two Gemini calls (keyword extraction + analysis) and an optional third for the rewrite. If you hit the daily limit, you will see a rate-limit error — wait until the next UTC day for the quota to reset. A production API key from Google Cloud (with billing enabled) removes this limit.
- **Serper free tier includes 2,500 searches per month.** Each scan fires one search per keyword (up to five), so a single scan uses up to five searches. The free tier is sufficient for regular personal use.
