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
├── styles.css
└── README.md
```

## Load extension

1. Open Chrome/Edge extensions page (`chrome://extensions` / `edge://extensions`)
2. Enable Developer Mode
3. Click **Load unpacked**
4. Select this folder

## Notes

- Data is local-only by design, no external API calls.
- Add proper PNG icons in `icons/` and set them in `manifest.json` if needed.
- Current preview uses `confirm` for speed; can be replaced by a richer in-page modal.
