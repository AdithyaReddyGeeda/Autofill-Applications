# Job Application Auto Fill

> A Chrome/Edge extension that stores your job application profile locally and intelligently auto-fills forms across major job portals — no server, no account, no data leaves your browser.

<!-- ![Extension popup](docs/images/popup.png) -->
<!-- ![Fill preview](docs/images/preview.gif) -->

---

## Why This Exists

Applying to jobs means retyping the same information hundreds of times across dozens of different form layouts. Most browser autofill breaks on custom dropdowns, ARIA widgets, and React-controlled inputs that modern ATS platforms use. This extension bridges that gap.

## Key Features

- **100% local storage** — profile data never leaves your machine; uses `chrome.storage.local` only
- **Intelligent field matching** — fuzzy token scoring with Levenshtein distance, synonym expansion, intent rules, and semantic inference (e.g. mapping experience to “years of experience” controls)
- **Custom dropdown support** — handles ARIA comboboxes, listboxes, radio groups, async-rendered menus, and platform-specific widgets (Workday `selectWidget`, Greenhouse, LinkedIn listboxes, etc.)
- **React-compatible event dispatch** — uses native property setters and `InputEvent` to survive React/Radix re-renders that revert plain `.value` assignments
- **Confidence-gated fills** — skips low-confidence matches instead of guessing; reports structured warnings in debug mode
- **Fill preview & dry-run mode** — review what will be filled before committing; undo support to revert changes
- **LinkedIn Easy Apply** — scoped to the active modal step; optional multi-step navigation via **Next** (never Submit/Review/Dismiss); stops when review or submit is shown, or when required fields block progression
- **Workday** — dedicated fill pass for custom controls, dynamic rescan waves after fills for conditional fields, optional final pass; progression stops if visible required fields stay empty
- **Required-field awareness** — shared detection (`required-fields.js`) for HTML/`aria` required markers and label asterisks; logs to console and highlights controls in **visual debug** mode when progression stops
- **Multiple resume variants** — store different resumes tagged by role; switch active resume from the popup
- **EEO / voluntary self-ID** — fills gender, race/ethnicity, veteran status, and disability fields when profile data is available
- **Security guardrails** — warns on HTTP pages, blocks fills into sensitive fields (SSN, bank, passport)
- **Keyboard shortcut** — `Alt+Shift+F` to trigger fill without opening the popup

## Supported Sites

The extension uses a generic detection strategy that works on most form-based pages, plus site-specific handlers for platforms where generic detection isn't enough.

| Site | Text Inputs | Native `<select>` | Custom Dropdowns | ARIA Radios | Notes |
|---|:---:|:---:|:---:|:---:|---|
| **Workday** | Yes | Yes | Yes | Yes | `data-automation-id` selectors, `selectWidget` / combobox; dynamic rescans; required-field gate before further passes |
| **Greenhouse** | Yes | Yes | Yes | Yes | Custom listbox with `role="option"` |
| **Lever** | Yes | Yes | Yes | Yes | Custom combobox triggers |
| **Ashby** | Yes | Yes | Yes | Yes | Radix-style ARIA radio groups, custom comboboxes |
| **LinkedIn** | Yes | Yes | Yes | Yes | Easy Apply: step-scoped match, multi-step **Next** flow, submit/review not auto-clicked (`AUTO_SUBMIT_LINKEDIN = false`) |
| **Indeed** | Yes | Yes | Partial | Yes | Standard apply flow supported; some embedded iframes may block |
| **Other ATS / custom sites** | Yes | Yes | Best-effort | Best-effort | Generic ARIA + CSS heuristic detection |

> **Partial** means the extension fills most fields but some edge cases (strict CSP iframes, unusual widgets) may require manual input.

## How It Works

```
┌─────────────┐     ┌───────────────┐     ┌──────────────┐     ┌────────────────┐
│ form-detector│────▶│ data-matcher  │────▶│ site-handlers│────▶│ content-script │
│ finds fields │     │ scores matches│     │ opens/picks  │     │ sets values &  │
│ on the page  │     │ against profile│    │ dropdown opts│     │ dispatches evts│
└─────────────┘     └───────────────┘     └──────────────┘     └────────────────┘
         ▲                                        ▲
         │ optional root scope                     │
         └────────────────────────────────────────┘
```

