(() => {
  const statusText = document.getElementById("statusText");
  const pinGate = document.getElementById("pinGate");
  const appContent = document.getElementById("appContent");
  const pinInput = document.getElementById("pinInput");
  const activeResumeSelect = document.getElementById("activeResumeSelect");
  const historyList = document.getElementById("historyList");
  const reportsList = document.getElementById("reportsList");

  function setStatus(text, isError = false) {
    statusText.textContent = text;
    statusText.style.color = isError ? "#b42318" : "#344054";
  }

  function sendMessage(message) {
    return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
  }

  async function checkPinGate() {
    const response = await sendMessage({ type: "getSettings" });
    const settings = response?.settings || {};
    if (settings.pinEnabled && settings.pinCode) {
      pinGate.classList.remove("hidden");
      appContent.classList.add("hidden");
    } else {
      pinGate.classList.add("hidden");
      appContent.classList.remove("hidden");
    }
  }

  async function loadResumeOptions() {
    const result = await new Promise((resolve) => chrome.storage.local.get(["resumes", "settings"], resolve));
    const resumes = result.resumes || [];
    const settings = result.settings || {};
    activeResumeSelect.innerHTML = '<option value="">Use profile defaults</option>';
    resumes.forEach((resume) => {
      const option = document.createElement("option");
      option.value = resume.id;
      option.textContent = `${resume.name}${resume.roleTag ? ` (${resume.roleTag})` : ""}`;
      if (settings.activeResumeId === resume.id) option.selected = true;
      activeResumeSelect.appendChild(option);
    });
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
    historyList.innerHTML = history
      .map((entry) => {
        const date = new Date(entry.timestamp).toLocaleString();
        return `<div>${entry.hostname} - ${date} - ${entry.filledCount} fields</div>`;
      })
      .join("");
  }

  async function loadReports() {
    const result = await new Promise((resolve) => chrome.storage.local.get(["layoutReports"], resolve));
    const reports = (result.layoutReports || []).slice(-5).reverse();
    if (!reports.length) {
      reportsList.textContent = "No site reports yet.";
      return;
    }
    reportsList.innerHTML = reports
      .map((entry) => {
        const date = new Date(entry.createdAt).toLocaleString();
        const host = entry.host || "unknown";
        const count = Array.isArray(entry.fields) ? entry.fields.length : 0;
        return `<div>${host} - ${date} - ${count} fields</div>`;
      })
      .join("");
  }

  async function clearReports() {
    await new Promise((resolve) => chrome.storage.local.remove(["layoutReports"], resolve));
    await loadReports();
    setStatus("Site reports cleared.");
  }

  async function unlock() {
    const response = await sendMessage({ type: "getSettings" });
    const settings = response?.settings || {};
    if (pinInput.value === settings.pinCode) {
      pinGate.classList.add("hidden");
      appContent.classList.remove("hidden");
      setStatus("Unlocked.");
    } else {
      setStatus("Invalid PIN.", true);
    }
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

  document.getElementById("unlockBtn").addEventListener("click", unlock);
  document.getElementById("fillNowBtn").addEventListener("click", () => actionFill(false));
  document.getElementById("dryRunBtn").addEventListener("click", () => actionFill(true));
  document.getElementById("undoBtn").addEventListener("click", actionUndo);
  document.getElementById("openSettingsBtn").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("popup-settings.html") }));
  document.getElementById("reportLayoutBtn").addEventListener("click", reportLayout);
  document.getElementById("clearReportsBtn").addEventListener("click", clearReports);
  activeResumeSelect.addEventListener("change", saveActiveResumeId);

  checkPinGate();
  loadResumeOptions();
  loadHistory();
  loadReports();
})();
