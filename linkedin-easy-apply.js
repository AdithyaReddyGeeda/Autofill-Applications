/**
 * LinkedIn Jobs — Easy Apply modal: step detection, footer buttons, validation, debug.
 * Loaded after site-handlers.js; used by content-script.js for scoped fill + multi-step flow.
 */
(() => {
  const AUTO_SUBMIT_LINKEDIN = false;

  const STEP_SETTLE_MS = 1400;
  const POST_WAVE_SETTLE_MS = 220;
  const AFTER_FIELD_MS = 120;
  const MAX_NAVIGATION_STEPS = 18;
  const FINGERPRINT_POLL_MS = 3800;
  const FINGERPRINT_POLL_INTERVAL_MS = 160;

  const host = () => window.location.hostname || "";

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function cleanText(node) {
    return (node && (node.textContent || node.innerText || "")).replace(/\s+/g, " ").trim() || "";
  }

  function isVerbose() {
    try {
      return Boolean(window.__linkedinEaDebug) || Boolean(window.__jobAutofillDevMode) || Boolean(window.__autofillDebug);
    } catch {
      return false;
    }
  }

  function debugLog(kind, payload) {
    if (!isVerbose()) return;
    const line = { kind, ...payload };
    console.log("[LinkedIn Easy Apply]", line);
  }

  function isLinkedInHost() {
    return /linkedin\.com/i.test(host());
  }

  function getEasyApplyApi() {
    return window.JobAutofillSiteHandlers?.linkedinEasyApply || null;
  }

  /** True when the Easy Apply modal is open on LinkedIn Jobs. */
  function isEasyApplyContext() {
    const api = getEasyApplyApi();
    return Boolean(api?.isActive?.() && isLinkedInHost());
  }

  function getModalRoot() {
    return getEasyApplyApi()?.getModalRoot?.() || null;
  }

  function rectArea(el) {
    try {
      const r = el.getBoundingClientRect();
      return Math.max(0, r.width) * Math.max(0, r.height);
    } catch {
      return 0;
    }
  }

  function rf() {
    return window.JobAutofillRequiredFields;
  }

  function isRoughlyVisible(el) {
    return rf()?.isRoughlyVisible?.(el) ?? false;
  }

  /**
   * Prefer the visible form-page / fieldset inside the modal so we do not match hidden steps.
   */
  function getActiveStepContainer(modalRoot) {
    if (!modalRoot) return null;
    const candidates = [
      ...modalRoot.querySelectorAll("[data-live-test-easy-apply-form-page]"),
      ...modalRoot.querySelectorAll(".jobs-easy-apply-form-page__page"),
      ...modalRoot.querySelectorAll('[class*="easy-apply-form-page"]'),
      ...modalRoot.querySelectorAll(".jobs-easy-apply-form-section__form-elements"),
      ...modalRoot.querySelectorAll("fieldset")
    ];
    const uniq = [...new Set(candidates)].filter(isRoughlyVisible);
    if (uniq.length === 1) return uniq[0];
    if (uniq.length > 1) {
      return [...uniq].sort((a, b) => rectArea(b) - rectArea(a))[0];
    }
    const content =
      modalRoot.querySelector(
        ".jobs-easy-apply-modal__content, .jobs-easy-apply-content, [class*='jobs-easy-apply-modal__body'], .jobs-easy-apply-content__form"
      ) || modalRoot;
    return isRoughlyVisible(content) ? content : modalRoot;
  }

  function getStepTitle(stepRoot) {
    if (!stepRoot) return "";
    const heading = stepRoot.querySelector(
      "h1, h2, h3, [data-test-modal-title], .jobs-easy-apply-modal__title, .artdeco-modal__header h2"
    );
    const t = cleanText(heading);
    return t.slice(0, 220);
  }

  function stepFingerprint(modalRoot, stepRoot) {
    const title = getStepTitle(stepRoot);
    let n = 0;
    try {
      n = stepRoot ? stepRoot.querySelectorAll('input:not([type="hidden"]), select, textarea, [role="combobox"]').length : 0;
    } catch {
      n = 0;
    }
    const footer = modalRoot?.querySelector?.(".jobs-easy-apply-footer, [class*='jobs-easy-apply-footer']");
    const footerHint = footer ? cleanText(footer).slice(0, 80) : "";
    return `${title}|${n}|${footerHint}`;
  }

  function isDismissLikeButton(btn) {
    if (!btn || btn.disabled) return true;
    const aria = `${btn.getAttribute("aria-label") || ""} ${btn.getAttribute("title") || ""}`.toLowerCase();
    if (/\b(close|dismiss|cancel)\b/.test(aria)) return true;
    if (btn.closest?.("[data-test-modal-close-btn], .artdeco-modal__dismiss, [aria-label*='Dismiss']")) return true;
    const t = cleanText(btn).toLowerCase();
    if (!t) return false;
    if (/^(close|dismiss|cancel)$/.test(t)) return true;
    if (t.includes("save as draft") && /discard|cancel/.test(t)) return true;
    return false;
  }

  function findReviewApplicationButton(modalRoot) {
    const root = modalRoot || document;
    const scope = root.querySelector(".jobs-easy-apply-footer, [class*='jobs-easy-apply-footer']") || root;
    const buttons = [...scope.querySelectorAll("button")];
    for (const btn of buttons) {
      if (!isRoughlyVisible(btn) || btn.disabled || isDismissLikeButton(btn)) continue;
      const t = cleanText(btn).toLowerCase();
      if (!t) continue;
      if (/^review\b|review your application|continue to review/i.test(t)) return btn;
    }
    return null;
  }

  /**
   * Primary "Next" — never dismiss-like; prefer LinkedIn's data attribute.
   */
  function findSafeNextButton(modalRoot) {
    const api = getEasyApplyApi();
    const hinted = modalRoot?.querySelector?.("button[data-easy-apply-next-button]");
    if (hinted && isRoughlyVisible(hinted) && !hinted.disabled && !isDismissLikeButton(hinted)) {
      return hinted;
    }
    const fromHandler = api?.findNextButton?.();
    if (fromHandler && !isDismissLikeButton(fromHandler)) return fromHandler;
    const root = modalRoot || document;
    const scope = root.querySelector(".jobs-easy-apply-footer, [class*='jobs-easy-apply-footer']") || root;
    for (const btn of scope.querySelectorAll("button")) {
      if (!isRoughlyVisible(btn) || btn.disabled || isDismissLikeButton(btn)) continue;
      const t = cleanText(btn).toLowerCase();
      if (t === "next" || /^next\b/.test(t)) {
        if (!/submit|review/.test(t)) return btn;
      }
    }
    return null;
  }

  /**
   * Required visible controls still empty — blocks clicking Next.
   * Delegates to JobAutofillRequiredFields (required-fields.js).
   */
  function getRequiredFieldStatus(stepRoot) {
    return rf()?.getStatus?.(stepRoot) ?? { ok: true, problems: [] };
  }

  async function waitForStepChange(getFingerprint, previousFp, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await sleep(FINGERPRINT_POLL_INTERVAL_MS);
      const fp = getFingerprint();
      if (fp && fp !== previousFp) return true;
    }
    return false;
  }

  window.JobAutofillLinkedInEA = {
    AUTO_SUBMIT_LINKEDIN,
    STEP_SETTLE_MS,
    POST_WAVE_SETTLE_MS,
    AFTER_FIELD_MS,
    MAX_NAVIGATION_STEPS,
    isVerbose,
    debugLog,
    cleanText,
    isLinkedInHost,
    isEasyApplyContext,
    getModalRoot,
    getActiveStepContainer,
    getStepTitle,
    stepFingerprint,
    findReviewApplicationButton,
    findSafeNextButton,
    isDismissLikeButton,
    getRequiredFieldStatus,
    isRoughlyVisible,
    waitForStepChange,
    sleep,
    FINGERPRINT_POLL_MS,
    FINGERPRINT_POLL_INTERVAL_MS
  };
})();
