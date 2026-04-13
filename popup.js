(() => {
  const statusText = document.getElementById("statusText");
  const activeResumeSelect = document.getElementById("activeResumeSelect");
  const historyList = document.getElementById("historyList");
  const reportsList = document.getElementById("reportsList");

  function createEl(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (typeof attrs === "string") { el.className = attrs; }
    else if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "text") el.textContent = v;
        else if (k === "style") Object.assign(el.style, v);
        else el.setAttribute(k, v);
      }
    }
    for (const child of children) {
      if (typeof child === "string") el.appendChild(document.createTextNode(child));
      else if (child) el.appendChild(child);
    }
    return el;
  }

  function clearAndAppend(container, nodes) {
    container.replaceChildren(...nodes);
  }

  function setStatus(text, isError = false) {
    statusText.textContent = text;
    statusText.style.color = isError ? "#b42318" : "#344054";
  }

  function sendMessage(message) {
    return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
  }

  async function loadResumeOptions() {
    const result = await new Promise((resolve) => chrome.storage.local.get(["resumes", "settings"], resolve));
    const resumes = result.resumes || [];
    const settings = result.settings || {};
    const defaultOpt = createEl("option", { value: "", text: "Use profile defaults" });
    const resumeOpts = resumes.map((resume) => {
      const opt = createEl("option", { value: resume.id });
      opt.textContent = `${resume.name}${resume.roleTag ? ` (${resume.roleTag})` : ""}`;
      if (settings.activeResumeId === resume.id) opt.selected = true;
      return opt;
    });
    clearAndAppend(activeResumeSelect, [defaultOpt, ...resumeOpts]);
  }

  async function saveActiveResumeId() {
    const response = await sendMessage({ type: "getSettings" });
    const next = { ...(response?.settings || {}), activeResumeId: activeResumeSelect.value };
    await sendMessage({ type: "saveSettings", payload: next });
    setStatus("Active resume updated.");
  }

  async function loadHistory() {
    const result = await new Promise((resolve) => chrome.storage.local.get(["fillHistory"], resolve));
    const history = (result.fillHistory || []).slice(0, 10);
    if (!history.length) {
      historyList.textContent = "No fill history yet.";
      return;
    }
    const historyNodes = history.map((entry) => {
      const date = new Date(entry.timestamp).toLocaleString();
      return createEl("div", null, `${entry.hostname} - ${date} - ${entry.filledCount} fields`);
    });
    clearAndAppend(historyList, historyNodes);
  }

  async function loadReports() {
    const result = await new Promise((resolve) => chrome.storage.local.get(["layoutReports"], resolve));
    const reports = (result.layoutReports || []).slice(-5).reverse();
    if (!reports.length) {
      reportsList.textContent = "No site reports yet.";
      return;
    }
    const reportNodes = reports.map((entry) => {
      const date = new Date(entry.createdAt).toLocaleString();
      const host = entry.host || "unknown";
      const count = Array.isArray(entry.fields) ? entry.fields.length : 0;
      return createEl("div", null, `${host} - ${date} - ${count} fields`);
    });
    clearAndAppend(reportsList, reportNodes);
  }

  async function clearReports() {
    await new Promise((resolve) => chrome.storage.local.remove(["layoutReports"], resolve));
    await loadReports();
    setStatus("Site reports cleared.");
  }

  async function actionFill(dryRun) {
    const r = await sendMessage({ type: "triggerFillOnActiveTab", payload: { dryRun } });
    if (r?.ok === false) {
      setStatus("Can't fill this tab — switch to a real webpage (job application page).", true);
      return;
    }
    setStatus(dryRun ? "Dry run sent. If nothing happens, this page may block extensions." : "Fill sent. If nothing happens, open a job site tab first.");
  }

  async function actionUndo() {
    const r = await sendMessage({ type: "triggerUndoOnActiveTab" });
    if (r?.ok === false) {
      setStatus("Can't undo on this tab — use a page where the extension can run.", true);
      return;
    }
    setStatus("Undo sent.");
  }

  async function reportLayout() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setStatus("No active tab.", true);
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: "reportFormLayout" }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        setStatus(
          "Can't scan this page — use a normal job site tab (not chrome://, settings, or PDF viewer).",
          true
        );
        return;
      }
      // Show EEO diagnostic inline in the popup
      const d = response.diagnostics || {};
      const eeoLines = [
        `Gender saved: ${d.eeo_gender_saved || "(empty)"}`,
        `Race saved: ${d.eeo_race_saved || "(empty)"}`,
        `Veteran saved: ${d.eeo_veteran_saved || "(empty)"}`,
        `Disability saved: ${d.eeo_disability_saved || "(empty)"}`,
        `Sponsorship: ${d.requires_sponsorship_saved || "(empty)"}`,
        `Relocate: ${d.willing_to_relocate_saved || "(empty)"}`,
        ``,
        `Candidate fields found: ${d.candidate_field_count ?? "?"}`,
        `Raw radio DOM elements: ${d.raw_radio_dom_elements ?? "?"}`,
        ``,
        `Fields that WOULD fill:`,
        ...(d.matched_keys || ["(none detected)"])
      ].join("\n");
      const domDump = (d.raw_radio_dom || []).map((r) =>
        `  <${r.tag}> role="${r.role}" name="${r.name}" id="${r.id}" ariaChecked="${r.ariaChecked}" dataState="${r.dataState}" text="${r.text}" parentRole="${r.parentRole}" classes="${r.classes}"`
      ).join("\n");
      const fullDiag = `── EEO Profile Data ──\n${eeoLines}\n\n── Raw Radio DOM ──\n${domDump || "(none found)"}`;
      console.log("[Job Auto Fill] Report Layout diagnostics:\n" + fullDiag);
      console.log("[Job Auto Fill] Full diagnostics object:", JSON.stringify(d, null, 2));
      alert(fullDiag);

      chrome.storage.local.get(["layoutReports"], (result) => {
        const reports = result.layoutReports || [];
        reports.push({ host: response.host, fields: response.fields, diagnostics: d, createdAt: new Date().toISOString() });
        chrome.storage.local.set({ layoutReports: reports }, () => setStatus("Scan complete — check the alert for EEO status."));
      });
    });
  }

  document.getElementById("fillNowBtn").addEventListener("click", () => actionFill(false));
  document.getElementById("dryRunBtn").addEventListener("click", () => actionFill(true));
  document.getElementById("undoBtn").addEventListener("click", actionUndo);
  document.getElementById("openSettingsBtn").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("popup-settings.html") }));
  document.getElementById("reportLayoutBtn").addEventListener("click", reportLayout);
  document.getElementById("clearReportsBtn").addEventListener("click", clearReports);
  activeResumeSelect.addEventListener("change", saveActiveResumeId);

  loadResumeOptions();
  loadHistory();
  loadReports();
})();
