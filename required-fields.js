/**
 * Shared required-field detection for LinkedIn Easy Apply, Workday, and other flows.
 * Exposes window.JobAutofillRequiredFields.
 */
(() => {
  function cleanText(node) {
    if (!node) return "";
    return (node.textContent || node.innerText || "").replace(/\s+/g, " ").trim();
  }

  function isRoughlyVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    let cur = el;
    for (let i = 0; i < 8 && cur; i++) {
      try {
        const st = window.getComputedStyle(cur);
        if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
      } catch {
        return false;
      }
      cur = cur.parentElement;
    }
    try {
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    } catch {
      return false;
    }
  }

  function isControlVisiblyEmpty(el) {
    if (!el) return true;
    const tag = el.tagName?.toLowerCase();
    const type = (el.type || "").toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase();

    if (type === "hidden") return false;

    if (type === "file") {
      return !el.files || el.files.length === 0;
    }

    if (tag === "input" && type === "radio") {
      const nm = el.getAttribute("name");
      if (nm) {
        const root = el.getRootNode?.();
        const scope = root && root.querySelector ? root : el.ownerDocument || document;
        try {
          const picked = scope.querySelector(`input[type="radio"][name="${CSS.escape(nm)}"]:checked`);
          return !picked;
        } catch {
          return !el.checked;
        }
      }
      return !el.checked;
    }

    if (tag === "input" && type === "checkbox") {
      return !el.checked;
    }

    if (tag === "select") {
      const opt = el.options[el.selectedIndex];
      const tx = (opt?.textContent || "").replace(/\s+/g, " ").trim();
      if (el.selectedIndex < 0) return true;
      if (!tx) return true;
      return /^(select|choose|please|--|−|—)/i.test(tx);
    }

    if (tag === "textarea" || (tag === "input" && !type)) {
      return !String(el.value || "").trim();
    }

    if (tag === "input") {
      return !String(el.value || "").trim();
    }

    if (role === "combobox" || role === "listbox") {
      const v = (el.getAttribute("aria-valuetext") || el.value || cleanText(el) || "").trim();
      if (!v) return true;
      return /^(select|choose|please pick)/i.test(v);
    }

    if (role === "radio") {
      return el.getAttribute("aria-checked") !== "true";
    }

    return false;
  }

  /**
   * Labels whose text ends with * or contains (required) — associate control if not already in [required] set.
   */
  function getLabelAsteriskControls(root) {
    const doc = root.ownerDocument || document;
    const out = [];
    const seen = new Set();
    root.querySelectorAll("label").forEach((lab) => {
      const raw = cleanText(lab);
      if (!raw) return;
      const looksRequired =
        /\*+\s*$/.test(raw) || /\(required\)/i.test(raw) || /^\s*\*\s+/.test(raw);
      if (!looksRequired) return;
      const id = lab.getAttribute("for");
      let el = null;
      if (id) {
        try {
          el = doc.getElementById(id);
        } catch {
          /* ignore */
        }
      }
      if (!el) {
        el = lab.querySelector(
          'input:not([type="hidden"]),select,textarea,[role="combobox"],[role="listbox"],[role="textbox"]'
        );
      }
      if (el && el.nodeType === 1 && !seen.has(el)) {
        seen.add(el);
        out.push(el);
      }
    });
    return out;
  }

  /**
   * @returns {{ ok: boolean, problems: Array<{ element: Element, reason: string, label: string, tag: string }> }}
   */
  function getStatus(stepRoot) {
    if (!stepRoot) return { ok: true, problems: [] };
    const problems = [];
    const seenRadioNames = new Set();
    const seenElements = new Set();

    const pushProblem = (el, reason) => {
      if (!el || el.nodeType !== 1) return;
      problems.push({
        element: el,
        reason,
        label: (el.getAttribute?.("aria-label") || cleanText(el.closest?.("label")) || "").slice(0, 160),
        tag: el.tagName || ""
      });
    };

    let candidates;
    try {
      candidates = stepRoot.querySelectorAll(
        [
          "[required]",
          "[aria-required='true']",
          "[data-required='true']",
          "[data-test-form-required]",
          "[data-automation-id][required]",
          "[data-automation-required='true']"
        ].join(",")
      );
    } catch {
      candidates = stepRoot.querySelectorAll("[required], [aria-required='true']");
    }

    for (const el of candidates) {
      if (seenElements.has(el)) continue;
      seenElements.add(el);
      if (!isRoughlyVisible(el)) continue;
      const tag = el.tagName?.toLowerCase();
      const type = (el.type || "").toLowerCase();

      if (tag === "input" && type === "radio") {
        const nm = el.getAttribute("name") || "";
        if (nm && seenRadioNames.has(nm)) continue;
      }

      if (!isControlVisiblyEmpty(el)) continue;

      if (type === "file") {
        pushProblem(el, "required-file-manual");
        if (tag === "input" && type === "radio") {
          const nm = el.getAttribute("name") || "";
          if (nm) seenRadioNames.add(nm);
        }
        continue;
      }
      pushProblem(el, "required-empty");
      if (tag === "input" && type === "radio") {
        const nm = el.getAttribute("name") || "";
        if (nm) seenRadioNames.add(nm);
      }
    }

    for (const el of getLabelAsteriskControls(stepRoot)) {
      if (seenElements.has(el)) continue;
      seenElements.add(el);
      if (!isRoughlyVisible(el)) continue;
      if (!isControlVisiblyEmpty(el)) continue;
      const type = (el.type || "").toLowerCase();
      if (type === "file") {
        pushProblem(el, "required-file-manual");
      } else {
        pushProblem(el, "required-empty-label");
      }
    }

    return { ok: problems.length === 0, problems };
  }

  window.JobAutofillRequiredFields = {
    cleanText,
    isRoughlyVisible,
    isControlVisiblyEmpty,
    getStatus
  };
})();