1. **Detection** — `form-detector.js` scans the DOM for inputs, selects, textareas, ARIA widgets, and custom dropdown triggers. Optional **`root`** scopes scanning to a subtree (e.g. the active LinkedIn Easy Apply step). It reads labels, `aria-label`, `name`, `id`, `data-automation-id`, and nearby text to build metadata for each field.

2. **Matching** — `data-matcher.js` scores each field's metadata against your stored profile: high-confidence intent rules, token match, synonym expansion, and Levenshtein distance. Fields scoring above the configurable threshold (default **0.38**) are queued for filling.

3. **Site-specific handling** — `site-handlers.js` checks the current hostname against a registry of known ATS platforms. When matched, it uses platform-specific selectors and interaction sequences (click to open, wait for async render, collect options, score, pick). Falls back to generic ARIA/CSS heuristics otherwise.

4. **LinkedIn Easy Apply** — `linkedin-easy-apply.js` finds the modal, the visible step container, and footer actions (Next vs Review vs Submit). `required-fields.js` validates before each **Next** and after each step fill.

5. **Fill execution** — `content-script.js` sets values using native prototype setters (`HTMLInputElement.prototype.value.set`) and dispatches a realistic event sequence (`focus` → `input` → `change` → `blur`) so React, Angular, and other frameworks detect the change.

6. **Safety** — Fills require matcher confidence ≥ **0.45** (`SAFE_MATCH_THRESHOLD`). Disabled, hidden, and placeholder options are filtered. Required fields that stay empty can **block** further LinkedIn steps or Workday rescans/final pass; reasons are **`console.warn`**’d and empty controls get **red outlines** when visual debug is on.

### File Structure

```
├── manifest.json            # Manifest V3 — scripts: site-handlers, required-fields, linkedin-easy-apply, …
├── background.js            # Service worker — messaging, context menu, keyboard shortcut
├── content-script.js        # Core fill logic, Workday/LinkedIn orchestration, event dispatch, debug marks
├── form-detector.js         # DOM scanning, optional root scope, metadata extraction
├── data-matcher.js          # Profile-to-field scoring, intent rules, Levenshtein distance
├── field-config.js          # Per-platform CSS selectors, dropdown trigger definitions
├── required-fields.js       # Shared required-field detection (HTML/ARIA/label *)
├── linkedin-easy-apply.js   # LinkedIn modal/step helpers, delegates required checks to required-fields
├── site-handlers.js         # Site-specific open/collect/pick for Workday, Greenhouse, LinkedIn, Indeed, …
├── popup.html / popup.js    # Side panel UI — fill, dry-run, undo, resume selector, history
├── popup-settings.html/.js  # Settings page — profile, resumes, education, experience, EEO
├── sidepanel.html           # Side panel entry point
├── styles.css               # In-page floating button styles
├── test-pages/              # Local HTML fixtures for manual regression testing
└── icons/                   # Extension icons
```

### Debug mode

Enable detailed console diagnostics (extension **Dev Mode** in settings, or in-page):

```js
// Browser console on the job application page:
enableAutofillDebug()
disableAutofillDebug()

// Verbose LinkedIn Easy Apply step logs:
window.__linkedinEaDebug = true
```

With dev mode on, the extension also applies **green / yellow / red** outlines and tooltips on fields unless `window.__autofillVisualDebug === false`. Red **fail** marks are used when required-field gating stops progression.

## Installation

### From source (developer mode)

1. Clone this repository:
   ```bash
   git clone https://github.com/AdithyaReddyGeeda/Autofill-Applications.git
   ```
2. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
3. Enable **Developer mode** (toggle in top-right corner).
4. Click **Load unpacked** and select the cloned folder.
5. Pin the extension to your toolbar for quick access.

### First-time setup

1. Click the extension icon → **Settings** (or go to `chrome://extensions` → Job Application Auto Fill → Details → Extension options).
2. Fill in your profile: name, email, phone, LinkedIn, location, skills, work authorization, EEO responses.
3. Add at least one resume (paste text or upload a PDF).
4. Navigate to any job application page and click **Fill Form** or press `Alt+Shift+F`.

<!-- ![Settings page](docs/images/settings.png) -->

## Privacy & Data Storage

