(() => {
  function isAriaCustomRadio(el) {
    return Boolean(
      el &&
        el.nodeType === 1 &&
        (el.getAttribute("role") || "").toLowerCase() === "radio" &&
        !(el.tagName?.toLowerCase() === "input" && (el.type || "").toLowerCase() === "radio")
    );
  }

  function getLabelText(el) {
    if (!el) return "";
    if (isAriaCustomRadio(el)) {
      const a = (el.getAttribute("aria-label") || "").trim();
      if (a) return a;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t) return t.slice(0, 220);
    }
    if (el.id) {
      const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (forLabel) return forLabel.textContent.replace(/\s+/g, " ").trim();
    }
    const wrap = el.closest("label");
    if (wrap) {
      const clone = wrap.cloneNode(true);
      clone.querySelectorAll("input,select,textarea,button").forEach((n) => n.remove());
      return clone.textContent.replace(/\s+/g, " ").trim();
    }
    const tag = el.tagName?.toLowerCase();
    const type = (el.type || "").toLowerCase();
    if (tag === "input" && (type === "radio" || type === "checkbox")) {
      const parent = el.parentElement;
      if (parent) {
        const clone = parent.cloneNode(true);
        clone.querySelectorAll("input,select,textarea,button").forEach((n) => n.remove());
        return clone.textContent.replace(/\s+/g, " ").trim().slice(0, 220);
      }
    }
    return "";
  }

  function getAriaLabelledByText(el) {
    const lid = el.getAttribute("aria-labelledby");
    if (!lid) return "";
    return lid
      .split(/\s+/)
      .map((id) => {
        try {
          return document.getElementById(id)?.textContent?.trim() || "";
        } catch {
          return "";
        }
      })
      .filter(Boolean)
      .join(" ");
  }

  function getNearText(el) {
    const rg = el.closest('[role="radiogroup"]');
    if (rg) {
      const t = rg.textContent.replace(/\s+/g, " ").trim();
      if (t) return t.slice(0, 400);
    }
    const parent = el.closest("div, section, fieldset, li, td") || el.parentElement;
    return parent ? parent.textContent.slice(0, 160).trim() : "";
  }

  function extractMetadata(el) {
    return {
      tagName: el.tagName.toLowerCase(),
      type: (el.type || "").toLowerCase(),
      name: el.getAttribute("name") || "",
      id: el.id || "",
      placeholder: el.getAttribute("placeholder") || "",
      role: el.getAttribute("role") || "",
      dataTestId: el.getAttribute("data-testid") || "",
      automationId: el.getAttribute("data-automation-id") || "",
      label: getLabelText(el),
      ariaLabel: el.getAttribute("aria-label") || "",
      ariaLabelledBy: getAriaLabelledByText(el),
      nearText: getNearText(el)
    };
  }

  function isCandidateField(el) {
    if (!el || el.disabled) return false;
    const tag = el.tagName?.toLowerCase();
    const type = (el.type || "").toLowerCase();
    if (type === "hidden") return false;
    const aid = el.getAttribute("data-automation-id");
    if (aid === "selectWidget") return true;
    if (tag === "div" && el.id && el.id.includes("dropDownSelectList")) return true;
    if (tag === "select") return true;

    let style;
    try {
      style = window.getComputedStyle(el);
    } catch {
      return false;
    }

    // Ashby / Greenhouse / many React apps hide the native control (visibility:hidden, 0×0) and style a sibling.
    if (tag === "input" && (type === "radio" || type === "checkbox")) {
      if (style.display === "none") return false;
      return el.isConnected;
    }

    if (isAriaCustomRadio(el)) {
      if (el.getAttribute("aria-disabled") === "true" || el.getAttribute("data-disabled") !== null) return false;
      if (style.display === "none") return false;
      return el.isConnected;
    }

    if (style.visibility === "hidden" && tag !== "select") return false;
    if (style.display === "none") return false;

    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
    if (tag === "select" && el.options && el.options.length > 1) return true;
    return el.offsetParent !== null;
  }

  function currentPlatformSelectors() {
    const { PLATFORM_CONFIGS, GENERIC_SELECTORS } = window.JobAutofillConfig;
    const host = window.location.hostname;
    const selected = Object.values(PLATFORM_CONFIGS).find((p) => p.hostPatterns.some((r) => r.test(host)));
    return selected ? selected.selectors : GENERIC_SELECTORS;
  }

  function isWorkdayJobsHost() {
    const h = window.location.hostname;
    return /workday\./i.test(h) || /myworkdayjobs\.com/i.test(h);
  }

  function dedupeWorkdayDropdownTriggers(elements) {
    if (!isWorkdayJobsHost()) return elements;
    return elements.filter((el) => {
      if (el.tagName !== "DIV" || !(el.id || "").includes("dropDownSelectList")) return true;
      return !el.querySelector('[data-automation-id="selectWidget"]');
    });
  }

  function dedupeRadioGroups(elements) {
    const seenNames = new Set();
    const seenAriaGroups = new Set();
    const seenAriaParents = new Set();
    return elements.filter((el) => {
      if (isAriaCustomRadio(el)) {
        const rg = el.closest('[role="radiogroup"]');
        if (rg) {
          if (seenAriaGroups.has(rg)) return false;
          seenAriaGroups.add(rg);
          return true;
        }
        const p = el.parentElement;
        if (p) {
          if (seenAriaParents.has(p)) return false;
          seenAriaParents.add(p);
        }
        return true;
      }
      if (el.tagName?.toLowerCase() !== "input" || el.type !== "radio") return true;
      const n = el.getAttribute("name") || "";
      if (!n) return true;
      if (seenNames.has(n)) return false;
      seenNames.add(n);
      return true;
    });
  }

  /** Radix / Ashby: visible `role="radio"` buttons; native `<input type="radio">` in same group is ignored. */
  function dropNativeRadiosInAriaGroups(elements) {
    const rgWithCustom = new Set();
    const parentWithCustomRadio = new Set();
    elements.forEach((el) => {
      if (!isAriaCustomRadio(el)) return;
      const rg = el.closest('[role="radiogroup"]');
      if (rg) rgWithCustom.add(rg);
      else if (el.parentElement) parentWithCustomRadio.add(el.parentElement);
    });
    if (!rgWithCustom.size && !parentWithCustomRadio.size) return elements;
    return elements.filter((el) => {
      if (el.tagName?.toLowerCase() === "input" && (el.type || "").toLowerCase() === "radio") {
        const rg = el.closest('[role="radiogroup"]');
        if (rg && rgWithCustom.has(rg)) return false;
        const p = el.parentElement;
        if (p && parentWithCustomRadio.has(p)) return false;
      }
      return true;
    });
  }

  function queryCandidateFields(root = document) {
    const selectors = currentPlatformSelectors();
    const allSelectors = [
      ...selectors.text,
      ...selectors.textarea,
      ...selectors.select,
      ...selectors.checkbox,
      ...(selectors.radio || []),
      ...(selectors.dropdownTrigger || [])
    ];
    const selectorText = allSelectors.join(",");
    const found = new Set([...root.querySelectorAll(selectorText)]);

    function collectFromShadowRoots(node) {
      if (!node) return;
      if (node.shadowRoot) {
        node.shadowRoot.querySelectorAll(selectorText).forEach((el) => found.add(el));
        node.shadowRoot.querySelectorAll("*").forEach((inner) => collectFromShadowRoots(inner));
      }
      node.querySelectorAll?.("*").forEach((child) => {
        if (child.shadowRoot) collectFromShadowRoots(child);
      });
    }

    collectFromShadowRoots(root.documentElement || root);
    const merged = dedupeWorkdayDropdownTriggers(
      dedupeRadioGroups(dropNativeRadiosInAriaGroups([...found])).filter(isCandidateField)
    );
    return merged;
  }

  function isChoiceLikeControl(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName.toLowerCase();
    const type = (el.type || "").toLowerCase();
    if (tag === "select") return true;
    if (tag === "input" && type === "radio") return true;
    if (isAriaCustomRadio(el)) return true;
    const aid = el.getAttribute("data-automation-id") || "";
    if (aid === "selectWidget") return true;
    if (tag === "div" && el.id && el.id.includes("dropDownSelectList")) return true;
    if (tag === "input" && el.getAttribute("role") === "combobox") return true;
    if (tag === "input" && /\b(dropdown|multiselect|select|prompt|list)\b/i.test(aid)) return true;
    return false;
  }

  function detectAndMatch(profile, options = {}) {
    const threshold = Number(options.threshold ?? 0.38);
    const fields = queryCandidateFields();
    const matches = fields
      .map((el) => {
        const meta = extractMetadata(el);
        const semantic = window.JobAutofillMatcher.maybeSemanticValue(meta, profile);
        const direct = window.JobAutofillMatcher.scoreField(meta, profile, threshold);
        const useSemantic = !isChoiceLikeControl(el) && semantic && semantic.value;
        const chosen = useSemantic ? semantic : direct;
        if (!chosen || !chosen.value) return null;
        return { element: el, meta, ...chosen };
      })
      .filter(Boolean);

    // Deduplicate choice-like controls (select, radio, custom dropdowns) separately
    // from text fields so a higher-scoring text input never crowds out a select/radio
    // that should also be filled.
    const bestByKey = new Map();
    matches.forEach((match) => {
      const isChoice = isChoiceLikeControl(match.element);
      const dedupeKey = isChoice ? `${match.key}:choice` : `${match.key}:text`;
      const existing = bestByKey.get(dedupeKey);
      if (!existing || match.confidence > existing.confidence) bestByKey.set(dedupeKey, match);
    });
    return [...bestByKey.values()];
  }

  window.JobAutofillDetector = {
    detectAndMatch,
    queryCandidateFields
  };
})();
