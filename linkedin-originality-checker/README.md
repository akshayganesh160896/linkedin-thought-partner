# LinkedIn Thought Partner

Your AI-powered writing partner for LinkedIn — checks if your post idea is repetitive, finds what's already been said, and rewrites your content to stand out.

`Chrome Extension` | `Manifest V3` | `Free to use`

---

## What it does

- **Checks originality** — scores your draft on a 1–10 scale showing how repetitive it is compared to recent LinkedIn posts
- **Finds similar content** — searches LinkedIn for posts on the same topic so you can see exactly what's already out there
- **Extracts key ideas** — uses Gemini AI to pull the core keyword phrases from your draft automatically
- **Suggests fresh angles** — generates three rewrite directions with specific new angles you can take to stand out
- **Rewrites your post** — one click on any suggestion rewrites your full draft in your own voice, ready to copy and paste

---

## How it works

1. **Paste your draft** into the sidebar text area on any page
2. **Keywords are extracted** from your draft using Google Gemini AI
3. **LinkedIn is searched** for recent posts on those keywords via Serper
4. **Originality is scored** — Gemini compares your draft against the results and returns a 1–10 repetitiveness score
5. **Rewrites are suggested** — three unique angles are offered; accept one and a full rewrite is generated instantly

---

## Setup

1. Get a free Gemini API key at [aistudio.google.com](https://aistudio.google.com) — click **Get API key**
2. Get a free Serper API key at [serper.dev](https://serper.dev) — sign up and copy your key from the dashboard
3. Download or clone this repo
   ```bash
   git clone https://github.com/your-username/linkedin-thought-partner.git
   ```
4. Open Chrome and go to `chrome://extensions`
5. Enable **Developer Mode** (toggle, top-right)
6. Click **Load unpacked** and select this project folder (the one containing `manifest.json`)
7. Click the extension icon in your toolbar to open the sidebar
8. Open **Settings** (⚙ icon) and paste both API keys
9. Click the toolbar icon on any page to open the sidebar and start scanning

> **Important:** Use the key from **Google AI Studio**, not the Google Cloud Console. The Cloud Console key has no free tier and returns quota errors immediately.

---

## API Keys

| Key | Where to get it | Free tier |
|---|---|---|
| Gemini API key | [aistudio.google.com](https://aistudio.google.com) | Yes — daily request limit |
| Serper API key | [serper.dev](https://serper.dev) | Yes — 2,500 searches/month |

Both keys are stored locally in your browser via `chrome.storage.local`. They are never sent anywhere except directly to each respective API endpoint. No server, no tracking, no accounts.

---

## File Structure

| File / Folder | What it does |
|---|---|
| `manifest.json` | Chrome Extension config — MV3 permissions and entry points |
| `content/sidebar.js` | The full sidebar UI — state machine, scan pipeline, all render functions |
| `content/sidebar.css` | All sidebar styles, scoped to `#loc-sidebar` to avoid host page conflicts |
| `background/service-worker.js` | Handles toolbar icon clicks and relays state changes to the sidebar |
| `settings/settings.html` | API key configuration page |
| `settings/settings.css` | Settings page styles |
| `settings/settings.js` | Reads and writes API keys via Chrome storage |
| `popup/popup.html` | Legacy popup (kept for reference, not active) |
| `popup/popup.js` | Legacy popup logic (kept for reference, not active) |
| `api/gemini.js` | Gemini API calls — keyword extraction, originality analysis, rewrite |
| `api/serper.js` | Serper search API calls |
| `utils/keywords.js` | Keyword extraction prompt builder and response parser |
| `utils/search.js` | LinkedIn-scoped query builder and result deduplicator |
| `utils/storage.js` | Thin wrapper around `chrome.storage.local` |
| `icons/` | Extension icons at 16px, 48px, and 128px |

---

## Limitations

- **24-hour window may return fewer results** — Google's index lags behind real-time LinkedIn posts by several hours. Use the 7-day window for more representative results.
- **Only publicly indexed LinkedIn posts are found** — posts set to "Connections only" or "Only me" are not indexed by Google and will not appear.
- **Gemini free tier has a daily request limit** — each scan makes two Gemini calls (keywords + analysis) plus an optional third for the rewrite. If you hit the limit, wait until the next UTC midnight for quota to reset.

---

## Contributing

Pull requests welcome. Please open an issue first to discuss what you'd like to change.

---

## License

MIT
