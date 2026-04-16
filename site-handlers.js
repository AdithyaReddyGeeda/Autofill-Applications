(() => {
  // ---------------------------------------------------------------------------
  //  Site-specific dropdown handlers for major job portals
  //
  //  Each handler declares:
  //    id          – short slug
  //    match()     – returns true when the current page belongs to the site
  //    triggers    – CSS selectors for custom dropdown triggers on this site
  //    options     – CSS selectors for option containers / individual options
  //    open(trigger)           – how to open the dropdown (async)
  //    collectOptions(trigger) – gather visible option elements (returns array)
  //    pick(optionEl)          – click / select a single option (async)
  //
  //  The generic fallback is always available; site handlers only override
  //  the parts where the generic logic falls short.
  // ---------------------------------------------------------------------------

  const host = () => window.location.hostname;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  function pointerClick(el) {
    if (!el) return;
    const { cx, cy } = visibleCenter(el);
    const shared = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy };
    try {
      el.dispatchEvent(new PointerEvent("pointerdown", { ...shared, pointerId: 1, pointerType: "mouse" }));
      el.dispatchEvent(new MouseEvent("mousedown", { ...shared, button: 0 }));
      el.dispatchEvent(new PointerEvent("pointerup", { ...shared, pointerId: 1, pointerType: "mouse" }));
      el.dispatchEvent(new MouseEvent("mouseup", { ...shared, button: 0 }));
      el.dispatchEvent(new MouseEvent("click", { ...shared, button: 0 }));
    } catch { /* ignore */ }
    try { if (typeof el.click === "function") el.click(); } catch { /* ignore */ }
  }

  function optionVisible(node) {
    const r = node.getBoundingClientRect?.();
    return r && r.width > 1 && r.height > 1;
  }

  const PLACEHOLDER = /^(select|choose|please|pick|--|−|—|\.\.\.|\s)*$/i;

  const SAFE_THRESHOLD = 0.45;

  function isDebug() {
    try { return Boolean(window.__jobAutofillDevMode) || Boolean(window.__autofillDebug); } catch { return false; }
  }
  function ddLog(...args) {
    if (isDebug()) console.log("[SiteHandler]", ...args);
  }
  function ddWarn(...args) {
    if (isDebug()) console.warn("[SiteHandler]", ...args);
  }

  function cleanText(node) {
    return (node.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isPlaceholder(text) {
    return !text || text.length > 500 || PLACEHOLDER.test(text);
  }

  /** Returns true when an option node should be excluded from scoring. */
  function isOptionUnsafe(node, seenTexts) {
    if (!node || node.nodeType !== 1) return true;
    if (node.getAttribute("aria-disabled") === "true") return true;
    if (node.hasAttribute("disabled")) return true;
    if (node.getAttribute("aria-hidden") === "true") return true;
    const style = node.getAttribute("style") || "";
    if (/display\s*:\s*none/i.test(style)) return true;
    if (!optionVisible(node)) return true;
    const text = cleanText(node);
    if (isPlaceholder(text)) return true;
    if (seenTexts) {
      const key = text.toLowerCase();
      if (seenTexts.has(key)) return true;
      seenTexts.add(key);
    }
    return false;
  }

  // -------------------------------------------------------------------------
  //  Workday — question label → profile key mapping
  //
  //  Each entry is { pattern: RegExp, key: string }.  During the dedicated
  //  Workday fill pass the label text of every unfilled field is tested
  //  against these patterns.  The first match wins.
  // -------------------------------------------------------------------------
  const WORKDAY_QUESTION_MAP = [
    { pattern: /are you (legally )?(authorized|eligible) to work/i,                  key: "work_authorization" },
    { pattern: /do you (now or in the future )?require.*sponsor/i,                   key: "requires_sponsorship" },
    { pattern: /will you (now or in the future )?require.*sponsor/i,                 key: "requires_sponsorship" },
    { pattern: /require.*visa.*sponsor/i,                                            key: "requires_sponsorship" },
    { pattern: /require.*immigration.*sponsor/i,                                     key: "requires_sponsorship" },
    { pattern: /need.*sponsor/i,                                                     key: "requires_sponsorship" },
    { pattern: /country/i,                                                           key: "country" },
    { pattern: /state.*province|province.*state/i,                                   key: "state" },
    { pattern: /\bstate\b/i,                                                         key: "state" },
    { pattern: /\bcity\b/i,                                                          key: "city" },
    { pattern: /postal.*code|zip.*code/i,                                            key: "postal_code" },
    { pattern: /gender/i,                                                            key: "eeo_gender" },
    { pattern: /ethnicity|race/i,                                                    key: "eeo_race" },
    { pattern: /veteran/i,                                                           key: "eeo_veteran" },
    { pattern: /disability/i,                                                        key: "eeo_disability" },
    { pattern: /years of experience/i,                                               key: "years_of_experience" },
    { pattern: /highest.*education|education.*level|degree.*level/i,                 key: "education_degree" },
    { pattern: /willing to relocate|open to relocation/i,                            key: "willing_to_relocate" },
    { pattern: /preferred name|first name/i,                                         key: "first_name" },
    { pattern: /last name|family name/i,                                             key: "last_name" },
    { pattern: /email/i,                                                             key: "email" },
    { pattern: /phone/i,                                                             key: "phone" },
    { pattern: /linkedin/i,                                                          key: "linkedin" },
    { pattern: /how did you hear|source|referral/i,                                  key: "referral_contact" },
    { pattern: /salary|compensation|pay/i,                                           key: "salary_expectations" },
    { pattern: /start date|available.*start|earliest.*start/i,                       key: "start_date_availability" },
  ];

  // -------------------------------------------------------------------------
  //  Workday
  // -------------------------------------------------------------------------
  const workday = {
    id: "workday",
    match: () => /workday\./i.test(host()) || /myworkdayjobs\.com/i.test(host()),

    triggers: [
      '[data-automation-id="selectWidget"]',
      'div[id*="dropDownSelectList"]',
      'button[data-automation-id="selectWidget"]',
      'button[data-automation-id*="dropDown"]',
      'button[data-automation-id*="DropDown"]',
      'div[data-automation-id*="dropDown"][tabindex]',
      'div[data-automation-id*="DropDown"][tabindex]'
    ],

    options: {
      containers: [
        '[data-automation-activepopup="true"]',
        '[role="listbox"]'
      ],
      items: [
        '[data-automation-activepopup="true"] [role="option"]',
        '[data-automation-id="promptOption"]',
        '[data-automation-id="menuItem"]',
        '[data-automation-id="promptLeafNode"]',
        '[role="listbox"] [role="option"]'
      ]
    },

    /** Check whether the Workday popup container is present (visible OR just in the DOM). */
    isPopupOpen() {
      const popup = document.querySelector('[data-automation-activepopup="true"]');
      if (popup) return true;
      for (const sel of this.options.items) {
        if (document.querySelector(sel)) return true;
      }
      const lbs = document.querySelectorAll('[role="listbox"]');
      for (const lb of lbs) {
        if (lb.querySelector('[role="option"]')) return true;
        const r = lb.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
      }
      return false;
    },

    async open(trigger) {
      trigger.scrollIntoView({ block: "center", inline: "nearest" });
      await sleep(150);
      try { trigger.focus?.(); } catch { /* ignore */ }
      pointerClick(trigger);
      await sleep(900);

      if (!this.isPopupOpen()) {
        ddLog("workday: popup not detected after first click, retrying");
        pointerClick(trigger);
        await sleep(1200);
      }

      if (!this.isPopupOpen()) {
        ddLog("workday: popup still missing, third attempt with ArrowDown");
        try {
          trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true }));
        } catch { /* ignore */ }
        pointerClick(trigger);
        await sleep(1000);
      }
    },

    collectOptions() {
      const gather = (requireVisible) => {
        const seen = new Set();
        const out = [];
        const push = (node, textOverride) => {
          if (!node || seen.has(node)) return;
          if (node.closest?.('[data-automation-id="selectedItem"]')) return;
          if (requireVisible && !optionVisible(node)) return;
          if (node.getAttribute("aria-disabled") === "true") return;
          if (node.hasAttribute("disabled")) return;
          const style = node.getAttribute("style") || "";
          if (/display\s*:\s*none/i.test(style)) return;
          seen.add(node);
          const text = textOverride || cleanText(node);
          if (isPlaceholder(text)) return;
          out.push({ node, text });
        };
        for (const sel of this.options.items) {
          document.querySelectorAll(sel).forEach((n) => {
            if (sel.includes("promptOption")) {
              const opt = n.closest("[role=option]") || n;
              push(opt, (n.getAttribute("data-automation-label") || "").trim() || cleanText(opt));
            } else {
              push(n);
            }
          });
        }
        return out;
      };

      // Strict pass: require bounding-rect visibility
      const strict = gather(true);
      if (strict.length) return strict;

      // Relaxed pass: options may be in the DOM but still animating (0×0 rect)
      ddLog("workday: strict visibility found 0 options, trying relaxed pass");
      return gather(false);
    },

    /** Read the currently displayed value in a trigger widget. */
    readValue(trigger) {
      const selected = trigger.querySelector?.('[data-automation-id="selectedItem"]');
      if (selected) return cleanText(selected);
      const ariaLabel = (trigger.getAttribute("aria-label") || "").trim();
      const text = cleanText(trigger);
      if (text && !isPlaceholder(text) && text !== ariaLabel) return text;
      return "";
    },

    async pick(optionEl) {
      const radio = optionEl.querySelector?.('input[type="radio"]');
      if (radio) {
        radio.focus?.();
        pointerClick(radio);
      } else {
        pointerClick(optionEl);
      }
      await sleep(280);
    },

    /**
     * Verify the trigger reflects the expected value after a pick.
     * Returns true if the value stuck, false otherwise.
     */
    verifyPick(trigger, expectedText) {
      const current = this.readValue(trigger);
      if (!current) return false;
      const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
      const cur = norm(current);
      const exp = norm(expectedText);
      if (cur === exp) return true;
      if (cur.includes(exp) || exp.includes(cur)) return true;
      return false;
    },

    isComboboxInput(el) {
      if (!el || el.tagName !== "INPUT") return false;
      const role = el.getAttribute("role") || "";
      const aid = el.getAttribute("data-automation-id") || "";
      return role === "combobox" || /\b(dropdown|multiselect|select|prompt|list)\b/i.test(aid);
    }
  };

  // -------------------------------------------------------------------------
  //  Greenhouse
  // -------------------------------------------------------------------------
  const greenhouse = {
    id: "greenhouse",
    match: () => /greenhouse\.io/i.test(host()) || /boards\.greenhouse/i.test(host()),

    triggers: [
      '[role="combobox"]:not(input[type="text"])',
      '[aria-haspopup="listbox"]',
      'select.select__input',
      '[data-testid*="select"]',
      '.select-shell',
      'button[class*="select"]'
    ],

    options: {
      containers: ['[role="listbox"]', '.select__menu', 'ul.select-list'],
      items: ['[role="option"]', '.select__option', 'li.select-list__item']
    },

    async open(trigger) {
      trigger.scrollIntoView({ block: "center", inline: "nearest" });
      await sleep(80);
      try { trigger.focus?.(); } catch { /* ignore */ }
      pointerClick(trigger);
      await sleep(350);
    },

    collectOptions(trigger) {
      const out = [];
      const seen = new Set();
      const push = (node) => {
        if (!node || seen.has(node)) return;
        if (!optionVisible(node)) return;
        seen.add(node);
        const text = cleanText(node);
        if (isPlaceholder(text)) return;
        out.push({ node, text });
      };

      const controls = trigger.getAttribute("aria-controls") || trigger.getAttribute("aria-owns") || "";
      if (controls) {
        for (const id of controls.split(/\s+/).filter(Boolean)) {
          const el = document.getElementById(id);
          if (el) el.querySelectorAll('[role="option"], li').forEach(push);
        }
      }
      if (!out.length) {
        for (const sel of this.options.items) {
          document.querySelectorAll(sel).forEach(push);
        }
      }
      return out;
    },

    async pick(optionEl) {
      pointerClick(optionEl);
      await sleep(150);
    }
  };

  // -------------------------------------------------------------------------
  //  Lever
  // -------------------------------------------------------------------------
  const lever = {
    id: "lever",
    match: () => /lever\.co/i.test(host()) || /jobs\.lever/i.test(host()),

    triggers: [
      '[role="combobox"]:not(input[type="text"])',
      '[aria-haspopup="listbox"]',
      '.postings-select',
      'button[class*="dropdown"]',
      '[data-qa*="select"]'
    ],

    options: {
      containers: ['[role="listbox"]', '.dropdown-menu', 'ul[class*="dropdown"]'],
      items: ['[role="option"]', '.dropdown-menu li', '.dropdown-menu-item']
    },

    async open(trigger) {
      trigger.scrollIntoView({ block: "center", inline: "nearest" });
      await sleep(80);
      try { trigger.focus?.(); } catch { /* ignore */ }
      pointerClick(trigger);
      await sleep(300);
    },

    collectOptions(trigger) {
      const out = [];
      const seen = new Set();
      const push = (node) => {
        if (!node || seen.has(node)) return;
        if (!optionVisible(node)) return;
        seen.add(node);
        const text = cleanText(node);
        if (isPlaceholder(text)) return;
        out.push({ node, text });
      };

      const controlled = trigger.getAttribute("aria-controls") || "";
      if (controlled) {
        const el = document.getElementById(controlled);
        if (el) el.querySelectorAll('[role="option"], li').forEach(push);
      }
      if (!out.length) {
        for (const sel of this.options.items) {
          document.querySelectorAll(sel).forEach(push);
        }
      }
      return out;
    },

    async pick(optionEl) {
      pointerClick(optionEl);
      await sleep(150);
    }
  };

  // -------------------------------------------------------------------------
  //  Ashby
  // -------------------------------------------------------------------------
  const ashby = {
    id: "ashby",
    match: () => /ashbyhq\.com/i.test(host()) || /jobs\.ashby/i.test(host()),

    triggers: [
      '[role="combobox"]:not(input[type="text"])',
      '[aria-haspopup="listbox"]',
      'button[class*="Select"]',
      'button[class*="select"]',
      '[data-testid*="select"]'
    ],

    options: {
      containers: ['[role="listbox"]', '[data-radix-popper-content-wrapper]'],
      items: ['[role="option"]', '[data-radix-collection-item]']
    },

    async open(trigger) {
      trigger.scrollIntoView({ block: "center", inline: "nearest" });
      await sleep(60);
      try { trigger.focus?.(); } catch { /* ignore */ }
      pointerClick(trigger);
      await sleep(400);

      if (trigger.getAttribute("aria-expanded") !== "true") {
        pointerClick(trigger);
        await sleep(300);
      }
    },

    collectOptions(trigger) {
      const out = [];
      const seen = new Set();
      const push = (node) => {
        if (!node || seen.has(node)) return;
        if (!optionVisible(node)) return;
        if (node.getAttribute("aria-disabled") === "true") return;
        seen.add(node);
        const text = cleanText(node);
        if (isPlaceholder(text)) return;
        out.push({ node, text });
      };

      const controlled = trigger.getAttribute("aria-controls") || "";
      if (controlled) {
        const el = document.getElementById(controlled);
        if (el) el.querySelectorAll('[role="option"], [data-radix-collection-item]').forEach(push);
      }
      if (!out.length) {
        document.querySelectorAll('[data-radix-popper-content-wrapper] [role="option"]').forEach(push);
      }
      if (!out.length) {
        for (const sel of this.options.items) {
          document.querySelectorAll(sel).forEach(push);
        }
      }
      return out;
    },

    async pick(optionEl) {
      pointerClick(optionEl);
      await sleep(200);
    }
  };

  // -------------------------------------------------------------------------
  //  LinkedIn
  // -------------------------------------------------------------------------
  const linkedin = {
    id: "linkedin",
    match: () => /linkedin\.com/i.test(host()),

    triggers: [
      '[role="combobox"]:not(input[type="text"])',
      '[aria-haspopup="listbox"]',
      'select[data-test-text-selectable-option]',
      'button[data-test-text-selectable-option]',
      '.jobs-easy-apply-form-element select',
      '.fb-dash-form-element select'
    ],

    options: {
      containers: ['[role="listbox"]', '.fb-dropdown-listbox', 'ul[class*="typeahead"]'],
      items: ['[role="option"]', '.fb-dropdown-listbox li', '.basic-typeahead__selectable']
    },

    async open(trigger) {
      trigger.scrollIntoView({ block: "center", inline: "nearest" });
      await sleep(60);
      try { trigger.focus?.(); } catch { /* ignore */ }
      pointerClick(trigger);
      await sleep(350);
    },

    collectOptions(trigger) {
      const out = [];
      const seen = new Set();
      const push = (node) => {
        if (!node || seen.has(node)) return;
        if (!optionVisible(node)) return;
        seen.add(node);
        const text = cleanText(node);
        if (isPlaceholder(text)) return;
        out.push({ node, text });
      };

      const controlled = trigger.getAttribute("aria-controls") || trigger.getAttribute("aria-owns") || "";
      if (controlled) {
        for (const id of controlled.split(/\s+/).filter(Boolean)) {
          const el = document.getElementById(id);
          if (el) el.querySelectorAll('[role="option"], li').forEach(push);
        }
      }
      if (!out.length) {
        for (const sel of this.options.items) {
          document.querySelectorAll(sel).forEach(push);
        }
      }
      return out;
    },

    async pick(optionEl) {
      pointerClick(optionEl);
      await sleep(150);
    }
  };

  // -------------------------------------------------------------------------
  //  Indeed
  // -------------------------------------------------------------------------
  const indeed = {
    id: "indeed",
    match: () => /indeed\./i.test(host()) || /indeed\.com/i.test(host()),

    triggers: [
      '[role="combobox"]:not(input[type="text"])',
      '[aria-haspopup="listbox"]',
      'button[data-testid*="dropdown"]',
      'button[data-testid*="select"]',
      '[class*="DropdownButton"]'
    ],

    options: {
      containers: ['[role="listbox"]', '[data-testid*="dropdown-menu"]', 'ul[class*="Dropdown"]'],
      items: ['[role="option"]', '[data-testid*="dropdown-item"]', 'li[class*="DropdownItem"]']
    },

    async open(trigger) {
      trigger.scrollIntoView({ block: "center", inline: "nearest" });
      await sleep(60);
      try { trigger.focus?.(); } catch { /* ignore */ }
      pointerClick(trigger);
      await sleep(350);
    },

    collectOptions(trigger) {
      const out = [];
      const seen = new Set();
      const push = (node) => {
        if (!node || seen.has(node)) return;
        if (!optionVisible(node)) return;
        seen.add(node);
        const text = cleanText(node);
        if (isPlaceholder(text)) return;
        out.push({ node, text });
      };

      const controlled = trigger.getAttribute("aria-controls") || "";
      if (controlled) {
        const el = document.getElementById(controlled);
        if (el) el.querySelectorAll('[role="option"], li').forEach(push);
      }
      if (!out.length) {
        for (const sel of this.options.items) {
          document.querySelectorAll(sel).forEach(push);
        }
      }
      return out;
    },

    async pick(optionEl) {
      pointerClick(optionEl);
      await sleep(150);
    }
  };

  // -------------------------------------------------------------------------
  //  Registry — ordered so the first match wins
  // -------------------------------------------------------------------------
  const SITE_HANDLERS = [workday, greenhouse, lever, ashby, linkedin, indeed];

  /**
   * Return the handler for the current page, or null if no site-specific
   * handler matches (generic logic should be used instead).
   */
  function detectSiteHandler() {
    return SITE_HANDLERS.find((h) => h.match()) || null;
  }

  /**
   * Attempt a site-specific dropdown fill.
   *
   * @param {Element}  trigger  – the dropdown trigger element
   * @param {string}   wanted   – the desired value to select
   * @param {Function} scoreFn  – scoreChoiceMatch(wanted, value, text) → number
   * @returns {Promise<{filled: boolean, prior: string|null}>}
   */
  async function siteSpecificDropdownFill(trigger, wanted, scoreFn) {
    const handler = detectSiteHandler();
    if (!handler) return { filled: false, prior: null, warning: null };

    const prior = cleanText(trigger).slice(0, 120);
    const triggerLabel = trigger.getAttribute("aria-label") || trigger.name || "";
    ddLog(`site="${handler.id}" trigger found, wanted="${wanted}"`);

    await handler.open(trigger);

    // Collect options with progressive backoff retries.
    // Real Workday popups render asynchronously and can take 1-3 seconds.
    const retryDelays = handler.id === "workday"
      ? [0, 500, 800, 1200, 1500]
      : [0, 400];

    let opts = [];
    for (const delay of retryDelays) {
      if (delay > 0) await sleep(delay);
      opts = handler.collectOptions(trigger);
      if (opts.length) break;
    }

    // For non-Workday sites, apply the general safety filter.
    // Workday's collectOptions already handles disabled/hidden/placeholder
    // internally, so re-filtering would risk dropping options that passed
    // the relaxed visibility fallback.
    if (handler.id !== "workday") {
      const seenTexts = new Set();
      opts = opts.filter((o) => !isOptionUnsafe(o.node, seenTexts));
    }

    ddLog(`site="${handler.id}" options=${opts.length}`);
    if (!opts.length) {
      ddWarn(`site="${handler.id}" no safe options found`);
      return {
        filled: false, prior,
        warning: {
          reason: "site-no-options", site: handler.id, wanted,
          label: triggerLabel, fieldType: `site-${handler.id}`,
          topCandidates: []
        }
      };
    }

    const scored = opts.map((o) => {
      const val = (o.node.getAttribute("data-value") || o.node.getAttribute("value") || "").trim();
      const s = Math.max(scoreFn(wanted, val, o.text), scoreFn(wanted, "", o.text));
      return { node: o.node, text: o.text, score: s };
    }).sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best || best.score < SAFE_THRESHOLD) {
      logSiteAttempt(handler.id, triggerLabel, trigger, wanted, scored, "skipped", `below threshold (${SAFE_THRESHOLD})`);
      try { document.body.click(); } catch { /* ignore */ }
      try {
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
      } catch { /* ignore */ }
      await sleep(100);
      return {
        filled: false, prior,
        warning: {
          reason: "site-low-confidence", site: handler.id, wanted,
          label: triggerLabel, fieldType: `site-${handler.id}`,
          bestText: best?.text, bestScore: best?.score,
          topCandidates: scored.slice(0, 5)
        }
      };
    }

    await handler.pick(best.node);

    // Workday verify + retry: check whether the selection stuck
    let verified = true;
    if (handler.id === "workday" && handler.verifyPick) {
      verified = handler.verifyPick(trigger, best.text);
      if (!verified) {
        ddLog("workday: pick did not stick, retrying");
        await handler.open(trigger);
        const retryOpts = handler.collectOptions(trigger);
        const retryMatch = retryOpts.find((o) =>
          cleanText(o.node).toLowerCase().includes(best.text.toLowerCase()) ||
          best.text.toLowerCase().includes(cleanText(o.node).toLowerCase())
        );
        if (retryMatch) {
          await handler.pick(retryMatch.node);
          await sleep(300);
          verified = handler.verifyPick(trigger, best.text);
        }
        logSiteAttempt(handler.id, triggerLabel, trigger, wanted, scored,
          verified ? "picked (retry)" : "pick-failed", verified ? null : "value did not stick after retry");
      } else {
        logSiteAttempt(handler.id, triggerLabel, trigger, wanted, scored, "picked (verified)", null);
      }
    } else {
      logSiteAttempt(handler.id, triggerLabel, trigger, wanted, scored, "picked", null);
    }

    return { filled: verified, prior, warning: verified ? null : {
      reason: "site-pick-not-verified", site: handler.id, wanted,
      label: triggerLabel, fieldType: `site-${handler.id}`,
      bestText: best?.text, bestScore: best?.score,
      topCandidates: scored.slice(0, 5)
    }};
  }

  function logSiteAttempt(siteId, label, triggerEl, wanted, scored, outcome, reason) {
    if (!isDebug()) return;
    const icon = outcome.startsWith("picked") ? "\u2705" : "\u274C";
    console.groupCollapsed(`${icon} [SiteHandler:${siteId}] wanted "${wanted}"`);
    console.log("Field label :", label || "(none)");
    console.log("Desired value:", wanted);
    console.log("Site handler :", siteId);
    console.log("Trigger      :", triggerEl);
    console.log("Options found:", scored.length);
    if (scored.length) {
      console.log("Top candidates:");
      console.table(scored.slice(0, 5).map((s, i) => ({
        "#": i + 1,
        text: s.text?.slice(0, 80),
        score: s.score?.toFixed(3)
      })));
    }
    console.log("Outcome      :", outcome);
    if (reason) console.log("Reason       :", reason);
    console.groupEnd();
  }

  /**
   * Match a Workday field label to a profile key using the question map.
   * Returns the profile key string or null if no pattern matches.
   */
  function workdayMatchLabel(labelText) {
    if (!labelText) return null;
    for (const entry of WORKDAY_QUESTION_MAP) {
      if (entry.pattern.test(labelText)) return entry.key;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  //  Public API
  // -------------------------------------------------------------------------
  window.JobAutofillSiteHandlers = {
    SITE_HANDLERS,
    detectSiteHandler,
    siteSpecificDropdownFill,
    WORKDAY_QUESTION_MAP,
    workdayMatchLabel,
    isWorkday: () => workday.match(),
    workdayHandler: workday
  };
})();