| Question | Answer |
|---|---|
| Where is my data stored? | Locally in `chrome.storage.local`, never transmitted anywhere |
| Does the extension make network requests? | No. Zero external API calls, no analytics, no telemetry |
| Can websites read my stored profile? | No. Extension storage is isolated from page JavaScript |
| What permissions does it need? | `storage`, `activeTab`, `scripting`, `contextMenus`, `notifications` |
| Can I export/import my data? | Yes — JSON export/import is built into the settings page |
| Can I lock access? | The extension relies on your OS/browser profile for access control |

## Testing

Local HTML test pages in `test-pages/` simulate the field types this extension handles, so you can verify autofill behavior without visiting real job portals.

### Running tests

1. Load the extension and fill in your profile (see Installation above).
2. Open any test page by dragging the `.html` file into a browser tab.
3. Click **Fill Form** (floating button or context menu).
4. Check the **Event log** panel at the bottom of each page.

### Test fixtures

| Page | What it covers |
|---|---|
| `native-select.html` | Native `<select>` dropdowns, disabled options, EEO selects |
| `native-controls.html` | Native radio buttons, checkboxes, text/email/tel/url/number inputs, textarea |
| `custom-combobox.html` | ARIA `role="combobox"` + `role="listbox"`, ARIA radio groups, disabled options |
| `aria-radio-groups.html` | Three ARIA radio styles (pill, card, segmented) for EEO fields |
| `async-dropdown.html` | Options that render after a 400–600 ms delay, typeahead combobox |
| `workday-dropdown.html` | Workday `selectWidget` / `promptOption` / `promptLeafNode` / `menuItem` DOM structure |
| `react-controlled.html` | Inputs that revert `.value` unless proper `InputEvent` fires (React simulation) |
| `mixed-application.html` | Full multi-section form: text, selects, radios, ARIA comboboxes, ARIA radios, checkboxes |

### Verification checklist

| Behavior | Pages to check |
|---|---|
| Text fields receive correct profile values | `native-controls`, `mixed-application` |
| Native `<select>` picks the right option | `native-select`, `mixed-application` |
| Disabled / `aria-disabled` options are skipped | `native-select`, `custom-combobox`, `aria-radio-groups` |
| ARIA combobox opens, picks, and closes | `custom-combobox`, `mixed-application` |
| ARIA radio sets `aria-checked="true"` correctly | `aria-radio-groups`, `mixed-application` |
| Native radios check the right button | `native-controls`, `mixed-application` |
| Checkboxes toggle correctly | `native-controls`, `react-controlled`, `mixed-application` |
| Async-rendered options are awaited and selected | `async-dropdown` |
| Workday selectors and exclusion logic work | `workday-dropdown` |
| React controlled inputs persist (no revert) | `react-controlled` |
| `input` and `change` events fire for every field | All pages (check Event log) |

## Known Limitations

- **Required markers** — some sites don’t use `required` / `aria-required` or label asterisks consistently; the gate may miss “soft” required questions until the portal shows validation errors.
- **Cross-origin iframes** — some ATS platforms embed forms in iframes with restrictive Content Security Policy. The extension runs in `all_frames` but cannot bypass CSP-blocked frames.
- **File upload fields** — resume file inputs (`<input type="file">`) cannot be filled programmatically due to browser security restrictions. Required file fields block progression until you upload manually.
- **CAPTCHA / bot detection** — the extension dispatches realistic DOM events, but some sites may flag rapid form fills. Using dry-run mode first can help.
- **Dynamic field IDs** — some platforms generate random field IDs on each page load. The extension relies on labels and ARIA attributes rather than IDs, but edge cases exist.
- **LinkedIn / Workday DOM changes** — class names and automation IDs can shift; open an issue with a screenshot if a flow regresses.

## Roadmap

- [ ] Chrome Web Store publishing with proper review
- [ ] In-page fill preview modal (replace `confirm` dialog)
- [x] Multi-step LinkedIn Easy Apply with scoped steps and safety stops (ongoing tuning)
- [ ] Field-level confidence indicators in the UI
- [ ] Profile templates (e.g. "Frontend role" vs "Backend role" with different skills/summary)
- [ ] Import profile from LinkedIn PDF export
- [ ] Internationalization support for non-English job portals

## Contributing

This is a portfolio/personal project, but issues and suggestions are welcome. If you find a job portal where the extension fails, opening an issue with the site name and a screenshot of the form helps a lot.
