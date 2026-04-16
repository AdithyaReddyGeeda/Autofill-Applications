(() => {
  const STATE = {
    profile: null,
    resumes: [],
    settings: {},
    education: [],
    experience: [],
    lastFilled: [],
    observer: null,
    navigationDebounce: null
  };

  const SENSITIVE_PATTERNS = /(ssn|social security|passport|routing|bank|credit card)/i;

  // ---------------------------------------------------------------------------
  //  Dropdown safety: threshold, logging, option filtering, warnings
  // ---------------------------------------------------------------------------

  /**
   * Minimum confidence score required to select a dropdown option.  Any match
   * below this value is treated as "no reliable match" and the field is left
   * untouched.  Raising this reduces false-positive fills; lowering it
   * increases recall at the cost of occasional wrong selections.
   */
  const SAFE_MATCH_THRESHOLD = 0.45;

  // ---------------------------------------------------------------------------
  //  Debug mode
  //
  //  Two ways to enable:
  //    1. Turn on "Dev Mode" in the extension settings page.
  //    2. Run in the browser console:  enableAutofillDebug()
  //
  //  When enabled, every dropdown / radio / select fill attempt logs a
  //  collapsed console group showing: field label, desired value, field type,
  //  trigger summary, options found, top-5 candidates with scores, and the
  //  outcome (picked / skipped + reason).
  // ---------------------------------------------------------------------------

  function isDebug() {
    return Boolean(STATE.settings?.devMode) || Boolean(window.__autofillDebug);
  }

  function ddLog(...args) {
    if (isDebug()) console.log("[Dropdown]", ...args);
  }
  function ddWarn(...args) {
    if (isDebug()) console.warn("[Dropdown]", ...args);
  }

  /** Human-readable one-liner describing a DOM element. */
  function elSummary(el) {
    if (!el) return "(null)";
    const tag = el.tagName?.toLowerCase() ?? "?";
    const parts = [tag];
    const role = el.getAttribute("role");
    if (role) parts.push(`role="${role}"`);
    const type = el.type;
    if (type) parts.push(`type="${type}"`);
    if (el.id) parts.push(`#${el.id}`);
    if (el.name) parts.push(`name="${el.name}"`);
    const aid = el.getAttribute("data-automation-id");
    if (aid) parts.push(`data-automation-id="${aid}"`);
    const cls = (el.className || "").toString().trim().slice(0, 60);
    if (cls) parts.push(`.${cls.split(/\s+/).slice(0, 2).join(".")}`);
    return `<${parts.join(" ")}>`;
  }

  /** Classify the control type for debug output. */
  function fieldTypeLabel(el) {
    if (!el) return "unknown";
    const tag = el.tagName?.toLowerCase() ?? "";
    const type = (el.type || "").toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (tag === "select") return "native-select";
    if (tag === "input" && type === "radio") return "native-radio";
    if (tag === "input" && type === "checkbox") return "checkbox";
    if (role === "radio") return "aria-radio";
    if (role === "combobox") return "combobox";
    if (role === "listbox") return "listbox";
    if (el.getAttribute("aria-haspopup")) return "custom-dropdown";
    if (tag === "textarea" || el.isContentEditable) return "text-area";
    if (tag === "input") return `input-${type || "text"}`;
    return tag;
  }

  /**
   * Log a rich, grouped diagnostic block for a single dropdown fill attempt.
   * Only produces output when debug mode is on.
   */
  function logDropdownAttempt({ label, wanted, fieldType, triggerEl, scored, outcome, reason }) {
    if (!isDebug()) return;
    const icon = outcome === "picked" ? "\u2705" : "\u274C";
    const header = `${icon} [Dropdown] ${fieldType} — wanted "${wanted}"`;
    console.groupCollapsed(header);
    console.log("Field label :", label || "(none)");
    console.log("Desired value:", wanted);
    console.log("Field type   :", fieldType);
    console.log("Trigger      :", elSummary(triggerEl));
    console.log("Options found:", scored?.length ?? 0);
    if (scored?.length) {
      const top5 = scored.slice(0, 5);
      console.log("Top candidates:");
      console.table(top5.map((s, i) => ({
        "#": i + 1,
        text: (s.text || s.label || "").slice(0, 80),
        score: s.score?.toFixed(3)
      })));
    }
    console.log("Outcome      :", outcome);
    if (reason) console.log("Reason       :", reason);
    if (triggerEl) console.log("Element      :", triggerEl);
    console.groupEnd();
  }

  /**
   * Structured warnings collected during a single fill pass.
   * Each entry includes all context needed for the post-fill summary.
   */
  const FILL_WARNINGS = [];

  function addFillWarning(warn) {
    FILL_WARNINGS.push(warn);
    logDropdownAttempt({
      label: warn.label,
      wanted: warn.wanted,
      fieldType: warn.fieldType || "unknown",
      triggerEl: warn.trigger,
      scored: warn.topCandidates,
      outcome: "skipped",
      reason: warn.reason
    });
  }

  function drainFillWarnings() {
    const copy = [...FILL_WARNINGS];
    FILL_WARNINGS.length = 0;
    return copy;
  }

  /**
   * Returns true when a DOM option node should be excluded from scoring.
   * Filters out disabled, hidden, aria-hidden, placeholder-text, and
   * duplicate-text options in a single pass.
   */
  function isOptionNodeUnsafe(node, seenTexts) {
    if (!node || node.nodeType !== 1) return true;
    if (node.getAttribute("aria-disabled") === "true") return true;
    if (node.hasAttribute("disabled")) return true;
    if (node.getAttribute("aria-hidden") === "true") return true;
    const style = node.getAttribute("style") || "";
    if (/display\s*:\s*none/i.test(style)) return true;
    const r = node.getBoundingClientRect?.();
    if (r && r.width < 1 && r.height < 1) return true;
    const text = (node.textContent || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 500) return true;
    if (/^(select|choose|please|pick|--|−|—|\.\.\.|\s)*$/i.test(text)) return true;
    if (seenTexts) {
      const key = text.toLowerCase();
      if (seenTexts.has(key)) return true;
      seenTexts.add(key);
    }
    return false;
  }

  function isExtensionContextValid() {
    try {
      return Boolean(chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function sendRuntimeMessage(message, callback) {
    try {
      if (!isExtensionContextValid()) return;
      chrome.runtime.sendMessage(message, callback || (() => void chrome.runtime.lastError));
    } catch {
      /* Extension context invalidated (reload/update). */
    }
  }

  function getStorage(key, fallback) {
    return new Promise((resolve) => {
      try {
        if (!isExtensionContextValid()) {
          resolve(fallback);
          return;
        }
        chrome.storage.local.get([key], (result) => {
          void chrome.runtime.lastError;
          resolve(result[key] ?? fallback);
        });
      } catch {
        resolve(fallback);
      }
    });
  }

  function setStorageLocal(patch) {
    try {
      if (!isExtensionContextValid()) return;
      chrome.storage.local.set(patch, () => void chrome.runtime.lastError);
    } catch {
      /* invalidated */
    }
  }

  function buildProfileForMatch() {
    const education = Array.isArray(STATE.education) ? STATE.education : [];
    const experience = Array.isArray(STATE.experience) ? STATE.experience : [];
    return {
      ...STATE.profile,
      education,
      experience
    };
  }

  const JOB_SITE_HOST_PATTERNS = [
    /linkedin\.com$/i,
    /indeed\./i,
    /greenhouse\.io$/i,
    /lever\.co$/i,
    /workday/i,
    /myworkdayjobs\.com$/i,
    /ashbyhq\.com$/i
  ];

  let lastSidePanelHref = "";

  const IS_TOP_WINDOW = window.self === window.top;

  function isJobApplicationHost() {
    return JOB_SITE_HOST_PATTERNS.some((re) => re.test(window.location.hostname));
  }

  function requestSidePanelOnJobSite() {
    if (!IS_TOP_WINDOW || !isJobApplicationHost()) return;
    const href = location.href;
    if (href === lastSidePanelHref) return;
    lastSidePanelHref = href;
    sendRuntimeMessage({ type: "openSidePanel" });
  }

  async function initState() {
    try {
      STATE.profile = await getStorage("profile", {});
      STATE.resumes = await getStorage("resumes", []);
      STATE.settings = await getStorage("settings", {});
      STATE.education = await getStorage("education", []);
      STATE.experience = await getStorage("experience", []);
      if (IS_TOP_WINDOW) {
        setupFloatingButton();
        startObserver();
        setTimeout(() => refreshFieldCountBadge(), 500);
        setTimeout(requestSidePanelOnJobSite, 1000);
      }
    } catch {
      /* Context invalidated mid-init. */
    }
  }

  window.addEventListener("popstate", () => {
    if (!IS_TOP_WINDOW) return;
    setTimeout(() => {
      lastSidePanelHref = "";
      requestSidePanelOnJobSite();
    }, 500);
  });

  function notify(message, type = "info") {
    sendRuntimeMessage({ type: "notify", payload: { message, level: type } });
  }

  function isHttpPage() {
    return window.location.protocol === "http:";
  }

  function showPreview(matches) {
    return new Promise((resolve) => {
      const existing = document.getElementById("job-autofill-preview-backdrop");
      if (existing) existing.remove();

      const backdrop = document.createElement("div");
      backdrop.id = "job-autofill-preview-backdrop";
      backdrop.style.cssText = [
        "position:fixed",
        "inset:0",
        "background:rgba(0,0,0,0.45)",
        "z-index:2147483646",
        "display:flex",
        "align-items:center",
        "justify-content:center",
        "padding:20px"
      ].join(";");

      const modal = document.createElement("div");
      modal.style.cssText = [
        "width:min(760px,95vw)",
        "max-height:80vh",
        "overflow:auto",
        "background:#fff",
        "border-radius:12px",
        "padding:14px",
        "box-shadow:0 24px 64px rgba(0,0,0,0.35)",
        "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif"
      ].join(";");

      const title = document.createElement("h3");
      title.textContent = `Preview Fill (${matches.length} fields)`;
      title.style.cssText = "margin:0 0 10px;font-size:16px;color:#101828;";
      modal.appendChild(title);

      const list = document.createElement("div");
      const inputRefs = [];
      list.style.cssText = "display:flex;flex-direction:column;gap:6px;margin-bottom:12px;";
      matches.forEach((m, index) => {
        const item = document.createElement("div");
        item.style.cssText = "border:1px solid #e4e7ec;border-radius:8px;padding:8px;font-size:12px;color:#344054;";
        const label = document.createElement("div");
        label.textContent = `${m.key} (${Math.round(m.confidence * 100)}%)`;
        label.style.cssText = "margin-bottom:4px;font-weight:600;";
        const input = document.createElement("input");
        input.type = "text";
        const previewValue =
          m.key === "cover_letter" || m.key === "resume_text" ? resolveMatchValue(m) : m.value;
        input.value = String(previewValue ?? "");
        input.dataset.index = String(index);
        input.style.cssText = "width:100%;padding:6px 8px;border:1px solid #d0d5dd;border-radius:6px;font-size:12px;";
        inputRefs.push(input);
        item.appendChild(label);
        item.appendChild(input);
        list.appendChild(item);
      });
      modal.appendChild(list);

      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:8px;justify-content:flex-end;";
      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "Cancel";
      cancelBtn.style.cssText = "border:0;background:#667085;color:#fff;border-radius:8px;padding:8px 12px;cursor:pointer;";
      const fillBtn = document.createElement("button");
      fillBtn.textContent = "Fill";
      fillBtn.style.cssText = "border:0;background:#2563eb;color:#fff;border-radius:8px;padding:8px 12px;cursor:pointer;";
      actions.appendChild(cancelBtn);
      actions.appendChild(fillBtn);
      modal.appendChild(actions);
      backdrop.appendChild(modal);
      document.body.appendChild(backdrop);

      function cleanup(result) {
        backdrop.remove();
        resolve(result);
      }

      cancelBtn.addEventListener("click", () => cleanup({ confirmed: false, overrides: {} }));
      fillBtn.addEventListener("click", () => {
        const overrides = {};
        inputRefs.forEach((input) => {
          overrides[input.dataset.index] = input.value;
        });
        cleanup({ confirmed: true, overrides });
      });
      backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop) cleanup({ confirmed: false, overrides: {} });
      });
    });
  }

  // ---------------------------------------------------------------------------
  //  Unified event dispatch & native property setters
  //
  //  React 16+ uses a synthetic event system and reads values via native
  //  property descriptors.  Setting el.value directly on a controlled input
  //  does nothing because React's setter intercepts it and reverts it on the
  //  next render.  We must:
  //    1. Call the *native* setter from the prototype (HTMLInputElement,
  //       HTMLTextAreaElement, HTMLSelectElement).
  //    2. Dispatch a proper focus → input → change → blur sequence so that
  //       React's event delegation (attached to the root) picks it up.
  //    3. Use InputEvent (not plain Event) for "input" so frameworks that
  //       inspect event.data / event.inputType see realistic values.
  // ---------------------------------------------------------------------------

  /** Set .value via the native prototype setter, bypassing React's override. */
  function setNativeValue(el, value) {
    const tag = el.tagName?.toLowerCase();
    let desc;
    if (tag === "textarea") {
      desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    } else if (tag === "select") {
      desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
    } else {
      desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    }
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
  }

  /** Set .checked via the native prototype setter, bypassing React's override. */
  function setNativeChecked(el, checked) {
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
    if (desc?.set) desc.set.call(el, checked);
    else el.checked = checked;
  }

  /**
   * Dispatch focus → input → change → blur on an element.
   * This is the exact sequence a real user interaction produces and the
   * minimum React / Angular / Vue need to detect a programmatic change.
   */
  function dispatchFieldEvents(el, value) {
    const opts = { bubbles: true, cancelable: true, composed: true };
    try { el.dispatchEvent(new FocusEvent("focus", { ...opts, relatedTarget: null })); } catch { /* ignore */ }
    try { el.dispatchEvent(new FocusEvent("focusin", { ...opts, relatedTarget: null })); } catch { /* ignore */ }
    try {
      el.dispatchEvent(new InputEvent("input", {
        ...opts,
        data: value != null ? String(value) : null,
        inputType: "insertText"
      }));
    } catch {
      el.dispatchEvent(new Event("input", opts));
    }
    try { el.dispatchEvent(new Event("change", opts)); } catch { /* ignore */ }
    try { el.dispatchEvent(new FocusEvent("blur", { ...opts, relatedTarget: null })); } catch { /* ignore */ }
    try { el.dispatchEvent(new FocusEvent("focusout", { ...opts, relatedTarget: null })); } catch { /* ignore */ }
  }

  /** Lightweight variant — only input + change (for radios, checkboxes, inner clicks). */
  function dispatchChangeEvents(el) {
    const opts = { bubbles: true, cancelable: true, composed: true };
    try { el.dispatchEvent(new Event("input", opts)); } catch { /* ignore */ }
    try { el.dispatchEvent(new Event("change", opts)); } catch { /* ignore */ }
  }

  // Legacy alias kept so existing call-sites that only need the value setter still work.
  function setNativeInputValue(el, value) { setNativeValue(el, value); }

  function formatDateValue(value, mode) {
    if (!value) return "";
    const raw = String(value).trim();
    if (!raw) return "";
    let date;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) date = new Date(`${raw}T00:00:00`);
    else if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) {
      const [mm, dd, yyyy] = raw.split("/").map(Number);
      date = new Date(yyyy, mm - 1, dd);
    } else {
      date = new Date(raw);
    }
    if (Number.isNaN(date.getTime())) return raw;
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return mode === "month" ? `${year}-${month}` : `${year}-${month}-${day}`;
  }

  // ---------------------------------------------------------------------------
  //  Dropdown option matching — normalisation, synonyms, scored comparison
  // ---------------------------------------------------------------------------

  const PLACEHOLDER_PATTERN = /^(select|choose|please|pick|--|−|—|\.\.\.|\s)*$/i;

  /** Normalise a string for option comparison: lowercase, collapse whitespace, strip punctuation. */
  function normChoice(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[''`]/g, "'")
      .replace(/[""]/g, '"')
      .replace(/[._\-–—,;:!?()[\]{}]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Strip ALL non-alphanumeric characters for ultra-fuzzy comparison. */
  function alphaOnly(s) {
    return s.replace(/[^a-z0-9]/g, "");
  }

  /** Common country / region synonym map (wanted → canonical alternatives). */
  const COUNTRY_SYNONYMS = {
    "us": ["united states", "united states of america", "usa", "u s a", "u s"],
    "usa": ["united states", "united states of america", "us", "u s a"],
    "united states": ["usa", "us", "united states of america", "u s a"],
    "united states of america": ["usa", "us", "united states"],
    "uk": ["united kingdom", "great britain", "gb", "england"],
    "united kingdom": ["uk", "great britain", "gb"],
    "uae": ["united arab emirates"],
    "united arab emirates": ["uae"]
  };

  /**
   * Expand a wanted value into a set of equivalent alternatives.
   * Returns an array that always includes the original.
   */
  function expandSynonyms(wanted) {
    const w = normChoice(wanted);
    const alts = [w];
    const mapped = COUNTRY_SYNONYMS[w];
    if (mapped) alts.push(...mapped.map(normChoice));
    return [...new Set(alts)];
  }

  function isYesLike(s)  { return /^(yes|y|true|1)$/i.test(s.trim()); }
  function isNoLike(s)   { return /^(no|n|false|0)$/i.test(s.trim()); }

  /**
   * Score how well an option (by its value attribute and visible text) matches
   * the wanted string.  Returns a number in [0, 1].
   *
   * Scoring tiers (highest wins):
   *   1.00  — exact visible-text or value match (case-insensitive, normalised)
   *   0.97  — synonym match (e.g. "US" wanted, option says "United States")
   *   0.95  — one string is a prefix of the other up to a word boundary
   *   0.93  — contains match (either direction)
   *   0.90  — value attribute contains / contained-in match
   *   0.88  — alpha-only (no spaces/punct) contains match
   *   0.86  — yes/no semantic match
   *   0.85  — "prefer not" / "decline" semantic match
   *   0.82  — numeric prefix match ("2" matches "2 years", "3+" matches "3")
   *   ≤0.8  — Levenshtein fuzzy similarity
   */
  function scoreChoiceMatch(wantedRaw, valueRaw, textRaw) {
    const w = normChoice(wantedRaw);
    if (!w) return 0;
    const val = normChoice(valueRaw);
    const text = normChoice(textRaw);

    // --- Tier 1: exact match ---
    if (text === w || val === w) return 1;

    // --- Tier 2: synonym expansion ---
    const alts = expandSynonyms(w);
    if (alts.length > 1) {
      for (const alt of alts) {
        if (alt === text || alt === val) return 0.97;
      }
    }

    // --- Tier 3: prefix/starts-with at a word boundary ---
    if (text.startsWith(w + " ") || w.startsWith(text + " ")) return 0.95;

    // --- Tier 4: contains ---
    if (text.includes(w) || w.includes(text)) return 0.93;
    if (val && (val.includes(w) || w.includes(val))) return 0.90;

    // --- Tier 5: alpha-only contains ---
    const wa = alphaOnly(w);
    const ta = alphaOnly(text);
    if (wa && ta && (ta.includes(wa) || wa.includes(ta))) return 0.88;

    // --- Tier 6: yes/no semantic match ---
    if (isYesLike(w)) {
      if (/\byes\b/.test(text) && !/\bno\b/.test(text)) return 0.86;
    }
    if (isNoLike(w)) {
      if (/\b(no|not |don't|do not|decline)\b/.test(text) && !/\byes\b/.test(text)) return 0.86;
    }

    // --- Tier 7: "prefer not to say" / "decline" ---
    if (/prefer not|decline|don't wish|do not wish/i.test(w) &&
        /prefer not|decline|don't wish|do not wish/i.test(text)) return 0.85;

    // --- Tier 8: numeric prefix ("2" ↔ "2 years", "3+" ↔ "3") ---
    const wNum = w.replace(/[^0-9.]/g, "");
    const tNum = text.replace(/[^0-9.]/g, "");
    if (wNum && tNum && wNum === tNum) return 0.82;

    // --- Tier 9: synonym expansion contains ---
    for (const alt of alts) {
      if (text.includes(alt) || alt.includes(text)) return 0.80;
    }

    // --- Tier 10: Levenshtein fuzzy ---
    const sim = window.JobAutofillMatcher;
    return Math.max(sim.similarity(w, text), val ? sim.similarity(w, val) : 0);
  }

  /** True if an <option> looks like a placeholder that should never be picked. */
  function isPlaceholderOption(opt) {
    const v = opt.value;
    const t = opt.textContent.trim();
    if (v === "" && (!t || PLACEHOLDER_PATTERN.test(t))) return true;
    if (v === "" && t === "") return true;
    if (PLACEHOLDER_PATTERN.test(t) && (v === "" || v === t)) return true;
    return false;
  }

  /**
   * Pick the best <option> inside a native <select> for a given wanted value.
   * Returns { option, score } or null.
   */
  function pickBestSelectOption(selectEl, wanted) {
    const w = String(wanted || "").trim();
    if (!w) return null;
    const seenTexts = new Set();
    const options = [...selectEl.querySelectorAll("option")].filter((opt) => {
      if (isPlaceholderOption(opt)) return false;
      if (opt.disabled) return false;
      const key = (opt.textContent || "").trim().toLowerCase();
      if (seenTexts.has(key)) return false;
      seenTexts.add(key);
      return true;
    });
    const scored = options.map((opt) => ({
      node: opt,
      text: (opt.textContent || "").trim(),
      score: scoreChoiceMatch(w, opt.value, opt.textContent)
    })).sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best || best.score < SAFE_MATCH_THRESHOLD) {
      addFillWarning({
        trigger: selectEl, wanted: w, reason: "native-select-low-confidence",
        label: selectEl.getAttribute("aria-label") || selectEl.name || "",
        fieldType: "native-select", bestText: best?.text, bestScore: best?.score,
        topCandidates: scored.slice(0, 5)
      });
      return null;
    }
    logDropdownAttempt({
      label: selectEl.getAttribute("aria-label") || selectEl.name || "",
      wanted: w, fieldType: "native-select", triggerEl: selectEl,
      scored, outcome: "picked", reason: null
    });
    return best.node;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isWorkdayJobsHost() {
    const h = window.location.hostname;
    return /workday\./i.test(h) || /myworkdayjobs\.com/i.test(h);
  }

  function isWorkdayDropdownTrigger(el) {
    if (!isWorkdayJobsHost() || !el || el.nodeType !== 1) return false;
    if (el.tagName === "INPUT") return false;
    const aid = el.getAttribute("data-automation-id") || "";
    if (aid === "selectWidget") return true;
    const id = el.id || "";
    if (el.tagName === "DIV" && id.includes("dropDownSelectList")) return true;
    if (/dropDown/i.test(aid)) {
      const tag = el.tagName;
      if (tag === "BUTTON") return true;
      if (tag === "DIV" && el.getAttribute("tabindex") !== null) return true;
      if (tag === "DIV" && el.getAttribute("role") === "button") return true;
    }
    return false;
  }

  function isWorkdayComboboxLike(el) {
    if (!el || el.tagName !== "INPUT") return false;
    const role = el.getAttribute("role") || "";
    const aid = el.getAttribute("data-automation-id") || "";
    return role === "combobox" || /\b(dropdown|multiselect|select|prompt|list)\b/i.test(aid);
  }

  function shouldUseWorkdayComboboxFill(el, matchKey) {
    return isWorkdayJobsHost() && String(matchKey || "").startsWith("eeo_") && isWorkdayComboboxLike(el);
  }


  function isWorkdayOptionExcluded(node) {
    return Boolean(node?.closest?.('[data-automation-id="selectedItem"]'));
  }

  function optionVisibleEnough(node) {
    const r = node.getBoundingClientRect?.();
    return r && r.width > 1 && r.height > 1;
  }

  /** Find the center of the nearest visible ancestor when el itself is 0x0 (hidden radios, etc.) */
  function visibleCenter(el) {
    try {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    } catch { /* ignore */ }
    let cur = el.parentElement;
    for (let i = 0; i < 6 && cur; i += 1) {
      try {
        const r = cur.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
      } catch { /* ignore */ }
      cur = cur.parentElement;
    }
    return { cx: 100, cy: 100 };
  }

  function dispatchFullPointerClick(el) {
    if (!el) return;
    const { cx, cy } = visibleCenter(el);
    const shared = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy };
    try {
      el.dispatchEvent(new PointerEvent("pointerdown", { ...shared, pointerId: 1, pointerType: "mouse" }));
      el.dispatchEvent(new MouseEvent("mousedown", { ...shared, button: 0 }));
      el.dispatchEvent(new PointerEvent("pointerup", { ...shared, pointerId: 1, pointerType: "mouse" }));
      el.dispatchEvent(new MouseEvent("mouseup", { ...shared, button: 0 }));
      el.dispatchEvent(new MouseEvent("click", { ...shared, button: 0 }));
    } catch {
      /* ignore */
    }
    try {
      if (typeof el.click === "function") el.click();
    } catch {
      /* ignore */
    }
  }

  function collectWorkdayListScores(wanted, requireVisible = true) {
    const scored = [];
    const seen = new Set();
    const seenTexts = new Set();
    const pushNode = (node, textSource) => {
      if (!node || seen.has(node) || isWorkdayOptionExcluded(node)) return;
      seen.add(node);
      // In relaxed mode, skip the full isOptionNodeUnsafe check (which
      // rejects nodes with 0×0 bounding rects during Workday animations).
      if (requireVisible) {
        if (isOptionNodeUnsafe(node, seenTexts)) return;
      } else {
        if (node.getAttribute("aria-disabled") === "true") return;
        if (node.hasAttribute("disabled")) return;
        const style = node.getAttribute("style") || "";
        if (/display\s*:\s*none/i.test(style)) return;
        const text = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || text.length > 500) return;
        if (/^(select|choose|please|pick|--|−|—|\.\.\.|\s)*$/i.test(text)) return;
        const key = text.toLowerCase();
        if (seenTexts.has(key)) return;
        seenTexts.add(key);
      }
      const text = normChoice(textSource || node.textContent || "");
      if (!text) return;
      scored.push({ node, text, score: scoreChoiceMatch(wanted, "", text) });
    };

    document.querySelectorAll('[data-automation-activepopup="true"] [role="option"]').forEach((node) => {
      pushNode(node);
    });
    document.querySelectorAll('[data-automation-id="promptOption"]').forEach((node) => {
      const opt = node.closest("[role=option]") || node;
      const labelAttr = (node.getAttribute("data-automation-label") || "").trim();
      pushNode(opt, labelAttr || opt.textContent);
    });
    document.querySelectorAll('[data-automation-id="menuItem"], [data-automation-id="promptLeafNode"]').forEach((node) => {
      const opt = node.closest("[role=option]") || node;
      pushNode(opt);
    });
    document.querySelectorAll('[role="listbox"] [role="option"]').forEach((node) => {
      pushNode(node);
    });
    document.querySelectorAll('ul[role="listbox"] li[role="option"], div[role="listbox"] [role="option"]').forEach((node) => {
      pushNode(node);
    });

    return scored.sort((a, b) => b.score - a.score);
  }

  async function pickAndClickWorkdayListOption(wantedRaw, triggerForVerify) {
    const wanted = String(wantedRaw || "").trim();
    if (!wanted) return false;

    // Progressive backoff: real Workday popups can take 1-3s to render options.
    let scored = [];
    const delays = [0, 500, 800, 1200];
    for (const delay of delays) {
      if (delay > 0) await sleep(delay);
      scored = collectWorkdayListScores(wanted, true);
      if (scored.length) break;
    }
    // Relaxed fallback: options may be in the DOM but not yet visible (0×0 rect)
    if (!scored.length) {
      scored = collectWorkdayListScores(wanted, false);
    }
    const best = scored[0];
    if (!best || best.score < SAFE_MATCH_THRESHOLD) {
      addFillWarning({
        trigger: triggerForVerify, wanted, reason: "workday-list-low-confidence",
        label: "", fieldType: "workday-dropdown",
        bestText: best?.text, bestScore: best?.score,
        topCandidates: scored.slice(0, 5)
      });
      try { document.body.click(); } catch { /* ignore */ }
      await sleep(120);
      return false;
    }
    const target = best.node;
    const radio = target.querySelector?.('input[type="radio"]');
    try {
      if (radio) {
        radio.focus?.();
        dispatchFullPointerClick(radio);
      } else {
        dispatchFullPointerClick(target);
      }
    } catch {
      return false;
    }
    await sleep(280);

    // Verify pick via site handler if available
    const wdHandler = window.JobAutofillSiteHandlers?.workdayHandler;
    let verified = true;
    if (triggerForVerify && wdHandler?.verifyPick) {
      verified = wdHandler.verifyPick(triggerForVerify, best.text);
      if (!verified) {
        logWorkdayAttempt({
          label: "", wanted, selector: elSummary(triggerForVerify),
          optionsFound: scored.length, topCandidates: scored.slice(0, 5),
          outcome: "retry", valueStuck: false
        });
        // Retry once: re-collect and re-pick
        await sleep(300);
        const retry = collectWorkdayListScores(wanted);
        const retryBest = retry[0];
        if (retryBest && retryBest.score >= SAFE_MATCH_THRESHOLD) {
          const rRadio = retryBest.node.querySelector?.('input[type="radio"]');
          if (rRadio) { rRadio.focus?.(); dispatchFullPointerClick(rRadio); }
          else { dispatchFullPointerClick(retryBest.node); }
          await sleep(280);
          verified = wdHandler.verifyPick(triggerForVerify, retryBest.text);
        }
      }
    }

    logWorkdayAttempt({
      label: "", wanted, selector: elSummary(triggerForVerify || target),
      optionsFound: scored.length, topCandidates: scored.slice(0, 5),
      outcome: verified ? "picked" : "pick-unverified", valueStuck: verified
    });
    logDropdownAttempt({
      label: "", wanted, fieldType: "workday-dropdown", triggerEl: target,
      scored, outcome: verified ? "picked" : "pick-unverified", reason: verified ? null : "value may not have stuck"
    });
    return true;
  }

  async function setWorkdayStyleChoiceControl(trigger, wantedRaw) {
    const wanted = String(wantedRaw || "").trim();
    if (!wanted) return null;
    trigger.scrollIntoView({ block: "center", inline: "nearest" });
    await sleep(150);
    try { trigger.focus?.(); } catch { /* ignore */ }
    dispatchFullPointerClick(trigger);
    await sleep(900);

    const wdHandler = window.JobAutofillSiteHandlers?.workdayHandler;
    if (wdHandler && !wdHandler.isPopupOpen()) {
      ddLog("workday: popup not detected after click, retrying");
      dispatchFullPointerClick(trigger);
      await sleep(1200);
    }

    await pickAndClickWorkdayListOption(wanted, trigger);
    return null;
  }

  async function setWorkdayComboboxFromInput(input, wantedRaw) {
    const wanted = String(wantedRaw || "").trim();
    if (!wanted) return null;
    input.scrollIntoView({ block: "center", inline: "nearest" });
    await sleep(80);
    try { input.focus(); } catch { /* ignore */ }
    dispatchFullPointerClick(input);
    await sleep(200);
    try {
      setNativeValue(input, "");
      setNativeValue(input, wanted);
      dispatchFieldEvents(input, wanted);
    } catch { /* ignore */ }
    await sleep(350);
    const opened = await pickAndClickWorkdayListOption(wanted, input);
    if (!opened) {
      try {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
      } catch { /* ignore */ }
      await sleep(400);
      await pickAndClickWorkdayListOption(wanted, input);
    }
    return null;
  }

  function parseAriaIdList(attr) {
    if (!attr) return [];
    return String(attr)
      .trim()
      .split(/\s+/)
      .map((id) => id.trim())
      .filter(Boolean);
  }

  function findListboxRootFromIds(trigger) {
    if (!trigger || trigger.nodeType !== 1) return null;
    for (const raw of [trigger.getAttribute("aria-controls"), trigger.getAttribute("aria-owns")]) {
      for (const id of parseAriaIdList(raw)) {
        const node = document.getElementById(id);
        if (!node) continue;
        const role = (node.getAttribute("role") || "").toLowerCase();
        if (role === "listbox") return node;
        const inner = node.querySelector?.('[role="listbox"]');
        if (inner) return inner;
      }
    }
    return null;
  }

  function collectGenericOptionCandidates(rootEl) {
    if (!rootEl?.querySelectorAll) return [];
    const out = [];
    const seenTexts = new Set();
    for (const node of rootEl.querySelectorAll('[role="option"]')) {
      if (isOptionNodeUnsafe(node, seenTexts)) continue;
      out.push(node);
    }
    return out;
  }

  function findListboxesWithVisibleOptions() {
    return [...document.querySelectorAll('[role="listbox"]')].filter(
      (lb) => collectGenericOptionCandidates(lb).length > 0
    );
  }

  function pickClosestListboxToTrigger(trigger, listboxes) {
    if (!listboxes?.length) return null;
    let tr;
    try {
      tr = trigger.getBoundingClientRect();
    } catch {
      return listboxes[listboxes.length - 1];
    }
    let best = listboxes[0];
    let bestScore = Infinity;
    for (const lb of listboxes) {
      let r;
      try {
        r = lb.getBoundingClientRect();
      } catch {
        continue;
      }
      const vert = r.top >= tr.bottom - 2 ? r.top - tr.bottom : Math.abs(r.top - tr.top);
      const horz = Math.max(0, Math.max(tr.left - r.right, r.left - tr.right));
      const dist = vert + horz * 0.15;
      if (dist < bestScore) {
        bestScore = dist;
        best = lb;
      }
    }
    return best;
  }

  function collectFallbackVisibleOptionsNearTrigger(triggerEl) {
    let tr;
    try {
      tr = triggerEl.getBoundingClientRect();
    } catch {
      tr = null;
    }
    const seenTexts = new Set();
    return [...document.querySelectorAll('[role="option"]')].filter((node) => {
      if (isOptionNodeUnsafe(node, seenTexts)) return false;
      if (!tr) return true;
      const r = node.getBoundingClientRect();
      return r.bottom >= tr.top - 40;
    });
  }

  async function setGenericDropdownValue(trigger, wantedRaw) {
    const wanted = String(wantedRaw || "").trim();
    if (!wanted) return null;

    const triggerRole = (trigger.getAttribute("role") || "").toLowerCase();

    const tryResolveOptions = () => {
      if (triggerRole === "listbox") {
        return collectGenericOptionCandidates(trigger);
      }
      const idLb = findListboxRootFromIds(trigger);
      if (idLb) {
        const fromId = collectGenericOptionCandidates(idLb);
        if (fromId.length) return fromId;
      }
      const lbs = findListboxesWithVisibleOptions();
      const closest = pickClosestListboxToTrigger(trigger, lbs);
      if (closest) {
        const fromLb = collectGenericOptionCandidates(closest);
        if (fromLb.length) return fromLb;
      }
      return [];
    };

    if (triggerRole !== "listbox") {
      try {
        trigger.scrollIntoView({ block: "center", inline: "nearest" });
      } catch {
        /* ignore */
      }
      await sleep(70);
      try {
        trigger.focus?.();
      } catch {
        /* ignore */
      }
    }

    let candidates = tryResolveOptions();
    if (!candidates.length && triggerRole !== "listbox") {
      dispatchFullPointerClick(trigger);
      const waits = [260, 220, 320, 400];
      for (const ms of waits) {
        await sleep(ms);
        candidates = tryResolveOptions();
        if (candidates.length) break;
        candidates = collectFallbackVisibleOptionsNearTrigger(trigger);
        if (candidates.length) break;
      }
    }

    if (!candidates.length && triggerRole !== "listbox") {
      dispatchFullPointerClick(trigger);
      await sleep(280);
      candidates = tryResolveOptions();
      if (!candidates.length) {
        candidates = collectFallbackVisibleOptionsNearTrigger(trigger);
      }
    }

    const scored = candidates.map((node) => {
      const label = (node.textContent || "").replace(/\s+/g, " ").trim();
      const aria = (node.getAttribute("aria-label") || "").trim();
      const val = (node.getAttribute("data-value") || node.getAttribute("value") || "").trim();
      const s = Math.max(scoreChoiceMatch(wanted, val, label), scoreChoiceMatch(wanted, val, aria));
      return { node, text: label || aria, score: s };
    }).sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best || best.score < SAFE_MATCH_THRESHOLD) {
      addFillWarning({
        trigger, wanted, reason: "generic-dropdown-low-confidence",
        label: trigger.getAttribute("aria-label") || "", fieldType: fieldTypeLabel(trigger),
        bestText: best?.text, bestScore: best?.score,
        topCandidates: scored.slice(0, 5)
      });
      try { document.body.click(); } catch { /* ignore */ }
      await sleep(80);
      return null;
    }
    try {
      best.node.scrollIntoView({ block: "center", inline: "nearest" });
    } catch {
      /* ignore */
    }
    const radio = best.node.querySelector?.('input[type="radio"]');
    try {
      if (radio) {
        radio.focus?.();
        dispatchFullPointerClick(radio);
      } else {
        dispatchFullPointerClick(best.node);
      }
    } catch {
      /* ignore */
    }
    dispatchChangeEvents(best.node);
    logDropdownAttempt({
      label: trigger.getAttribute("aria-label") || "", wanted,
      fieldType: fieldTypeLabel(trigger), triggerEl: trigger,
      scored, outcome: "picked", reason: null
    });
    await sleep(120);
    return null;
  }

  // ---------------------------------------------------------------------------
  //  Generic custom-dropdown handler (Ashby, Greenhouse, Lever, etc.)
  //  Works for any trigger with role="combobox", aria-haspopup="listbox", etc.
  //  Delegates to Workday-specific handlers when on a Workday host.
  // ---------------------------------------------------------------------------

  function isGenericCustomDropdown(el) {
    if (!el || el.nodeType !== 1) return false;
    if (isWorkdayDropdownTrigger(el)) return false;
    const tag = el.tagName?.toLowerCase();
    if (tag === "select" || tag === "textarea") return false;
    if (window.JobAutofillDetector?.isCustomDropdownTrigger?.(el)) return true;
    const role = (el.getAttribute("role") || "").toLowerCase();
    const hasPopup = (el.getAttribute("aria-haspopup") || "").toLowerCase();
    if (role === "combobox" || role === "listbox") return true;
    if (hasPopup === "listbox" || hasPopup === "menu") {
      return tag === "div" || tag === "button" || tag === "span" || tag === "a";
    }
    return false;
  }

  /** Collect scored option elements from any open listbox/menu in the DOM. */
  function collectGenericListboxScores(wanted) {
    const scored = [];
    const seen = new Set();
    const seenTexts = new Set();
    const push = (node) => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      if (isOptionNodeUnsafe(node, seenTexts)) return;
      const text = normChoice(node.textContent || "");
      if (!text) return;
      scored.push({ node, text, score: scoreChoiceMatch(wanted, "", text) });
    };
    document.querySelectorAll('[role="option"]').forEach(push);
    document.querySelectorAll('[role="listbox"] li').forEach(push);
    document.querySelectorAll('[data-value]').forEach((n) => {
      if (n.closest('[role="listbox"], [role="menu"], [aria-expanded="true"]')) push(n);
    });
    return scored.sort((a, b) => b.score - a.score);
  }

  /**
   * Open a custom dropdown trigger, wait for options to render, pick the best
   * match, click it, then dispatch change events. Returns previous selected text
   * or null if nothing was picked.
   */
  async function openAndPickDropdownOption(trigger, wantedRaw) {
    const wanted = String(wantedRaw || "").trim();
    if (!wanted) return null;

    // Remember what was selected before for undo.
    const prior = (trigger.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);

    // Scroll into view and open.
    try { trigger.scrollIntoView({ block: "center", inline: "nearest" }); } catch { /* ignore */ }
    await sleep(60);
    try { trigger.focus?.(); } catch { /* ignore */ }
    dispatchFullPointerClick(trigger);
    await sleep(400);

    // If the trigger is an <input role="combobox">, type into it to filter.
    const tag = trigger.tagName?.toLowerCase();
    if (tag === "input") {
      try {
        setNativeValue(trigger, "");
        setNativeValue(trigger, wanted);
        dispatchFieldEvents(trigger, wanted);
      } catch { /* ignore */ }
      await sleep(300);
    }

    // Try to find and click the best option from whatever menu appeared.
    let scored = collectGenericListboxScores(wanted);
    if (!scored.length) {
      await sleep(400);
      scored = collectGenericListboxScores(wanted);
    }
    const best = scored[0];
    if (!best || best.score < SAFE_MATCH_THRESHOLD) {
      addFillWarning({
        trigger, wanted, reason: "openAndPick-low-confidence",
        label: trigger.getAttribute("aria-label") || "", fieldType: fieldTypeLabel(trigger),
        bestText: best?.text, bestScore: best?.score,
        topCandidates: scored.slice(0, 5)
      });
      try { document.body.click(); } catch { /* ignore */ }
      try {
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
      } catch { /* ignore */ }
      await sleep(100);
      return null;
    }

    dispatchFullPointerClick(best.node);
    await sleep(200);

    dispatchFieldEvents(trigger, wanted);
    logDropdownAttempt({
      label: trigger.getAttribute("aria-label") || "", wanted,
      fieldType: fieldTypeLabel(trigger), triggerEl: trigger,
      scored, outcome: "picked", reason: null
    });
    return prior;
  }

  function usesSyntheticFill(el, matchKey) {
    if (isWorkdayDropdownTrigger(el) || shouldUseWorkdayComboboxFill(el, matchKey) || isGenericCustomDropdown(el)) return true;
    const siteHandlers = window.JobAutofillSiteHandlers;
    if (siteHandlers?.detectSiteHandler() && isGenericCustomDropdown(el)) return true;
    return false;
  }

  // ---------------------------------------------------------------------------
  //  Aria/Radix custom radio helpers
  // ---------------------------------------------------------------------------

  function isAriaCustomRadio(el) {
    return Boolean(
      el &&
        el.nodeType === 1 &&
        (el.getAttribute("role") || "").toLowerCase() === "radio" &&
        !(el.tagName?.toLowerCase() === "input" && (el.type || "").toLowerCase() === "radio")
    );
  }

  function ariaRadioGroupSelectedText(rg) {
    const opts = [...rg.querySelectorAll('[role="radio"]')].filter((n) => n.closest('[role="radiogroup"]') === rg);
    const cur = opts.find((n) => {
      const tag = n.tagName?.toLowerCase();
      if (tag === "input" && (n.type || "").toLowerCase() === "radio") return n.checked;
      return n.getAttribute("aria-checked") === "true" || n.getAttribute("data-state") === "checked";
    });
    return cur ? (cur.textContent || "").replace(/\s+/g, " ").trim() : "";
  }

  function ariaRadioSiblingsWithoutGroup(rep) {
    const p = rep.parentElement;
    if (!p) return [rep];
    const sibs = [...p.querySelectorAll(':scope > [role="radio"]')].filter(
      (n) => !(n.tagName?.toLowerCase() === "input" && (n.type || "").toLowerCase() === "radio")
    );
    return sibs.length ? sibs : [rep];
  }

  function setAriaRadioGroupValue(rep, value) {
    const w = String(value || "").trim();
    if (!w) return null;
    const rg = rep.closest('[role="radiogroup"]');
    let options;
    if (rg) {
      options = [...rg.querySelectorAll('[role="radio"]')].filter((n) => n.closest('[role="radiogroup"]') === rg);
    } else {
      options = ariaRadioSiblingsWithoutGroup(rep);
    }
    options = options.filter((n) => {
      if (n.tagName?.toLowerCase() === "input" && (n.type || "").toLowerCase() === "radio") return false;
      if (n.getAttribute("aria-disabled") === "true") return false;
      if (n.hasAttribute("disabled")) return false;
      return true;
    });
    const prior = rg
      ? ariaRadioGroupSelectedText(rg)
      : (() => {
          const cur = options.find(
            (n) =>
              n.getAttribute("aria-checked") === "true" || n.getAttribute("data-state") === "checked"
          );
          return cur ? (cur.textContent || "").replace(/\s+/g, " ").trim() : "";
        })();
    const scored = options.map((n) => {
      const label = (n.textContent || "").replace(/\s+/g, " ").trim();
      const aria = (n.getAttribute("aria-label") || "").trim();
      const s = Math.max(scoreChoiceMatch(w, "", label), scoreChoiceMatch(w, "", aria));
      return { node: n, text: label || aria, score: s };
    }).sort((a, b) => b.score - a.score);

    const rgLabel = rg?.getAttribute("aria-label") || "";
    const best = scored[0];
    if (!best || best.score < SAFE_MATCH_THRESHOLD) {
      addFillWarning({
        trigger: rep, wanted: w, reason: "aria-radio-low-confidence",
        label: rgLabel, fieldType: "aria-radio",
        bestText: best?.text, bestScore: best?.score,
        topCandidates: scored.slice(0, 5)
      });
      return null;
    }
    try {
      best.node.scrollIntoView({ block: "center", inline: "nearest" });
    } catch {
      /* ignore */
    }
    try {
      best.node.focus?.({ preventScroll: true });
    } catch {
      /* ignore */
    }
    dispatchFullPointerClick(best.node);
    dispatchChangeEvents(best.node);
    logDropdownAttempt({
      label: rgLabel, wanted: w, fieldType: "aria-radio", triggerEl: rep,
      scored, outcome: "picked", reason: null
    });
    return { __ariaRadio: true, previous: prior, target: best.node };
  }

  async function applyFieldValue(el, value, matchKey) {
    // 1. Aria/Radix custom radio buttons
    if (isAriaCustomRadio(el)) {
      return setAriaRadioGroupValue(el, value);
    }
    const tag = el.tagName?.toLowerCase();
    const type = (el.type || "").toLowerCase();
    // 2. Native radio inside a custom radiogroup — delegate to aria handler
    if (tag === "input" && type === "radio") {
      const rg = el.closest('[role="radiogroup"]');
      if (rg && rg.querySelector('[role="radio"]:not(input)')) {
        const first = rg.querySelector('[role="radio"]:not(input)');
        return setAriaRadioGroupValue(first, value);
      }
    }

    // 3. Site-specific dropdown handler (try first for recognized sites)
    const siteHandlers = window.JobAutofillSiteHandlers;
    if (siteHandlers && isGenericCustomDropdown(el)) {
      const handler = siteHandlers.detectSiteHandler();
      if (handler) {
        const result = await siteHandlers.siteSpecificDropdownFill(el, String(value || "").trim(), scoreChoiceMatch);
        if (result.warning) addFillWarning(result.warning);
        if (result.filled) {
          dispatchFieldEvents(el, value);
          return result.prior;
        }
        // Site handler didn't find a match — fall through to generic logic
      }
    }

    // 4. Workday-specific dropdown/combobox paths
    if (isWorkdayDropdownTrigger(el)) {
      return setWorkdayStyleChoiceControl(el, value);
    }
    if (shouldUseWorkdayComboboxFill(el, matchKey)) {
      return setWorkdayComboboxFromInput(el, value);
    }
    // 5. Generic custom dropdown fallback
    if (isGenericCustomDropdown(el)) {
      return openAndPickDropdownOption(el, value);
    }
    // 6. Standard native controls (input, select, textarea, contenteditable)
    return setFieldValue(el, value);
  }

  function labelTextForInput(input) {
    // 1. Explicit <label for="id">
    if (input.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (lab) return lab.textContent.replace(/\s+/g, " ").trim();
    }
    // 2. Input wrapped inside a <label>
    const wrap = input.closest("label");
    if (wrap) {
      const clone = wrap.cloneNode(true);
      clone.querySelectorAll("input,select,textarea,button").forEach((n) => n.remove());
      return clone.textContent.replace(/\s+/g, " ").trim();
    }
    // 3. aria-label attribute
    const aria = (input.getAttribute("aria-label") || "").trim();
    if (aria) return aria;
    // 4. Fallback: visible text in the immediate parent node (Greenhouse EEO style)
    const parent = input.parentNode;
    if (parent) {
      const clone = parent.cloneNode(true);
      clone.querySelectorAll("input,select,textarea,button").forEach((n) => n.remove());
      const text = clone.textContent.replace(/\s+/g, " ").trim().slice(0, 120);
      if (text) return text;
    }
    return "";
  }

  function radioGroupCheckedValue(scope, name) {
    if (!name) return "";
    const hit = scope.querySelector(`input[type="radio"][name="${CSS.escape(name)}"]:checked`);
    return hit ? hit.value : "";
  }

  /**
   * Walk the DOM around a hidden native radio to find the visible element that
   * a real user would click.  Walk up to 5 ancestors.
   */
  function findClickableForRadio(input) {
    if (!input) return null;
    // 1. Explicit <label for="id">
    if (input.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (lab) return lab;
    }
    // 2. Wrapping <label>
    const wrap = input.closest("label");
    if (wrap) return wrap;
    // 3. Any <label> in the DOM that contains this input
    try {
      const allLabels = document.querySelectorAll("label");
      for (const l of allLabels) {
        if (l.contains(input)) return l;
      }
    } catch { /* ignore */ }
    // 4. Walk parents looking for a visible, clickable container
    let cur = input.parentElement;
    for (let i = 0; i < 5 && cur; i += 1) {
      const btn = cur.querySelector('[role="radio"], button, [data-state]');
      if (btn && btn !== input) return btn;
      try {
        const r = cur.getBoundingClientRect();
        if (r.width > 10 && r.height > 10 && cur.contains(input)) return cur;
      } catch { /* ignore */ }
      cur = cur.parentElement;
    }
    return null;
  }

  function setRadioGroupValue(firstInGroup, value) {
    const scope = firstInGroup.form || document;
    const name = firstInGroup.name;
    if (!name) {
      firstInGroup.checked = true;
      return firstInGroup;
    }
    const group = [...scope.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`)].filter(
      (r) => !r.disabled
    );
    const w = String(value || "").trim();
    const scored = group.map((r) => {
      const label = labelTextForInput(r);
      const s = scoreChoiceMatch(w, r.value, label || r.getAttribute("aria-label") || "");
      return { node: r, text: label || r.value, score: s };
    }).sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (best && best.score >= SAFE_MATCH_THRESHOLD) {
      const clickTarget = findClickableForRadio(best.node);
      if (clickTarget) {
        try {
          clickTarget.scrollIntoView({ block: "center", inline: "nearest" });
        } catch { /* ignore */ }
        try {
          clickTarget.focus?.({ preventScroll: true });
        } catch { /* ignore */ }
        dispatchFullPointerClick(clickTarget);
      } else {
        try {
          best.node.focus?.({ preventScroll: true });
        } catch { /* ignore */ }
        dispatchFullPointerClick(best.node);
      }

      if (!best.node.checked) {
        group.forEach((r) => setNativeChecked(r, r === best.node));
        dispatchChangeEvents(best.node);
      }
      logDropdownAttempt({
        label: name, wanted: w, fieldType: "native-radio", triggerEl: firstInGroup,
        scored, outcome: "picked", reason: null
      });
      return best.node;
    }
    addFillWarning({
      trigger: firstInGroup, wanted: w, reason: "radio-low-confidence",
      label: name, fieldType: "native-radio",
      bestText: best?.text, bestScore: best?.score,
      topCandidates: scored.slice(0, 5)
    });
    return null;
  }

  function setFieldValue(el, value) {
    const tag = el.tagName.toLowerCase();
    const type = (el.type || "").toLowerCase();
    let oldValue;
    if (tag === "input" && type === "checkbox") {
      oldValue = el.checked;
    } else if (tag === "input" && type === "radio") {
      oldValue = radioGroupCheckedValue(el.form || document, el.name);
    } else {
      oldValue = el.value;
    }

    if (tag === "input" && type === "checkbox") {
      setNativeChecked(el, /true|yes|1/i.test(String(value)));
      dispatchFieldEvents(el, value);
      return oldValue;
    }

    if (tag === "input" && type === "radio") {
      const checkedEl = setRadioGroupValue(el, value);
      const target = checkedEl || el;
      dispatchFieldEvents(target, value);
      return oldValue;
    }

    if (el.isContentEditable) {
      el.textContent = value;
      dispatchFieldEvents(el, value);
      return oldValue;
    }

    if (tag === "textarea") {
      setNativeValue(el, value);
      dispatchFieldEvents(el, value);
      return oldValue;
    }

    if (tag === "input") {
      if (type === "date") setNativeValue(el, formatDateValue(value, "date"));
      else if (type === "month") setNativeValue(el, formatDateValue(value, "month"));
      else setNativeValue(el, value);
      dispatchFieldEvents(el, value);
      return oldValue;
    }

    if (tag === "select") {
      const opt = pickBestSelectOption(el, value);
      if (opt) {
        opt.selected = true;
        setNativeValue(el, opt.value);
      } else {
        setNativeValue(el, value);
      }
      dispatchFieldEvents(el, opt ? opt.value : value);
      return oldValue;
    }

    // Fallback for any other element (contenteditable divs, etc.)
    el.value = value;
    dispatchFieldEvents(el, value);
    return oldValue;
  }

  function getActiveResume() {
    const activeId = STATE.settings?.activeResumeId;
    if (!activeId) return null;
    return (STATE.resumes || []).find((item) => item.id === activeId) || null;
  }

  function displayFullName(p) {
    const fn = String(p?.first_name || "").trim();
    const ln = String(p?.last_name || "").trim();
    const joined = [fn, ln].filter(Boolean).join(" ");
    return joined || String(p?.full_name || "").trim();
  }

  function resolvePlaceholders(text) {
    const p = STATE.profile || {};
    return String(text || "")
      .replace(/\{\{name\}\}/gi, displayFullName(p))
      .replace(/\{\{email\}\}/gi, p.email || "")
      .replace(/\{\{role\}\}/gi, p.target_role || "");
  }

  function resolveMatchValue(match) {
    const p = STATE.profile || {};
    const active = getActiveResume();

    if (match.key === "cover_letter") {
      const fromResume = active?.coverLetter != null ? String(active.coverLetter) : "";
      const fromProfile = p.cover_letter != null ? String(p.cover_letter) : "";
      const raw = fromResume.trim() ? fromResume : fromProfile.trim() ? fromProfile : String(match.value ?? "");
      const interpolated = window.JobAutofillMatcher.interpolateCoverLetter(raw, p);
      return resolvePlaceholders(interpolated);
    }

    if (match.key === "resume_text") {
      const fromResume = active?.text != null ? String(active.text) : "";
      const fromProfile = p.resume_text != null ? String(p.resume_text) : "";
      const raw = fromResume.trim() ? fromResume : fromProfile.trim() ? fromProfile : String(match.value ?? "");
      const interpolated = window.JobAutofillMatcher.interpolateCoverLetter(raw, p);
      return resolvePlaceholders(interpolated);
    }

    return match.value;
  }

  function refreshFieldCountBadge() {
    try {
      const threshold = Number(STATE.settings?.matchThreshold ?? 0.38);
      const matches = window.JobAutofillDetector.detectAndMatch(buildProfileForMatch(), { threshold });
      sendRuntimeMessage({ type: "setBadge", payload: { count: matches.length } });
    } catch (_error) {
      sendRuntimeMessage({ type: "setBadge", payload: { count: 0 } });
    }
  }

  async function appendFillHistory(hostname, filledCount, matchedKeys) {
    const fillHistory = await getStorage("fillHistory", []);
    const next = [
      {
        hostname,
        timestamp: new Date().toISOString(),
        filledCount,
        keys: [...new Set(matchedKeys)]
      },
      ...fillHistory
    ].slice(0, 50);
    setStorageLocal({ fillHistory: next });
  }

  function highlightField(el) {
    const oldOutline = el.style.outline;
    const oldBoxShadow = el.style.boxShadow;
    el.style.outline = "2px solid #34c759";
    el.style.boxShadow = "0 0 0 4px rgba(52,199,89,0.2)";
    setTimeout(() => {
      el.style.outline = oldOutline;
      el.style.boxShadow = oldBoxShadow;
    }, 3000);
  }

  // ---------------------------------------------------------------------------
  //  Workday debug logging
  // ---------------------------------------------------------------------------

  function logWorkdayAttempt({ label, wanted, selector, optionsFound, topCandidates, outcome, valueStuck }) {
    if (!isDebug()) return;
    const icon = outcome === "picked" ? "\u2705" : outcome === "retry" ? "\u{1F504}" : "\u274C";
    console.groupCollapsed(`${icon} [Workday] wanted "${wanted}"`);
    console.log("Field label    :", label || "(none)");
    console.log("Desired value  :", wanted);
    console.log("Selector       :", selector || "(auto)");
    console.log("Options found  :", optionsFound ?? 0);
    if (topCandidates?.length) {
      console.log("Top candidates :");
      console.table(topCandidates.map((c, i) => ({
        "#": i + 1,
        text: (c.text || "").slice(0, 80),
        score: c.score?.toFixed(3)
      })));
    }
    console.log("Outcome        :", outcome);
    console.log("Value stuck    :", valueStuck);
    console.groupEnd();
  }

  // ---------------------------------------------------------------------------
  //  Workday label → profile value resolver
  //
  //  Uses the WORKDAY_QUESTION_MAP from site-handlers.js to map a Workday
  //  field's label text to the user's stored profile value.
  // ---------------------------------------------------------------------------

  function resolveWorkdayLabelValue(labelText, profile) {
    const siteHandlers = window.JobAutofillSiteHandlers;
    if (!siteHandlers?.workdayMatchLabel) return null;
    const key = siteHandlers.workdayMatchLabel(labelText);
    if (!key) return null;
    const eeo = profile.eeo_responses || {};
    const val = {
      work_authorization: profile.work_authorization || "",
      requires_sponsorship: (() => {
        const r = profile.requires_sponsorship;
        if (r === undefined || r === null || r === "") return "";
        return /^(yes|true|1)$/i.test(String(r).trim()) ? "Yes" : "No";
      })(),
      willing_to_relocate: (() => {
        const r = profile.willing_to_relocate;
        if (r === undefined || r === null || r === "") return "";
        return /^(yes|true|1)$/i.test(String(r).trim()) ? "Yes" : "No";
      })(),
      country: profile.country || profile.location || "",
      state: profile.state || "",
      city: profile.city || "",
      postal_code: profile.postal_code || "",
      eeo_gender: eeo.gender || profile.gender || "",
      eeo_race: eeo.race_ethnicity || eeo.race || eeo.ethnicity || "",
      eeo_veteran: eeo.veteran || eeo.veteran_status || "",
      eeo_disability: eeo.disability || eeo.disability_status || "",
      years_of_experience: (() => {
        const exp = Array.isArray(profile.experience) ? profile.experience : [];
        if (!exp.length) return profile.years_of_experience || "";
        return window.JobAutofillMatcher?.computeYearsOfExperience?.(exp) || profile.years_of_experience || "";
      })(),
      education_degree: (() => {
        const edu = Array.isArray(profile.education) ? profile.education : [];
        const last = edu[edu.length - 1];
        return last ? [last.degree, last.fieldOfStudy].filter(Boolean).join(" ").trim() : "";
      })(),
      first_name: profile.first_name || "",
      last_name: profile.last_name || "",
      email: profile.email || "",
      phone: profile.phone || "",
      linkedin: profile.linkedin || "",
      referral_contact: profile.referral_contact || "",
      salary_expectations: profile.salary_expectations || "",
      start_date_availability: profile.start_date_availability || "",
    }[key];
    if (!val) return null;
    return { key, value: val };
  }

  // ---------------------------------------------------------------------------
  //  Workday-specific fill pass
  //
  //  Runs BEFORE the generic fill for Workday pages.  Scans Workday-specific
  //  controls (custom dropdowns, text inputs with data-automation-id, etc.)
  //  and fills them using the question-label map + profile data.
  //
  //  After each successful fill, waits for the DOM to settle then rescans
  //  for dependent questions that may have appeared.  Repeats up to
  //  MAX_RESCAN_PASSES times.
  // ---------------------------------------------------------------------------

  const MAX_RESCAN_PASSES = 4;
  const WORKDAY_RESCAN_DELAY_MS = 900;

  function collectWorkdayFormFields() {
    const fields = [];
    const seen = new Set();

    const addField = (el, labelText) => {
      if (seen.has(el)) return;
      seen.add(el);
      fields.push({ element: el, label: labelText });
    };

    // Workday text/email/tel inputs
    document.querySelectorAll([
      'input[data-automation-id]',
      'textarea[data-automation-id]',
      'select[data-automation-id]'
    ].join(",")).forEach((el) => {
      if (el.type === "hidden" || el.type === "submit") return;
      const label = workdayFieldLabel(el);
      if (label) addField(el, label);
    });

    // Workday dropdown triggers
    const triggerSels = [
      '[data-automation-id="selectWidget"]',
      'button[data-automation-id*="dropDown"]',
      'button[data-automation-id*="DropDown"]',
      'div[data-automation-id*="dropDown"][tabindex]',
      'div[data-automation-id*="DropDown"][tabindex]',
      'div[id*="dropDownSelectList"]'
    ];
    for (const sel of triggerSels) {
      document.querySelectorAll(sel).forEach((el) => {
        const label = workdayFieldLabel(el);
        if (label) addField(el, label);
      });
    }

    // Workday combobox inputs (role="combobox")
    document.querySelectorAll('input[role="combobox"]').forEach((el) => {
      const label = workdayFieldLabel(el);
      if (label) addField(el, label);
    });

    return fields;
  }

  function workdayFieldLabel(el) {
    if (!el) return "";
    // 1. Explicit <label for>
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) return lab.textContent.replace(/\s+/g, " ").trim();
    }
    // 2. aria-label
    const aria = (el.getAttribute("aria-label") || "").trim();
    if (aria) return aria;
    // 3. aria-labelledby
    const lblBy = el.getAttribute("aria-labelledby");
    if (lblBy) {
      const parts = lblBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").filter(Boolean);
      if (parts.length) return parts.join(" ").replace(/\s+/g, " ").trim();
    }
    // 4. data-automation-id label pattern
    const aid = el.getAttribute("data-automation-id") || "";
    if (aid) {
      const labelEl = document.querySelector(`[data-automation-id="${CSS.escape(aid)}Label"]`) ||
                       document.querySelector(`label[data-automation-id="${CSS.escape(aid)}"]`);
      if (labelEl) return labelEl.textContent.replace(/\s+/g, " ").trim();
    }
    // 5. Walk up to find section heading
    let cur = el.parentElement;
    for (let i = 0; i < 6 && cur; i++) {
      const headings = cur.querySelectorAll("label, legend, h1, h2, h3, h4, [data-automation-id*=\"label\"], [data-automation-id*=\"Label\"]");
      for (const h of headings) {
        if (!h.contains(el)) {
          const text = h.textContent.replace(/\s+/g, " ").trim();
          if (text && text.length < 200) return text;
        }
      }
      cur = cur.parentElement;
    }
    return "";
  }

  function isWorkdayFieldAlreadyFilled(el) {
    const tag = el.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      return Boolean((el.value || "").trim());
    }
    if (tag === "select") {
      return el.selectedIndex > 0;
    }
    // For dropdown triggers, check if they have a selected item
    const selected = el.querySelector?.('[data-automation-id="selectedItem"]');
    if (selected) {
      const text = (selected.textContent || "").replace(/\s+/g, " ").trim();
      return Boolean(text) && !/^(select|choose|please|pick|--|−|—|\.\.\.|\s)*$/i.test(text);
    }
    return false;
  }

  async function workdayFillPass(profile, preview) {
    const siteHandlers = window.JobAutofillSiteHandlers;
    if (!siteHandlers?.isWorkday?.()) return { filled: 0, fieldKeys: [] };

    if (isDebug()) console.group("[Workday] Dedicated fill pass");

    let totalFilled = 0;
    const filledKeys = [];
    const filledElements = new Set();

    for (let pass = 0; pass <= MAX_RESCAN_PASSES; pass++) {
      const fields = collectWorkdayFormFields().filter((f) => !filledElements.has(f.element));
      if (!fields.length) break;

      if (isDebug() && pass > 0) {
        console.log(`[Workday] Rescan pass ${pass}: found ${fields.length} new field(s)`);
      }

      let filledThisPass = 0;

      for (const { element, label } of fields) {
        if (isWorkdayFieldAlreadyFilled(element)) continue;

        const resolved = resolveWorkdayLabelValue(label, profile);
        if (!resolved) continue;

        const { key, value } = resolved;
        if (!value) continue;

        // Check if user overrode this in preview
        const overrideIdx = preview?.overrides ? Object.entries(preview.overrides).find(
          ([, v]) => v === value
        ) : null;
        const fillValue = overrideIdx?.[1] || value;

        try {
          if (isDebug()) {
            console.log(`[Workday] Filling: label="${label}" key="${key}" value="${String(fillValue).slice(0, 60)}"`);
          }

          await applyFieldValue(element, fillValue, key);
          filledElements.add(element);
          totalFilled++;
          filledThisPass++;
          filledKeys.push(key);
          highlightField(element);

          // Wait for dependent questions to potentially appear
          await sleep(WORKDAY_RESCAN_DELAY_MS);

        } catch (err) {
          if (isDebug()) console.error(`[Workday] Fill error for "${label}":`, err);
        }
      }

      if (filledThisPass === 0) break;
    }

    if (isDebug()) {
      console.log(`[Workday] Fill pass complete: ${totalFilled} field(s) filled`);
      console.groupEnd();
    }

    return { filled: totalFilled, fieldKeys: filledKeys };
  }

  async function fillForm({ dryRun = false, matchThreshold } = {}) {
    STATE.profile = await getStorage("profile", {});
    STATE.resumes = await getStorage("resumes", []);
    STATE.settings = await getStorage("settings", {});
    STATE.education = await getStorage("education", []);
    STATE.experience = await getStorage("experience", []);

    // Expose devMode flag so site-handlers.js can read it for logging.
    try { window.__jobAutofillDevMode = isDebug(); } catch { /* ignore */ }

    if (isHttpPage()) {
      notify("Warning: page is not encrypted (HTTP).", "warning");
    }
    const threshold = Number(matchThreshold ?? STATE.settings?.matchThreshold ?? 0.38);
    const enrichedProfile = buildProfileForMatch();
    const matches = window.JobAutofillDetector.detectAndMatch(enrichedProfile, { threshold });
    if (!matches.length) {
      if (IS_TOP_WINDOW) {
        notify(
          "No fields matched in the top window. If the application is inside an embedded frame, use Fill again — every frame is scanned.",
          "info"
        );
      }
      return;
    }
    const preview = await showPreview(matches);
    if (!preview?.confirmed) return;
    if (dryRun) {
      notify(`Dry run complete: ${matches.length} fields would be filled.`, "info");
      return;
    }

    // Clear stale warnings from any previous fill pass.
    drainFillWarnings();

    if (isDebug()) {
      console.group(`[AutoFill] Fill pass — ${matches.length} matched field(s)`);
    }

    STATE.lastFilled = [];
    let filledCount = 0;
    let skippedCount = 0;
    const matchedKeys = [];

    // Run Workday-specific fill pass first for better coverage of Workday
    // custom controls and dependent questions that appear after filling.
    const isWorkday = window.JobAutofillSiteHandlers?.isWorkday?.() || false;
    if (isWorkday) {
      const wdResult = await workdayFillPass(enrichedProfile, preview);
      filledCount += wdResult.filled;
      matchedKeys.push(...wdResult.fieldKeys);
    }

    for (let index = 0; index < matches.length; index += 1) {
      const m = matches[index];
      const mergedText = `${m.meta.name} ${m.meta.id} ${m.meta.placeholder} ${m.meta.label} ${m.meta.nearText}`;
      if (SENSITIVE_PATTERNS.test(mergedText)) continue;
      try {
        const value = preview.overrides?.[String(index)] ?? resolveMatchValue(m);
        if (isDebug()) {
          console.log(
            `[AutoFill] #${index} key="${m.key}" value="${String(value).slice(0, 60)}"`,
            `type=${fieldTypeLabel(m.element)}`,
            elSummary(m.element)
          );
        }
        const raw = await applyFieldValue(m.element, value, m.key);
        if (isAriaCustomRadio(m.element) && raw == null) { skippedCount += 1; continue; }
        let previous;
        let filledElement = m.element;
        if (raw && typeof raw === "object" && raw.__ariaRadio) {
          previous = raw.previous;
          filledElement = raw.target || m.element;
        } else {
          previous = raw;
        }
        const synthetic = usesSyntheticFill(m.element, m.key);
        STATE.lastFilled.push({
          element: filledElement,
          previous,
          synthetic,
          ariaRadio: Boolean(raw && raw.__ariaRadio)
        });
        highlightField(filledElement);
        filledCount += 1;
        matchedKeys.push(m.key);
      } catch (_err) {
        if (isDebug()) console.error(`[AutoFill] #${index} error:`, _err);
      }
    }

    // On Workday, do a final rescan for dependent questions that appeared
    // after the main fill loop.
    if (isWorkday) {
      await sleep(WORKDAY_RESCAN_DELAY_MS);
      const postResult = await workdayFillPass(enrichedProfile, preview);
      filledCount += postResult.filled;
      matchedKeys.push(...postResult.fieldKeys);
    }

    // Report structured warnings for any dropdowns/radios that were skipped.
    const warnings = drainFillWarnings();
    if (warnings.length && isDebug()) {
      console.groupCollapsed(`[AutoFill] ${warnings.length} dropdown(s) skipped — summary`);
      console.table(warnings.map((w) => ({
        reason: w.reason,
        wanted: w.wanted,
        bestMatch: w.bestText ?? "—",
        score: w.bestScore?.toFixed(3) ?? "—",
        fieldType: w.fieldType ?? "—",
        label: w.label ?? "—"
      })));
      console.groupEnd();
    }
    skippedCount += warnings.length;

    if (isDebug()) {
      console.log(`[AutoFill] Done: ${filledCount} filled, ${skippedCount} skipped`);
      console.groupEnd();
    }

    sessionStorage.setItem("jobAutofillFilledCount", String(filledCount));
    appendFillHistory(window.location.hostname, filledCount, matchedKeys);
    updateFloatingButtonsAfterFill(filledCount);

    let msg = `Filled ${filledCount} fields successfully.`;
    if (skippedCount > 0) msg += ` ${skippedCount} dropdown(s) skipped (no confident match).`;
    notify(msg, skippedCount > 0 ? "warning" : "success");
  }

  function undoFill() {
    STATE.lastFilled.forEach((item) => {
      const el = item.element;
      if (!el) return;
      if (item.synthetic) return;
      if (item.ariaRadio) {
        const rg = el.closest('[role="radiogroup"]');
        const prev = String(item.previous || "").trim();
        if (rg && prev) {
          const first = [...rg.querySelectorAll('[role="radio"]')].find(
            (n) =>
              n.closest('[role="radiogroup"]') === rg &&
              !(n.tagName?.toLowerCase() === "input" && (n.type || "").toLowerCase() === "radio")
          );
          if (first) setAriaRadioGroupValue(first, prev);
        }
        dispatchChangeEvents(el);
        return;
      }
      if (el.tagName.toLowerCase() === "input" && el.type === "checkbox") {
        setNativeChecked(el, Boolean(item.previous));
      } else if (el.tagName.toLowerCase() === "input" && el.type === "radio") {
        const scope = el.form || document;
        const name = el.name;
        const prev = String(item.previous ?? "");
        [...scope.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`)].forEach((r) => {
          setNativeChecked(r, r.value === prev);
        });
      } else if (el.isContentEditable) {
        el.textContent = item.previous || "";
      } else {
        setNativeValue(el, item.previous || "");
      }
      dispatchFieldEvents(el, item.previous || "");
    });
    notify(`Undo complete for ${STATE.lastFilled.length} fields.`, "info");
    STATE.lastFilled = [];
    const undoBtn = document.getElementById("job-autofill-undo");
    if (undoBtn) undoBtn.remove();
  }

  function setupFloatingButton() {
    if (document.getElementById("job-autofill-fab")) return;
    const button = document.createElement("button");
    button.id = "job-autofill-fab";
    button.textContent = "Fill Form";
    button.style.cssText = [
      "position:fixed",
      "bottom:20px",
      "right:20px",
      "z-index:2147483647",
      "background:#2563eb",
      "color:#fff",
      "border:0",
      "border-radius:999px",
      "padding:10px 14px",
      "font-size:13px",
      "cursor:pointer",
      "box-shadow:0 6px 18px rgba(0,0,0,0.2)"
    ].join(";");
    button.addEventListener("click", () => void fillForm({ dryRun: false }).catch(() => {}));
    document.body.appendChild(button);
  }

  function updateFloatingButtonsAfterFill(filledCount) {
    const fillBtn = document.getElementById("job-autofill-fab");
    if (!fillBtn) return;
    const previousText = fillBtn.textContent;
    fillBtn.textContent = `✓ ${filledCount} filled`;
    setTimeout(() => {
      fillBtn.textContent = previousText;
    }, 4000);

    let undoBtn = document.getElementById("job-autofill-undo");
    if (!undoBtn) {
      undoBtn = document.createElement("button");
      undoBtn.id = "job-autofill-undo";
      undoBtn.textContent = "Undo";
      undoBtn.style.cssText = [
        "position:fixed",
        "bottom:20px",
        "right:118px",
        "z-index:2147483647",
        "background:#475467",
        "color:#fff",
        "border:0",
        "border-radius:999px",
        "padding:10px 14px",
        "font-size:13px",
        "cursor:pointer",
        "box-shadow:0 6px 18px rgba(0,0,0,0.2)"
      ].join(";");
      undoBtn.addEventListener("click", () => {
        undoFill();
        undoBtn.remove();
      });
      document.body.appendChild(undoBtn);
    }
  }

  function startObserver() {
    if (STATE.observer) return;
    STATE.observer = new MutationObserver(() => {
      if (!document.getElementById("job-autofill-fab")) setupFloatingButton();
      if (STATE.navigationDebounce) clearTimeout(STATE.navigationDebounce);
      STATE.navigationDebounce = setTimeout(() => {
        const hasMainOrForm = Boolean(document.querySelector("main, form"));
        if (hasMainOrForm) void initState().catch(() => {});
      }, 600);
    });
    STATE.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let shouldRefreshBadge = false;
    if (changes.profile) {
      STATE.profile = changes.profile.newValue || {};
      shouldRefreshBadge = true;
    }
    if (changes.resumes) STATE.resumes = changes.resumes.newValue || [];
    if (changes.settings) {
      STATE.settings = changes.settings.newValue || {};
      shouldRefreshBadge = true;
    }
    if (changes.education) {
      STATE.education = changes.education.newValue || [];
      shouldRefreshBadge = true;
    }
    if (changes.experience) {
      STATE.experience = changes.experience.newValue || [];
      shouldRefreshBadge = true;
    }
    if (shouldRefreshBadge) {
      try {
        refreshFieldCountBadge();
      } catch {
        /* invalidated */
      }
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "fillNow") {
      fillForm({
        dryRun: Boolean(message.payload?.dryRun),
        matchThreshold: message.payload?.matchThreshold
      })
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (message?.type === "undoFill") {
      undoFill();
      sendResponse({ ok: true });
    }
    if (message?.type === "reportFormLayout") {
      void (async () => {
        try {
          const [profile, education, experience] = await Promise.all([
            getStorage("profile", {}),
            getStorage("education", []),
            getStorage("experience", [])
          ]);
          STATE.profile = profile;
          STATE.education = education;
          STATE.experience = experience;
          const candidateFields = window.JobAutofillDetector.queryCandidateFields();
          const fields = candidateFields.slice(0, 60).map((el) => ({
            tag: el.tagName.toLowerCase(),
            type: el.type || "",
            name: el.name || "",
            id: el.id || "",
            role: el.getAttribute("role") || "",
            ariaLabel: el.getAttribute("aria-label") || "",
            ariaChecked: el.getAttribute("aria-checked") || "",
            dataState: el.getAttribute("data-state") || "",
            placeholder: el.getAttribute("placeholder") || "",
            nearText: (el.closest("div, section, fieldset, li, td, [role=radiogroup]") || el.parentElement || {}).textContent?.slice(0, 80)?.trim() || ""
          }));

          const rawDomScan = [];
          document.querySelectorAll('[role="radio"], [role="radiogroup"], input[type="radio"]').forEach((el) => {
            rawDomScan.push({
              tag: el.tagName.toLowerCase(),
              type: el.type || "",
              role: el.getAttribute("role") || "",
              name: el.name || "",
              id: el.id || "",
              ariaChecked: el.getAttribute("aria-checked") || "",
              dataState: el.getAttribute("data-state") || "",
              ariaLabel: el.getAttribute("aria-label") || "",
              text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100),
              parentRole: el.parentElement?.getAttribute("role") || "",
              classes: el.className?.toString?.()?.slice(0, 120) || ""
            });
          });

          const eeo = profile.eeo_responses || {};
          const diagnostics = {
            eeo_gender_saved: eeo.gender || "(empty — go to Settings and pick Gender)",
            eeo_race_saved: eeo.race_ethnicity || "(empty — go to Settings and pick Race)",
            eeo_veteran_saved: eeo.veteran || "(empty — go to Settings and pick Veteran Status)",
            eeo_disability_saved: eeo.disability || "(empty — go to Settings and pick Disability Status)",
            requires_sponsorship_saved: profile.requires_sponsorship || "(empty)",
            willing_to_relocate_saved: profile.willing_to_relocate || "(empty)",
            candidate_field_count: candidateFields.length,
            raw_radio_dom_elements: rawDomScan.length,
            raw_radio_dom: rawDomScan.slice(0, 30)
          };
          try {
            const matches = window.JobAutofillDetector.detectAndMatch(
              { ...profile, education, experience },
              { threshold: 0.3 }
            );
            diagnostics.matched_keys = matches.map((m) => `${m.key} → "${m.value}" (conf=${m.confidence?.toFixed(2)}, tag=${m.element?.tagName}, role=${m.element?.getAttribute("role") || ""})`);
          } catch (_e) {
            diagnostics.matched_keys = ["(error running match: " + String(_e?.message || _e) + ")"];
          }
          sendResponse({ ok: true, host: window.location.hostname, fields, diagnostics });
        } catch {
          sendResponse({ ok: false });
        }
      })();
      return true;
    }
    return undefined;
  });

  void initState().catch(() => {});

  // Expose console helpers so users can toggle debug without the settings UI.
  window.enableAutofillDebug = () => {
    window.__autofillDebug = true;
    try { window.__jobAutofillDevMode = true; } catch { /* ignore */ }
    console.log("[AutoFill] Debug mode ON — run Fill again to see diagnostics.");
  };
  window.disableAutofillDebug = () => {
    window.__autofillDebug = false;
    try { window.__jobAutofillDevMode = false; } catch { /* ignore */ }
    console.log("[AutoFill] Debug mode OFF.");
  };
})();
