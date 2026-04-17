(() => {
  const TOKEN_MAP = {
    full_name: ["full name", "legal name", "complete name"],
    first_name: ["first name", "given name", "first"],
    last_name: ["last name", "surname", "family name", "last"],
    email: ["email", "e-mail", "email address"],
    phone: ["phone", "mobile", "telephone", "contact number"],
    phone_local: [
      "phone number",
      "primary phone",
      "contact phone",
      "telephone number",
      "mobile number"
    ],
    phone_country_code: ["country phone code", "phone code", "dialing code", "calling code", "international code"],
    phone_device_type: ["phone device type", "device type", "phone type", "preferred phone"],
    phone_extension: ["phone extension", "extension", "ext."],
    linkedin: ["linkedin", "linked in", "linkedin profile", "linkedin url", "linkedin.com"],
    github: ["github"],
    portfolio: ["portfolio", "website", "personal site"],
    location: ["location", "based in", "where are you based", "residing in", "current location", "where do you live", "city and state"],
    address_line1: ["address line 1", "address line one", "street address", "street line", "mailing address"],
    address_line2: ["address line 2", "address line two", "suite", "apt", "apartment", "unit"],
    city: ["city", "town", "municipality"],
    state: ["state", "province", "region", "county"],
    postal_code: ["postal code", "postal", "zip code", "zip", "postcode"],
    country: ["country", "nation", "country of residence"],
    salary_expectations: ["salary", "compensation", "expected salary", "salary expectation", "desired pay", "usd per month"],
    salary_pay_period: ["hourly", "monthly", "annually", "per year", "pay type", "compensation type", "salary type"],
    start_date_availability: ["start date", "availability", "available to start", "notice period", "joining date"],
    date_of_birth: ["date of birth", "dob", "birth date", "birthday"],
    pronouns: ["pronouns", "gender pronouns", "preferred pronouns"],
    skills: ["skills", "technologies", "tech stack"],
    work_authorization: [
      "work authorization",
      "legally authorized",
      "legally authorized to work",
      "authorized to work",
      "eligible to work",
      "right to work",
      "permit to work",
      "citizenship",
      "permanent resident",
      "work permit"
    ],
    requires_sponsorship: [
      "require sponsorship",
      "sponsorship for employment",
      "visa sponsorship",
      "h-1b",
      "h1b",
      "tn visa",
      "employment sponsorship",
      "immigration sponsorship",
      "now or in the future require",
      "need sponsorship",
      "sponsorship now",
      "will you need",
      "require a visa"
    ],
    willing_to_relocate: [
      "willing to relocate",
      "reside in",
      "work onsite",
      "open to relocation",
      "relocate to",
      "able to relocate",
      "relocation",
      "must relocate",
      "relocate for"
    ],
    eeo_gender: [
      "gender",
      "legal sex",
      "male or female",
      "woman or man",
      "gender identity",
      "your gender",
      "sex (optional)",
      "sex if"
    ],
    eeo_disability: [
      "disability",
      "disability status",
      "ada",
      "reasonable accommodation",
      "have a disability",
      "workplace accommodation",
      "physical or mental"
    ],
    eeo_veteran: [
      "veteran",
      "veteran status",
      "armed forces",
      "protected veteran",
      "military service",
      "military status",
      "uniformed service"
    ],
    eeo_race: [
      "race",
      "ethnicity",
      "racial",
      "hispanic or latino",
      "hispanic",
      "latino",
      "ethnic background",
      "race or ethnicity",
      "minority",
      "color or race"
    ],
    english_proficiency: [
      "conversational english",
      "english level",
      "cefr",
      "a1",
      "a2",
      "b1",
      "b2",
      "c1",
      "c2",
      "beginner",
      "elementary",
      "intermediate",
      "upper intermediate",
      "advanced",
      "native speaker"
    ],
    referral_contact: [
      "who contacted you",
      "contacted you first",
      "referred by",
      "who from",
      "how did you hear"
    ],
    years_role_experience: [
      "years of experience do you have as",
      "years as a data analyst",
      "experience as a data analyst",
      "as a data analyst",
      "data analyst"
    ],
    sql_experience_text: [
      "experience with sql",
      "sql experience",
      "how much time",
      "sql if so"
    ],
    data_viz_years: [
      "data visualization",
      "visualization tools",
      "years of experience do you have with data",
      "bi tools",
      "tableau",
      "power bi"
    ],
    cover_letter: ["cover letter", "why join", "why us", "motivation"],
    resume_text: ["resume", "cv", "experience summary", "about"],
    years_of_experience: [
      "years of experience",
      "years experience",
      "how many years",
      "total experience",
      "professional experience",
      "yoe"
    ],
    education_level: [
      "education level",
      "highest education",
      "highest degree",
      "degree level",
      "level of education",
      "educational attainment",
      "academic background"
    ]
  };

  function splitFullName(fullName) {
    const value = (fullName || "").trim();
    if (!value) return { first: "", last: "" };
    const firstSpace = value.indexOf(" ");
    if (firstSpace === -1) return { first: value, last: "" };
    return {
      first: value.slice(0, firstSpace).trim(),
      last: value.slice(firstSpace + 1).trim()
    };
  }

  function composedFullName(profile) {
    const fn = String(profile?.first_name || "").trim();
    const ln = String(profile?.last_name || "").trim();
    const joined = [fn, ln].filter(Boolean).join(" ");
    return joined || String(profile?.full_name || "").trim();
  }

  function interpolateCoverLetter(template, profile) {
    const raw = String(template || "");
    const name = composedFullName(profile);
    const email = profile?.email || "";
    const role = profile?.target_role || "";
    return raw
      .replace(/\{\{name\}\}/gi, name)
      .replace(/\{\{email\}\}/gi, email)
      .replace(/\{\{role\}\}/gi, role);
  }

  function normalize(input) {
    return (input || "")
      .toString()
      .toLowerCase()
      .replace(/[_-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    if (!m) return n;
    if (!n) return m;
    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i += 1) dp[i][0] = i;
    for (let j = 0; j <= n; j += 1) dp[0][j] = j;
    for (let i = 1; i <= m; i += 1) {
      for (let j = 1; j <= n; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      }
    }
    return dp[m][n];
  }

  function similarity(a, b) {
    const x = normalize(a);
    const y = normalize(b);
    if (!x && !y) return 1;
    if (!x || !y) return 0;
    const distance = levenshtein(x, y);
    return 1 - distance / Math.max(x.length, y.length, 1);
  }

  function metaIsChoiceLike(meta) {
    const tag = (meta.tagName || "").toLowerCase();
    const type = (meta.type || "").toLowerCase();
    if (tag === "select") return true;
    if (tag === "input" && type === "radio") return true;
    const role = (meta.role || "").toLowerCase();
    if (role === "radio" || role === "combobox" || role === "listbox") return true;
    const aid = String(meta.automationId || "");
    if (/selectWidget|dropdown/i.test(aid)) return true;
    return false;
  }

  function metadataToText(meta, isChoice = false) {
    const nearRaw = meta.nearText || "";
    // Choice controls already get a short label; keep enough nearText for section headings (EEO, etc.).
    const nearText = isChoice ? nearRaw.slice(0, 160) : nearRaw;
    return normalize(
      [
        meta.name,
        meta.id,
        meta.placeholder,
        meta.role,
        meta.dataTestId,
        meta.automationId,
        meta.label,
        meta.ariaLabel,
        meta.ariaLabelledBy,
        nearText
      ].join(" ")
    );
  }

  /** Yes/No profile selects: empty → skip field; any other stored value → Yes or No (for Greenhouse-style radios). */
  function yesNoBinary(raw) {
    if (raw === undefined || raw === null || raw === "") return "";
    const s = String(raw).trim();
    if (!s) return "";
    return /^(yes|true|1)$/i.test(s) ? "Yes" : "No";
  }

  function tokenScore(metaText, token) {
    if (!metaText || !token) return 0;
    if (metaText.includes(token)) {
      const words = token.trim().split(/\s+/).length;
      return Math.min(1, 0.9 + Math.min(words, 5) * 0.02);
    }
    return similarity(metaText, token);
  }

  function eeoFromProfile(profile) {
    const raw = profile?.eeo_responses;
    if (raw && typeof raw === "object") return raw;
    return {};
  }

  function resolveValue(key, profile, metaText) {
    const eeo = eeoFromProfile(profile);
    if (key === "eeo_gender") return eeo.gender || profile.gender || "";
    if (key === "eeo_disability") return eeo.disability || eeo.disability_status || "";
    if (key === "eeo_veteran") return eeo.veteran || eeo.veteran_status || "";
    if (key === "eeo_race") return eeo.race_ethnicity || eeo.race || eeo.ethnicity || "";
    if (key === "country") return String(profile.country || profile.location || "").trim();
    if (key === "address_line1") return String(profile.address_line1 || "").trim();
    if (key === "address_line2") return String(profile.address_line2 || "").trim();
    if (key === "city") return String(profile.city || "").trim();
    if (key === "state") return String(profile.state || "").trim();
    if (key === "postal_code") return String(profile.postal_code || "").trim();
    if (key === "phone_device_type") return String(profile.phone_device_type || "").trim();
    if (key === "phone_country_code") {
      const explicit = String(profile.phone_country_code || "").trim();
      if (explicit) return explicit;
      const p = String(profile.phone || "").trim();
      const m = p.match(/^\+\d{1,4}/);
      return m ? m[0] : "";
    }
    if (key === "phone_local") {
      const local = String(profile.phone_local || "").trim();
      if (local) return local.replace(/\D/g, "") || local;
      const digits = String(profile.phone || "").replace(/\D/g, "");
      if (digits.length >= 10) return digits.slice(-10);
      return "";
    }
    if (key === "phone_extension") return String(profile.phone_extension || "").trim();
    if (key === "salary_pay_period") return String(profile.salary_pay_period || "").trim();
    if (key === "english_proficiency") return String(profile.english_proficiency || "").trim();
    if (key === "referral_contact") return String(profile.referral_contact || "").trim();
    if (key === "years_role_experience") return String(profile.years_role_experience || "").trim();
    if (key === "sql_experience_text") return String(profile.sql_experience_text || "").trim();
    if (key === "data_viz_years") return String(profile.data_viz_years || "").trim();
    if (key === "requires_sponsorship") return yesNoBinary(profile.requires_sponsorship);
    if (key === "willing_to_relocate") return yesNoBinary(profile.willing_to_relocate);
    if (key === "years_of_experience") {
      const exp = profile.experience;
      if (Array.isArray(exp) && exp.length) {
        const computed = computeYearsOfExperience(exp);
        if (computed) return computed;
      }
      return String(profile.years_of_experience || "").trim();
    }
    if (key === "education_level") {
      const edu = Array.isArray(profile.education) ? profile.education : [];
      const last = edu[edu.length - 1];
      if (!last) return "";
      return [last.degree, last.fieldOfStudy].filter(Boolean).join(" ").trim();
    }
    if (key === "first_name") return String(profile.first_name || "").trim() || splitFullName(profile.full_name).first;
    if (key === "last_name") return String(profile.last_name || "").trim() || splitFullName(profile.full_name).last;
    if (key === "full_name") return composedFullName(profile);
    if (key === "cover_letter" || key === "resume_text") return interpolateCoverLetter(profile[key], profile);
    return profile[key];
  }

  function scoreField(meta, profile, threshold = 0.38) {
    const isChoice = metaIsChoiceLike(meta);
    const metaText = metadataToText(meta, isChoice);

    // Hard disambiguation: when the label unambiguously says "first name",
    // "last name", or "full name", skip the fuzzy tournament entirely.
    if (/\bfirst name\b|\bgiven name\b/.test(metaText)) {
      const value = resolveValue("first_name", profile, metaText);
      if (value) return { key: "first_name", value: String(value), confidence: 1 };
    }
    if (/\blast name\b|\bsurname\b|\bfamily name\b/.test(metaText)) {
      const value = resolveValue("last_name", profile, metaText);
      if (value) return { key: "last_name", value: String(value), confidence: 1 };
    }
    if (/\bfull name\b|\blegal name\b|\bcomplete name\b/.test(metaText)) {
      const value = resolveValue("full_name", profile, metaText);
      if (value) return { key: "full_name", value: String(value), confidence: 1 };
    }

    // Sponsorship vs work authorization: overlapping vocabulary on real forms.
    if (
      /\b(require|need|will you).{0,50}sponsor/i.test(metaText) ||
      /\bvisa sponsorship|sponsorship for employment|immigration sponsorship|employment sponsorship/i.test(metaText) ||
      /\bh[- ]?1b|h1b\b/i.test(metaText)
    ) {
      const value = resolveValue("requires_sponsorship", profile, metaText);
      if (value) return { key: "requires_sponsorship", value: String(value), confidence: 0.98 };
    }
    if (
      /\b(legally )?authorized to work|eligible to work|right to work|work authorization status|permit to work/i.test(metaText) &&
      !/\bsponsor/i.test(metaText)
    ) {
      const value = resolveValue("work_authorization", profile, metaText);
      if (value) return { key: "work_authorization", value: String(value), confidence: 0.98 };
    }

    const candidates = [];

    Object.keys(TOKEN_MAP).forEach((key) => {
      const value = resolveValue(key, profile, metaText);
      if (value === undefined || value === null || value === "") return;
      let score = Math.max(...TOKEN_MAP[key].map((token) => tokenScore(metaText, token)));

      // Penalise full_name when the field clearly belongs to first/last
      if (key === "full_name" && /\bfirst name\b|\bgiven name\b|\blast name\b|\bsurname\b|\bfamily name\b/.test(metaText)) {
        score -= 0.35;
      }
      // Penalise sponsorship when the question is clearly work-authorization-only
      if (
        key === "requires_sponsorship" &&
        /\b(authorized to work|eligible to work|right to work)\b/i.test(metaText) &&
        !/\bsponsor/i.test(metaText)
      ) {
        score -= 0.45;
      }

      const keyThreshold =
        key.startsWith("eeo_") || key === "requires_sponsorship" || key === "willing_to_relocate"
          ? Math.min(Number(threshold), 0.3)
          : Number(threshold);
      if (score > keyThreshold) {
        candidates.push({
          key,
          value: Array.isArray(value) ? value.join(", ") : String(value),
          confidence: score
        });
      }
    });

    candidates.sort((a, b) => b.confidence - a.confidence);
    return candidates[0] || null;
  }

  function parseExperienceStartDate(exp) {
    const s = String(exp?.startDate || "").trim();
    if (!s) return null;
    if (/^\d{4}-\d{2}$/.test(s)) return new Date(`${s}-01T12:00:00`);
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function computeYearsOfExperience(experiences) {
    if (!Array.isArray(experiences) || experiences.length === 0) return "";
    const dates = experiences.map(parseExperienceStartDate).filter(Boolean);
    if (!dates.length) return "";
    const earliest = new Date(Math.min(...dates.map((d) => d.getTime())));
    const years = (Date.now() - earliest.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
    return Math.max(0, Math.floor(years)).toString();
  }

  /** Last row in the list (user expectation: most recently added entry). */
  function getLastEducationEntry(education) {
    if (!Array.isArray(education) || education.length === 0) return null;
    return education[education.length - 1];
  }

  function getMostRecentExperience(experience) {
    if (!Array.isArray(experience) || !experience.length) return null;
    return [...experience].sort((a, b) => String(b.startDate || "").localeCompare(String(a.startDate || "")))[0];
  }

  function maybeSemanticValue(meta, profile) {
    const text = metadataToText(meta, metaIsChoiceLike(meta));
    const experience = profile.experience || [];
    const education = profile.education || [];
    const lastEdu = getLastEducationEntry(education);
    const recentExp = getMostRecentExperience(experience);

    if (
      /(data visualization|visualization tools|bi tools|tableau|power bi)/.test(text) &&
      /(years|how many)/.test(text)
    ) {
      const v = String(profile.data_viz_years || "").trim();
      if (v) return { key: "data_viz_years", value: v, confidence: 0.86 };
    }

    if (/sql/.test(text) && /(experience|how much|time|if so)/.test(text)) {
      const v = String(profile.sql_experience_text || "").trim();
      if (v) return { key: "sql_experience_text", value: v, confidence: 0.85 };
    }

    if (
      (/data analyst/.test(text) && /(years|how many)/.test(text)) ||
      /years of experience do you have as a data analyst/.test(text)
    ) {
      const v = String(profile.years_role_experience || "").trim();
      if (v) return { key: "years_role_experience", value: v, confidence: 0.87 };
    }

    if (text.includes("years of experience")) {
      return { key: "years_of_experience", value: computeYearsOfExperience(experience), confidence: 0.85 };
    }

    if (/(graduation year|year of graduation)/.test(text)) {
      if (!lastEdu) return null;
      const y = String(lastEdu.endYear || "").trim();
      const value = y || "Present";
      return { key: "graduation_year", value, confidence: 0.82 };
    }

    if (/(university|college|institution|school name)/.test(text)) {
      if (!lastEdu?.institution) return null;
      return { key: "education_institution", value: lastEdu.institution, confidence: 0.82 };
    }

    if (/(degree|qualification)/.test(text)) {
      if (!lastEdu) return null;
      const value = [lastEdu.degree, lastEdu.fieldOfStudy].filter(Boolean).join(" ").trim();
      if (!value) return null;
      return { key: "education_degree", value, confidence: 0.82 };
    }

    if (/(current company|current employer|most recent employer)/.test(text)) {
      if (!recentExp?.company) return null;
      return { key: "current_company", value: recentExp.company, confidence: 0.82 };
    }

    if (/(current title|current role|job title)/.test(text)) {
      if (!recentExp?.title) return null;
      return { key: "current_title", value: recentExp.title, confidence: 0.82 };
    }

    if (/(education|degree|university|college)/.test(text)) {
      const recent = getLastEducationEntry(education);
      if (!recent) return null;
      const parts = [recent.degree, recent.institution].filter(Boolean);
      const value = parts.join(" — ");
      if (!value) return null;
      return { key: "education_summary", value, confidence: 0.8 };
    }

    return null;
  }

  window.JobAutofillMatcher = {
    normalize,
    scoreField,
    maybeSemanticValue,
    similarity,
    splitFullName,
    interpolateCoverLetter,
    computeYearsOfExperience
  };
})();
