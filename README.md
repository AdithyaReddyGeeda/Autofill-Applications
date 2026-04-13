# Job Application Auto Fill Extension

Chrome/Edge Manifest v3 extension that stores applicant profile data locally and auto-fills job forms with intelligent matching.

## Features included

- Local profile storage with `chrome.storage.local`
- Security guardrails: warns on HTTP pages and blocks obvious sensitive identity/financial fields
- Site-aware + generic field detection (`LinkedIn`, `Indeed`, `Greenhouse`, `Lever`, `Workday`, `Ashby`)
- Matching hierarchy with fuzzy similarity + semantic years-of-experience inference
- Fill preview confirmation with confidence percentages
- Dry-run mode and undo support
- Floating in-page "Fill Form" button + context menu action
- Popup controls and settings page
- Multiple resume variants with role tags
- Cover letter template storage
- Form-layout reporting saved locally for future selector improvements

## File structure

```text
job-auto-fill-extension/
├── manifest.json
├── popup.html
├── popup.js
├── popup-settings.html
├── popup-settings.js
├── content-script.js
├── background.js
├── form-detector.js
├── data-matcher.js
├── field-config.js
├── site-handlers.js
├── styles.css
├── test-pages/
│   ├── native-select.html
│   ├── custom-combobox.html
│   ├── async-dropdown.html
│   └── react-controlled.html
└── README.md
```

## Load extension

1. Open Chrome/Edge extensions page (`chrome://extensions` / `edge://extensions`)
2. Enable Developer Mode
3. Click **Load unpacked**
4. Select this folder

## Manual Testing

Local HTML test pages are in `test-pages/` for verifying autofill behavior without visiting real job portals.

### Setup

1. Load the extension (see **Load extension** above).
2. Fill in your profile via the extension's settings page.
3. Open any test page directly in the browser (e.g. `File → Open` or drag the `.html` file into a tab).

### Test pages

| File | What it tests |
|---|---|
| `native-select.html` | Native `<select>` dropdowns, disabled options, EEO selects |
| `custom-combobox.html` | ARIA `role="combobox"` + `role="listbox"`, ARIA radio groups, disabled options |
| `async-dropdown.html` | Dropdowns whose options render after a delay (400–600 ms), typeahead input combobox |
| `react-controlled.html` | Inputs that revert `.value` unless proper `InputEvent` is dispatched (simulates React controlled components) |

### How to verify

1. Open a test page.
2. Click the extension's **Fill Form** button (floating button or context menu).
3. Check the **Event log** panel at the bottom of each page — it shows every `input`, `change`, and selection event that fired.
4. On `react-controlled.html`, watch the **Internal State** panel — if state updates match the filled values, native setters and event dispatch are working correctly. If values revert, the extension's event simulation needs fixing.

### Debug mode

Enable detailed console logging for dropdown autofill by running in the browser console:

```js
enableAutofillDebug()
```

This logs grouped diagnostics for every dropdown/radio fill attempt: trigger, options found, top candidates with scores, and the outcome. Disable with `disableAutofillDebug()`.

## Notes

- Data is local-only by design, no external API calls.
- Add proper PNG icons in `icons/` and set them in `manifest.json` if needed.
- Current preview uses `confirm` for speed; can be replaced by a richer in-page modal.
