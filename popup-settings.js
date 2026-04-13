(() => {
  const SENSITIVE_FIELD_PATTERN = /(ssn|social security|passport|routing|bank|credit card)/i;
  const statusEl = document.getElementById("settingsStatus");
  let editingResumeId = "";
  let editingEducationId = "";
  let editingExperienceId = "";

  const PDFJS_WORKER = chrome.runtime.getURL("lib/pdf.worker.min.js");

  function setStatus(text, isError = false) {
    statusEl.textContent = text;
    statusEl.style.color = isError ? "#b42318" : "#344054";
  }

  function getLocal(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }

  function setLocal(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
  }

  function splitFullNameForLoad(fullName) {
    const v = String(fullName || "").trim();
    if (!v) return { first: "", last: "" };
    const i = v.indexOf(" ");
    if (i === -1) return { first: v, last: "" };
    return { first: v.slice(0, i).trim(), last: v.slice(i + 1).trim() };
  }

  function readControlValue(form, name) {
    const el = form.querySelector(`[name="${name}"]`);
    if (!el || !("value" in el)) return undefined;
    return el.value;
  }

  function extractProfile(form) {
    const fd = new FormData(form);
    const profile = Object.fromEntries(fd.entries());
    const selectNames = [
      "eeo_gender",
      "eeo_race_ethnicity",
      "eeo_veteran",
      "eeo_disability",
      "requires_sponsorship",
      "willing_to_relocate",
      "salary_pay_period",
      "phone_device_type"
    ];
    for (const name of selectNames) {
      const v = readControlValue(form, name);
      if (v !== undefined) profile[name] = v;
    }
    const fn = String(profile.first_name || "").trim();
    const ln = String(profile.last_name || "").trim();
    profile.full_name = [fn, ln].filter(Boolean).join(" ");
    profile.eeo_responses = {
      gender: String(profile.eeo_gender ?? "").trim(),
      disability: String(profile.eeo_disability ?? "").trim(),
      veteran: String(profile.eeo_veteran ?? "").trim(),
      race_ethnicity: String(profile.eeo_race_ethnicity ?? "").trim()
    };
    delete profile.eeo_gender;
    delete profile.eeo_disability;
    delete profile.eeo_veteran;
    delete profile.eeo_race_ethnicity;
    profile.skills = (profile.skills || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    return profile;
  }

  function validateNoSensitiveData(profile) {
    const joined = Object.entries(profile)
      .map(([k, v]) => `${k}:${Array.isArray(v) ? v.join(",") : String(v)}`)
      .join(" ");
    if (SENSITIVE_FIELD_PATTERN.test(joined)) {
      setStatus("Sensitive financial/identity data detected. Not saved.", true);
      return false;
    }
    return true;
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function updateProfileCompletion(profile) {
    const fields = [
      "first_name",
      "last_name",
      "email",
      "phone",
      "linkedin",
      "github",
      "portfolio",
      "location",
      "skills",
      "work_authorization",
      "cover_letter",
      "resume_text",
      "salary_expectations",
      "start_date_availability"
    ];
    const filled = fields.filter((key) => {
      const value = profile[key];
      if (Array.isArray(value)) return value.length > 0;
      return Boolean(String(value || "").trim());
    }).length;
    const percent = Math.round((filled / fields.length) * 100);
    const indicator = document.getElementById("profileCompletion");
    indicator.textContent = `Profile ${percent}% complete`;
    if (percent < 50) indicator.style.color = "#b42318";
    else if (percent <= 80) indicator.style.color = "#b54708";
    else indicator.style.color = "#027a48";
  }

  function renderEducationList(education) {
    const container = document.getElementById("educationList");
    if (!education.length) {
      container.textContent = "No education entries yet.";
      return;
    }
    container.innerHTML = education
      .map(
        (e) =>
          `<div class="card" style="margin-bottom:8px;padding:8px;">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
              <span><strong>${escapeHtml(e.degree || "")}</strong> — ${escapeHtml(e.institution || "")}</span>
              <span style="display:flex;gap:6px;flex-shrink:0;">
                <button type="button" class="secondary" data-action="edit-education" data-id="${e.id}">Edit</button>
                <button type="button" class="danger" data-action="delete-education" data-id="${e.id}">Delete</button>
              </span>
            </div>
          </div>`
      )
      .join("");
  }

  function renderExperienceList(experience) {
    const container = document.getElementById("experienceList");
    if (!experience.length) {
      container.textContent = "No experience entries yet.";
      return;
    }
    container.innerHTML = experience
      .map((x) => {
        const end = x.current || !x.endDate ? "Present" : x.endDate;
        const range = `${x.startDate || "?"} — ${end}`;
        return `<div class="card" style="margin-bottom:8px;padding:8px;">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
              <span><strong>${escapeHtml(x.title || "")}</strong> — ${escapeHtml(x.company || "")}<br/><span class="status">${escapeHtml(range)}</span></span>
              <span style="display:flex;gap:6px;flex-shrink:0;">
                <button type="button" class="secondary" data-action="edit-experience" data-id="${x.id}">Edit</button>
                <button type="button" class="danger" data-action="delete-experience" data-id="${x.id}">Delete</button>
              </span>
            </div>
          </div>`;
      })
      .join("");
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function clearEducationInputs() {
    editingEducationId = "";
    document.getElementById("addEducationBtn").textContent = "Add Education";
    document.getElementById("eduInstitution").value = "";
    document.getElementById("eduDegree").value = "";
    document.getElementById("eduFieldOfStudy").value = "";
    document.getElementById("eduStartYear").value = "";
    document.getElementById("eduEndYear").value = "";
    document.getElementById("eduPresent").checked = false;
    document.getElementById("eduGpa").value = "";
    syncEducationPresentUi();
  }

  function clearExperienceInputs() {
    editingExperienceId = "";
    document.getElementById("addExperienceBtn").textContent = "Add Experience";
    document.getElementById("expCompany").value = "";
    document.getElementById("expTitle").value = "";
    document.getElementById("expStartDate").value = "";
    document.getElementById("expEndDate").value = "";
    document.getElementById("expCurrent").checked = false;
    document.getElementById("expDescription").value = "";
    syncExperienceCurrentUi();
  }

  function syncEducationPresentUi() {
    const present = document.getElementById("eduPresent").checked;
    document.getElementById("eduEndYear").disabled = present;
    if (present) document.getElementById("eduEndYear").value = "";
  }

  function syncExperienceCurrentUi() {
    const current = document.getElementById("expCurrent").checked;
    document.getElementById("expEndDate").disabled = current;
    if (current) document.getElementById("expEndDate").value = "";
  }

  async function loadSettings() {
    const { profile = {}, settings = {}, resumes = [], education = [], experience = [] } = await getLocal([
      "profile",
      "settings",
      "resumes",
      "education",
      "experience"
    ]);
    const form = document.getElementById("profileForm");
    Object.keys(profile).forEach((key) => {
      if (key === "eeo_responses" || key === "full_name") return;
      const input = form.querySelector(`[name="${key}"]`);
      if (!input) return;
      if (Array.isArray(profile[key])) input.value = profile[key].join(", ");
      else input.value = profile[key];
    });
    const firstEl = form.querySelector('[name="first_name"]');
    const lastEl = form.querySelector('[name="last_name"]');
    if (firstEl && lastEl) {
      const hasSplit = String(profile.first_name || "").trim() || String(profile.last_name || "").trim();
      if (hasSplit) {
        firstEl.value = profile.first_name || "";
        lastEl.value = profile.last_name || "";
      } else if (profile.full_name) {
        const sp = splitFullNameForLoad(profile.full_name);
        firstEl.value = sp.first;
        lastEl.value = sp.last;
      }
    }
    const eeo = profile.eeo_responses || {};
    const eeoGender = form.querySelector('[name="eeo_gender"]');
    const eeoDisability = form.querySelector('[name="eeo_disability"]');
    const eeoVeteran = form.querySelector('[name="eeo_veteran"]');
    const eeoRaceEthnicity = form.querySelector('[name="eeo_race_ethnicity"]');
    if (eeoGender) eeoGender.value = eeo.gender || "";
    if (eeoDisability) eeoDisability.value = eeo.disability || "";
    if (eeoVeteran) eeoVeteran.value = eeo.veteran || "";
    if (eeoRaceEthnicity) eeoRaceEthnicity.value = eeo.race_ethnicity || "";
    const ynToSelect = (v) => {
      const s = String(v ?? "").trim().toLowerCase();
      if (v === true || s === "yes" || s === "y") return "yes";
      if (v === false || s === "no" || s === "n") return "no";
      return "";
    };
    const reqSpon = form.querySelector('[name="requires_sponsorship"]');
    const willingRel = form.querySelector('[name="willing_to_relocate"]');
    if (reqSpon) reqSpon.value = ynToSelect(profile.requires_sponsorship);
    if (willingRel) willingRel.value = ynToSelect(profile.willing_to_relocate);
    const payPeriod = form.querySelector('[name="salary_pay_period"]');
    if (payPeriod) payPeriod.value = String(profile.salary_pay_period || "");
    const phoneDev = form.querySelector('[name="phone_device_type"]');
    if (phoneDev) phoneDev.value = String(profile.phone_device_type || "");
    document.getElementById("dryRunMode").checked = Boolean(settings.dryRunMode);
    document.getElementById("devMode").checked = Boolean(settings.devMode);
    document.getElementById("matchThreshold").value = Number(settings.matchThreshold ?? 0.38).toFixed(2);
    document.getElementById("pinEnabled").checked = Boolean(settings.pinEnabled);
    document.getElementById("pinCode").value = settings.pinCode || "";
    renderResumeList(resumes);
    renderEducationList(education);
    renderExperienceList(experience);
    updateProfileCompletion(profile);
    setStatus(`Loaded ${resumes.length} resume(s), ${education.length} education, ${experience.length} experience.`);
  }

  async function saveBehaviorSettings() {
    const { settings = {} } = await getLocal(["settings"]);
    const next = {
      ...settings,
      dryRunMode: document.getElementById("dryRunMode").checked,
      devMode: document.getElementById("devMode").checked,
      matchThreshold: Number(document.getElementById("matchThreshold").value) || 0.38
    };
    await setLocal({ settings: next });
    setStatus("Behavior settings saved.");
  }

  function clearResumeEditor() {
    editingResumeId = "";
    document.getElementById("resumeName").value = "";
    document.getElementById("resumeRoleTag").value = "";
    document.getElementById("resumeText").value = "";
    document.getElementById("resumeCoverLetter").value = "";
    document.getElementById("addResumeBtn").textContent = "Add Resume";
  }

  function renderResumeList(resumes) {
    const container = document.getElementById("resumeList");
    if (!resumes.length) {
      container.textContent = "No saved resumes yet.";
      return;
    }
    container.innerHTML = resumes
      .map(
        (resume) =>
          `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;">
            <span>${escapeHtml(resume.name)} ${resume.roleTag ? `(${escapeHtml(resume.roleTag)})` : ""}</span>
            <span>
              <button type="button" data-action="edit-resume" data-id="${resume.id}" class="secondary">Edit</button>
              <button type="button" data-action="delete-resume" data-id="${resume.id}" class="danger">Delete</button>
            </span>
          </div>`
      )
      .join("");
  }

  function loadPdfJs() {
    const lib = globalThis.pdfjsLib;
    if (!lib) {
      return Promise.reject(
        new Error("PDF.js bundle missing. Ensure lib/pdf.min.js exists and reload the extension.")
      );
    }
    lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    return Promise.resolve(lib);
  }

  document.getElementById("eduPresent").addEventListener("change", syncEducationPresentUi);
  document.getElementById("expCurrent").addEventListener("change", syncExperienceCurrentUi);

  document.getElementById("addEducationBtn").addEventListener("click", async () => {
    const institution = document.getElementById("eduInstitution").value.trim();
    const degree = document.getElementById("eduDegree").value.trim();
    const fieldOfStudy = document.getElementById("eduFieldOfStudy").value.trim();
    const startYear = document.getElementById("eduStartYear").value.trim();
    const present = document.getElementById("eduPresent").checked;
    const endYear = present ? "" : document.getElementById("eduEndYear").value.trim();
    const gpa = document.getElementById("eduGpa").value.trim();
    if (!institution || !degree) {
      setStatus("Institution and degree are required for education.", true);
      return;
    }
    const { education = [] } = await getLocal(["education"]);
    const payload = { institution, degree, fieldOfStudy, startYear, endYear, gpa };
    if (editingEducationId) {
      const target = education.find((e) => e.id === editingEducationId);
      if (target) Object.assign(target, payload);
      await setLocal({ education });
      renderEducationList(education);
      clearEducationInputs();
      setStatus("Education entry updated.");
    } else {
      education.push({ id: crypto.randomUUID(), ...payload });
      await setLocal({ education });
      renderEducationList(education);
      clearEducationInputs();
      setStatus("Education entry added.");
    }
  });

  document.getElementById("addExperienceBtn").addEventListener("click", async () => {
    const company = document.getElementById("expCompany").value.trim();
    const title = document.getElementById("expTitle").value.trim();
    const startDate = document.getElementById("expStartDate").value.trim();
    const current = document.getElementById("expCurrent").checked;
    const endDate = current ? "" : document.getElementById("expEndDate").value.trim();
    const description = document.getElementById("expDescription").value.trim();
    if (!company || !title || !startDate) {
      setStatus("Company, title, and start date are required for experience.", true);
      return;
    }
    const { experience = [] } = await getLocal(["experience"]);
    const payload = { company, title, startDate, endDate, description, current };
    if (editingExperienceId) {
      const target = experience.find((x) => x.id === editingExperienceId);
      if (target) Object.assign(target, payload);
      await setLocal({ experience });
      renderExperienceList(experience);
      clearExperienceInputs();
      setStatus("Experience entry updated.");
    } else {
      experience.push({ id: crypto.randomUUID(), ...payload });
      await setLocal({ experience });
      renderExperienceList(experience);
      clearExperienceInputs();
      setStatus("Experience entry added.");
    }
  });

  document.getElementById("educationList").addEventListener("click", async (event) => {
    const delBtn = event.target.closest("button[data-action='delete-education']");
    const editBtn = event.target.closest("button[data-action='edit-education']");
    if (editBtn) {
      const id = editBtn.dataset.id;
      const { education = [] } = await getLocal(["education"]);
      const entry = education.find((e) => e.id === id);
      if (!entry) return;
      editingEducationId = id;
      document.getElementById("eduInstitution").value = entry.institution || "";
      document.getElementById("eduDegree").value = entry.degree || "";
      document.getElementById("eduFieldOfStudy").value = entry.fieldOfStudy || "";
      document.getElementById("eduStartYear").value = entry.startYear || "";
      const hasEnd = String(entry.endYear || "").trim();
      document.getElementById("eduPresent").checked = !hasEnd;
      document.getElementById("eduEndYear").value = hasEnd ? entry.endYear : "";
      document.getElementById("eduGpa").value = entry.gpa || "";
      syncEducationPresentUi();
      document.getElementById("addEducationBtn").textContent = "Update Education";
      setStatus("Editing education entry.");
      return;
    }
    if (!delBtn) return;
    const id = delBtn.dataset.id;
    const { education = [] } = await getLocal(["education"]);
    const next = education.filter((e) => e.id !== id);
    await setLocal({ education: next });
    if (editingEducationId === id) clearEducationInputs();
    renderEducationList(next);
    setStatus("Education entry removed.");
  });

  document.getElementById("experienceList").addEventListener("click", async (event) => {
    const delBtn = event.target.closest("button[data-action='delete-experience']");
    const editBtn = event.target.closest("button[data-action='edit-experience']");
    if (editBtn) {
      const id = editBtn.dataset.id;
      const { experience = [] } = await getLocal(["experience"]);
      const entry = experience.find((x) => x.id === id);
      if (!entry) return;
      editingExperienceId = id;
      document.getElementById("expCompany").value = entry.company || "";
      document.getElementById("expTitle").value = entry.title || "";
      document.getElementById("expStartDate").value = entry.startDate || "";
      document.getElementById("expCurrent").checked = Boolean(entry.current);
      document.getElementById("expEndDate").value = entry.endDate || "";
      document.getElementById("expDescription").value = entry.description || "";
      syncExperienceCurrentUi();
      document.getElementById("addExperienceBtn").textContent = "Update Experience";
      setStatus("Editing experience entry.");
      return;
    }
    if (!delBtn) return;
    const id = delBtn.dataset.id;
    const { experience = [] } = await getLocal(["experience"]);
    const next = experience.filter((x) => x.id !== id);
    await setLocal({ experience: next });
    if (editingExperienceId === id) clearExperienceInputs();
    renderExperienceList(next);
    setStatus("Experience entry removed.");
  });

  document.getElementById("resumePdfInput").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const pdfjsLib = await loadPdfJs();
      const data = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data }).promise;
      const parts = [];
      for (let i = 1; i <= pdf.numPages; i += 1) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const strings = content.items.map((item) => ("str" in item ? item.str : ""));
        parts.push(strings.join(" "));
      }
      const text = parts.join("\n").replace(/\s+/g, " ").trim();
      document.getElementById("resumeText").value = text;
      setStatus(`PDF extracted: ~${text.length} chars`);
    } catch (err) {
      setStatus(err?.message || "Could not read PDF.", true);
    } finally {
      event.target.value = "";
    }
  });

  document.getElementById("profileForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const profile = extractProfile(e.target);
    if (!validateNoSensitiveData(profile)) return;
    await setLocal({ profile });
    updateProfileCompletion(profile);
    setStatus("Profile saved.");
  });

  document.getElementById("saveProfileBtn").addEventListener("click", () => {
    document.getElementById("profileForm").requestSubmit();
  });

  document.getElementById("addResumeBtn").addEventListener("click", async () => {
    const name = document.getElementById("resumeName").value.trim();
    const roleTag = document.getElementById("resumeRoleTag").value.trim();
    const text = document.getElementById("resumeText").value.trim();
    const coverLetter = document.getElementById("resumeCoverLetter").value.trim();
    if (!name || !text) {
      setStatus("Resume name and text are required.", true);
      return;
    }
    const { resumes = [] } = await getLocal(["resumes"]);
    if (editingResumeId) {
      const target = resumes.find((item) => item.id === editingResumeId);
      if (target) {
        target.name = name;
        target.roleTag = roleTag;
        target.text = text;
        target.coverLetter = coverLetter;
      }
      setStatus("Resume updated.");
    } else {
      resumes.push({ id: crypto.randomUUID(), name, roleTag, text, coverLetter });
      setStatus("Resume added.");
    }
    await setLocal({ resumes });
    renderResumeList(resumes);
    clearResumeEditor();
  });

  document.getElementById("resumeList").addEventListener("click", async (event) => {
    const target = event.target.closest("button[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    const id = target.dataset.id;
    const { resumes = [] } = await getLocal(["resumes"]);
    if (action === "delete-resume") {
      const next = resumes.filter((item) => item.id !== id);
      await setLocal({ resumes: next });
      if (editingResumeId === id) clearResumeEditor();
      renderResumeList(next);
      setStatus("Resume deleted.");
      return;
    }
    if (action === "edit-resume") {
      const targetResume = resumes.find((item) => item.id === id);
      if (!targetResume) return;
      editingResumeId = id;
      document.getElementById("resumeName").value = targetResume.name || "";
      document.getElementById("resumeRoleTag").value = targetResume.roleTag || "";
      document.getElementById("resumeText").value = targetResume.text || "";
      document.getElementById("resumeCoverLetter").value = targetResume.coverLetter || "";
      document.getElementById("addResumeBtn").textContent = "Update Resume";
      setStatus("Editing resume.");
    }
  });

  document.getElementById("savePinBtn").addEventListener("click", async () => {
    const { settings = {} } = await getLocal(["settings"]);
    settings.pinEnabled = document.getElementById("pinEnabled").checked;
    settings.pinCode = document.getElementById("pinCode").value.trim();
    await setLocal({ settings });
    setStatus("PIN settings saved.");
  });

  document.getElementById("clearDataBtn").addEventListener("click", async () => {
    if (!window.confirm("This clears all local extension data. Continue?")) return;
    await chrome.storage.local.clear();
    setStatus("All data cleared.");
    await loadSettings();
  });

  document.getElementById("exportProfileBtn").addEventListener("click", async () => {
    const { profile = {}, resumes = [], education = [], experience = [] } = await getLocal([
      "profile",
      "resumes",
      "education",
      "experience"
    ]);
    downloadJson(`job-autofill-profile-${Date.now()}.json`, { profile, resumes, education, experience });
    setStatus("Profile exported.");
  });

  document.getElementById("importProfileBtn").addEventListener("click", () => {
    document.getElementById("importProfileInput").click();
  });

  document.getElementById("importProfileInput").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const profile = parsed.profile || {};
      const resumes = Array.isArray(parsed.resumes) ? parsed.resumes : [];
      const education = Array.isArray(parsed.education) ? parsed.education : [];
      const experience = Array.isArray(parsed.experience) ? parsed.experience : [];
      if (!validateNoSensitiveData(profile)) return;
      const resumesText = resumes.map((r) => `${r?.name || ""} ${r?.roleTag || ""} ${r?.text || ""} ${r?.coverLetter || ""}`).join(" ");
      if (SENSITIVE_FIELD_PATTERN.test(resumesText)) {
        setStatus("Sensitive data detected in imported resumes. Import blocked.", true);
        return;
      }
      await setLocal({ profile, resumes, education, experience });
      await loadSettings();
      setStatus("Profile imported.");
    } catch (_error) {
      setStatus("Invalid JSON file. Import failed.", true);
    } finally {
      event.target.value = "";
    }
  });

  document.getElementById("dryRunMode").addEventListener("change", saveBehaviorSettings);
  document.getElementById("devMode").addEventListener("change", saveBehaviorSettings);
  document.getElementById("matchThreshold").addEventListener("change", saveBehaviorSettings);

  syncEducationPresentUi();
  syncExperienceCurrentUi();
  loadSettings();
})();
