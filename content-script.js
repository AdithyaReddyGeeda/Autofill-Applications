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

  function setNativeInputValue(el, value) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (descriptor?.set) descriptor.set.call(el, value);
    else el.value = value;
  }

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

  function normChoice(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[._-]+/g, " ")
      .trim();
  }

  function scoreChoiceMatch(wantedRaw, valueRaw, textRaw) {
    const w = normChoice(wantedRaw);
    if (!w) return 0;
    const val = normChoice(valueRaw);
    const text = normChoice(textRaw);
    if (val === w || text === w) return 1;
    if (text.includes(w) || w.includes(text)) return 0.93;
    if (val && (val.includes(w) || w.includes(val))) return 0.9;
    const wt = w.replace(/\s+/g, "");
    const tt = text.replace(/\s+/g, "");
    if (tt.includes(wt) || wt.includes(tt)) return 0.88;
    if (/^no\b|^n$/i.test(w.trim()) && /\b(no|not |don't|do not|without|decline)\b/i.test(text) && !/\byes\b/i.test(text)) return 0.86;
    if (/^yes\b|^y$/i.test(w.trim()) && /\byes\b/i.test(text) && !/\bno\b|not |don't|do not/i.test(text)) return 0.84;
    if (/\bprefer not\b|decline to state|i don't wish|wish not to/i.test(w) && /\b(decline|prefer not|not wish|don't wish)\b/i.test(text)) return 0.9;
    const sim = window.JobAutofillMatcher;
    return Math.max(sim.similarity(w, text), val ? sim.similarity(w, val) : 0);
  }

  function pickBestSelectOption(selectEl, wanted) {
    const w = String(wanted || "").trim();
    if (!w) return null;
    const options = [...selectEl.querySelectorAll("option")].filter((opt) => {
      const v = opt.value;
      const t = opt.textContent.trim();
      if (v === "" && (!t || /^(select|choose|please|--|−)/i.test(t))) return false;
      return true;
    });
    let best = null;
    let bestScore = 0;
    for (const opt of options) {
      const s = scoreChoiceMatch(w, opt.value, opt.textContent);
      if (s > bestScore) {
        bestScore = s;
        best = opt;
      }
    }
    return bestScore >= 0.35 ? best : null;
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

  function usesWorkdaySyntheticFill(el, matchKey) {
    return isWorkdayDropdownTrigger(el) || shouldUseWorkdayComboboxFill(el, matchKey);
  }

  function isWorkdayOptionExcluded(node) {
    return Boolean(node?.closest?.('[data-automation-id="selectedItem"]'));
  }

  function optionVisibleEnough(node) {
    const r = node.getBoundingClientRect?.();
    return r && r.width > 1 && r.height > 1;
  }

  function dispatchFullPointerClick(el) {
    if (!el) return;
    let cx = 0;
    let cy = 0;
    try {
      const r = el.getBoundingClientRect();
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
    } catch { /* ignore */ }
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

  function collectWorkdayListScores(wanted) {
    const scored = [];
    const seen = new Set();
    const pushNode = (node, textSource) => {
      if (!node || seen.has(node) || isWorkdayOptionExcluded(node)) return;
      if (!optionVisibleEnough(node)) return;
      seen.add(node);
      const text = normChoice(textSource || node.textContent || "");
      if (!text || text.length > 500) return;
      scored.push({ node, score: scoreChoiceMatch(wanted, "", text) });
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

  async function pickAndClickWorkdayListOption(wantedRaw) {
    const wanted = String(wantedRaw || "").trim();
    if (!wanted) return false;
    let scored = collectWorkdayListScores(wanted);
    if (!scored.length) {
      await sleep(500);
      scored = collectWorkdayListScores(wanted);
    }
    const best = scored[0];
    if (!best || best.score < 0.32) {
      try {
        document.body.click();
      } catch {
        /* ignore */
      }
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
    await sleep(220);
    return true;
  }

  async function setWorkdayStyleChoiceControl(trigger, wantedRaw) {
    const wanted = String(wantedRaw || "").trim();
    if (!wanted) return null;
    trigger.scrollIntoView({ block: "center", inline: "nearest" });
    await sleep(120);
    try {
      trigger.focus?.();
    } catch {
      /* ignore */
    }
    dispatchFullPointerClick(trigger);
    await sleep(520);
    await pickAndClickWorkdayListOption(wanted);
    return null;
  }

  async function setWorkdayComboboxFromInput(input, wantedRaw) {
    const wanted = String(wantedRaw || "").trim();
    if (!wanted) return null;
    input.scrollIntoView({ block: "center", inline: "nearest" });
    await sleep(80);
    try {
      input.focus();
    } catch {
      /* ignore */
    }
    dispatchFullPointerClick(input);
    await sleep(200);
    try {
      setNativeInputValue(input, "");
      setNativeInputValue(input, wanted);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: wanted, inputType: "insertText" }));
    } catch {
      /* ignore */
    }
    await sleep(350);
    const opened = await pickAndClickWorkdayListOption(wanted);
    if (!opened) {
      try {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
      } catch {
        /* ignore */
      }
      await sleep(400);
      await pickAndClickWorkdayListOption(wanted);
    }
    return null;
  }

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
    options = options.filter((n) => !(n.tagName?.toLowerCase() === "input" && (n.type || "").toLowerCase() === "radio"));
    const prior = rg
      ? ariaRadioGroupSelectedText(rg)
      : (() => {
          const cur = options.find(
            (n) =>
              n.getAttribute("aria-checked") === "true" || n.getAttribute("data-state") === "checked"
          );
          return cur ? (cur.textContent || "").replace(/\s+/g, " ").trim() : "";
        })();
    let best = null;
    let bestScore = 0;
    for (const n of options) {
      const label = (n.textContent || "").replace(/\s+/g, " ").trim();
      const aria = (n.getAttribute("aria-label") || "").trim();
      const s = Math.max(scoreChoiceMatch(w, "", label), scoreChoiceMatch(w, "", aria));
      if (s > bestScore) {
        bestScore = s;
        best = n;
      }
    }
    if (!best || bestScore < 0.35) return null;
    try {
      best.scrollIntoView({ block: "center", inline: "nearest" });
    } catch {
      /* ignore */
    }
    try {
      best.focus?.({ preventScroll: true });
    } catch {
      /* ignore */
    }
    dispatchFullPointerClick(best);
    try {
      best.dispatchEvent(new Event("input", { bubbles: true }));
      best.dispatchEvent(new Event("change", { bubbles: true }));
    } catch {
      /* ignore */
    }
    return { __ariaRadio: true, previous: prior, target: best };
  }

  async function applyFieldValue(el, value, matchKey) {
    if (isAriaCustomRadio(el)) {
      return setAriaRadioGroupValue(el, value);
    }
    const tag = el.tagName?.toLowerCase();
    const type = (el.type || "").toLowerCase();
    if (tag === "input" && type === "radio") {
      const rg = el.closest('[role="radiogroup"]');
      if (rg && rg.querySelector('[role="radio"]:not(input)')) {
        const first = rg.querySelector('[role="radio"]:not(input)');
        return setAriaRadioGroupValue(first, value);
      }
    }
    if (isWorkdayDropdownTrigger(el)) {
      return setWorkdayStyleChoiceControl(el, value);
    }
    if (shouldUseWorkdayComboboxFill(el, matchKey)) {
      return setWorkdayComboboxFromInput(el, value);
    }
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

  function findClickableForRadio(input) {
    if (!input) return null;
    const label = input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null;
    if (label) return label;
    const wrap = input.closest("label");
    if (wrap) return wrap;
    const parent = input.parentElement;
    if (parent) {
      const btn = parent.querySelector('[role="radio"], button, [data-state]');
      if (btn) return btn;
      const sib = parent.querySelector('span, div');
      if (sib && sib !== input) return sib;
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
    const group = [...scope.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`)];
    const w = String(value || "").trim();
    let best = null;
    let bestScore = 0;
    for (const r of group) {
      const label = labelTextForInput(r);
      const s = scoreChoiceMatch(w, r.value, label || r.getAttribute("aria-label") || "");
      if (s > bestScore) {
        bestScore = s;
        best = r;
      }
    }
    if (best && bestScore >= 0.35) {
      const clickTarget = findClickableForRadio(best);
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
          best.focus?.({ preventScroll: true });
        } catch { /* ignore */ }
        dispatchFullPointerClick(best);
      }

      if (!best.checked) {
        const checkedDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
        if (checkedDesc?.set) {
          group.forEach((r) => checkedDesc.set.call(r, r === best));
        } else {
          group.forEach((r) => { r.checked = r === best; });
        }
        best.dispatchEvent(new Event("input", { bubbles: true }));
        best.dispatchEvent(new Event("change", { bubbles: true }));
        best.dispatchEvent(new Event("click", { bubbles: true }));
      }
      return best;
    }
    return null;
  }

  function setNativeSelectValue(el, value) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
    if (descriptor?.set) descriptor.set.call(el, value);
    else el.value = value;
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
      el.checked = /true|yes|1/i.test(String(value));
    } else if (tag === "input" && type === "radio") {
      const checkedEl = setRadioGroupValue(el, value);
      const target = checkedEl || el;
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      target.dispatchEvent(new Event("blur", { bubbles: true }));
      return oldValue;
    } else if (el.isContentEditable) {
      el.textContent = value;
    } else if (tag === "input") {
      if (el.type === "date") setNativeInputValue(el, formatDateValue(value, "date"));
      else if (el.type === "month") setNativeInputValue(el, formatDateValue(value, "month"));
      else setNativeInputValue(el, value);
    } else if (tag === "select") {
      const opt = pickBestSelectOption(el, value);
      if (opt) {
        opt.selected = true;
        setNativeSelectValue(el, opt.value);
      } else {
        setNativeSelectValue(el, value);
      }
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
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

  async function fillForm({ dryRun = false, matchThreshold } = {}) {
    STATE.profile = await getStorage("profile", {});
    STATE.resumes = await getStorage("resumes", []);
    STATE.settings = await getStorage("settings", {});
    STATE.education = await getStorage("education", []);
    STATE.experience = await getStorage("experience", []);
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

    STATE.lastFilled = [];
    let filledCount = 0;
    const matchedKeys = [];
    for (let index = 0; index < matches.length; index += 1) {
      const m = matches[index];
      const mergedText = `${m.meta.name} ${m.meta.id} ${m.meta.placeholder} ${m.meta.label} ${m.meta.nearText}`;
      if (SENSITIVE_PATTERNS.test(mergedText)) continue;
      try {
        const value = preview.overrides?.[String(index)] ?? resolveMatchValue(m);
        console.log(`[AutoFill] #${index} key="${m.key}" value="${String(value).slice(0,60)}" tag=<${m.element?.tagName}> type="${m.element?.type||""}" role="${m.element?.getAttribute("role")||""}" name="${m.element?.name||""}" id="${m.element?.id||""}" isAriaRadio=${isAriaCustomRadio(m.element)} checked=${m.element?.checked} outerHTML=${m.element?.outerHTML?.slice(0,200)}`);
        const raw = await applyFieldValue(m.element, value, m.key);
        console.log(`[AutoFill] #${index} result:`, raw, `element.checked now=${m.element?.checked}`);
        if (isAriaCustomRadio(m.element) && raw == null) {
          console.log(`[AutoFill] #${index} aria radio returned null — skipping`);
          continue;
        }
        let previous;
        let filledElement = m.element;
        if (raw && typeof raw === "object" && raw.__ariaRadio) {
          previous = raw.previous;
          filledElement = raw.target || m.element;
          console.log(`[AutoFill] #${index} ariaRadio target:`, filledElement?.tagName, filledElement?.textContent?.slice(0,60));
        } else {
          previous = raw;
        }
        const workday = usesWorkdaySyntheticFill(m.element, m.key);
        STATE.lastFilled.push({
          element: filledElement,
          previous,
          workday,
          ariaRadio: Boolean(raw && raw.__ariaRadio)
        });
        highlightField(filledElement);
        filledCount += 1;
        matchedKeys.push(m.key);
      } catch (_err) {
        console.error(`[AutoFill] #${index} error:`, _err);
      }
    }
    sessionStorage.setItem("jobAutofillFilledCount", String(filledCount));
    appendFillHistory(window.location.hostname, filledCount, matchedKeys);
    updateFloatingButtonsAfterFill(filledCount);
    notify(`Filled ${filledCount} fields successfully.`, "success");
  }

  function undoFill() {
    STATE.lastFilled.forEach((item) => {
      const el = item.element;
      if (!el) return;
      if (item.workday) return;
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
        try {
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } catch {
          /* ignore */
        }
        return;
      }
      if (el.tagName.toLowerCase() === "input" && el.type === "checkbox") {
        el.checked = Boolean(item.previous);
      } else if (el.tagName.toLowerCase() === "input" && el.type === "radio") {
        const scope = el.form || document;
        const name = el.name;
        const prev = String(item.previous ?? "");
        [...scope.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`)].forEach((r) => {
          r.checked = r.value === prev;
        });
      } else if (el.isContentEditable) {
        el.textContent = item.previous || "";
      } else {
        el.value = item.previous || "";
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
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
})();
