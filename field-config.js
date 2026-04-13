(() => {
  // Shared custom-dropdown trigger selectors used across all platforms.
  const CUSTOM_DROPDOWN_TRIGGERS = [
    '[role="combobox"]:not(input[type="text"])',
    '[aria-haspopup="listbox"]',
    '[aria-haspopup="true"]'
  ];

  /**
   * Merge site-handler trigger selectors (if loaded) with the base set so that
   * form-detector.js will discover site-specific elements during field scanning.
   */
  function mergeSiteTriggers(base, siteId) {
    const handlers = window.JobAutofillSiteHandlers?.SITE_HANDLERS;
    if (!handlers) return base;
    const handler = handlers.find((h) => h.id === siteId);
    if (!handler?.triggers) return base;
    const merged = new Set([...base, ...handler.triggers]);
    return [...merged];
  }

  const PLATFORM_CONFIGS = {
    linkedin: {
      hostPatterns: [/linkedin\.com/i],
      selectors: {
        text: ['input[name*="first"]', 'input[name*="last"]', 'input[name*="email"]'],
        textarea: ["textarea"],
        select: ["select"],
        checkbox: ['input[type="checkbox"]'],
        radio: ['input[type="radio"]', '[role="radio"]:not(input)'],
        dropdownTrigger: mergeSiteTriggers([
          ...CUSTOM_DROPDOWN_TRIGGERS,
          'select[data-test-text-selectable-option]',
          '.jobs-easy-apply-form-element select'
        ], "linkedin")
      }
    },
    indeed: {
      hostPatterns: [/indeed\./i],
      selectors: {
        text: ["input"],
        textarea: ["textarea"],
        select: ["select"],
        checkbox: ['input[type="checkbox"]'],
        radio: ['input[type="radio"]', '[role="radio"]:not(input)'],
        dropdownTrigger: mergeSiteTriggers([
          ...CUSTOM_DROPDOWN_TRIGGERS,
          'button[data-testid*="dropdown"]',
          'button[data-testid*="select"]'
        ], "indeed")
      }
    },
    greenhouse: {
      hostPatterns: [/greenhouse\.io/i],
      selectors: {
        text: ["input"],
        textarea: ["textarea"],
        select: ["select"],
        checkbox: ['input[type="checkbox"]'],
        radio: ['input[type="radio"]', '[role="radio"]:not(input)'],
        dropdownTrigger: mergeSiteTriggers([
          ...CUSTOM_DROPDOWN_TRIGGERS,
          'select.select__input',
          '[data-testid*="select"]',
          '.select-shell'
        ], "greenhouse")
      }
    },
    lever: {
      hostPatterns: [/lever\.co/i],
      selectors: {
        text: ["input"],
        textarea: ["textarea"],
        select: ["select"],
        checkbox: ['input[type="checkbox"]'],
        radio: ['input[type="radio"]', '[role="radio"]:not(input)'],
        dropdownTrigger: mergeSiteTriggers([
          ...CUSTOM_DROPDOWN_TRIGGERS,
          '.postings-select',
          '[data-qa*="select"]'
        ], "lever")
      }
    },
    workday: {
      hostPatterns: [/workday\./i, /myworkdayjobs\.com/i],
      selectors: {
        text: ["input[data-automation-id]", "input"],
        textarea: ["textarea[data-automation-id]", "textarea"],
        select: ["select[data-automation-id]", "select"],
        checkbox: ['input[type="checkbox"]'],
        radio: ['input[type="radio"]', '[role="radio"]:not(input)'],
        dropdownTrigger: mergeSiteTriggers([
          '[data-automation-id="selectWidget"]',
          'div[id*="dropDownSelectList"]',
          'button[data-automation-id="selectWidget"]',
          'button[data-automation-id*="dropDown"]',
          'button[data-automation-id*="DropDown"]',
          'div[data-automation-id*="dropDown"][tabindex]',
          'div[data-automation-id*="DropDown"][tabindex]',
          ...CUSTOM_DROPDOWN_TRIGGERS
        ], "workday")
      }
    },
    ashby: {
      hostPatterns: [/ashbyhq\.com/i],
      selectors: {
        text: ["input"],
        textarea: ["textarea"],
        select: ["select"],
        checkbox: ['input[type="checkbox"]'],
        radio: ['input[type="radio"]', '[role="radio"]:not(input)'],
        dropdownTrigger: mergeSiteTriggers([
          ...CUSTOM_DROPDOWN_TRIGGERS,
          'button[class*="Select"]',
          'button[class*="select"]',
          '[data-testid*="select"]'
        ], "ashby")
      }
    }
  };

  const GENERIC_SELECTORS = {
    text: [
      'input[type="text"]',
      'input[type="email"]',
      'input[type="tel"]',
      'input[type="date"]',
      'input[type="month"]',
      'input:not([type])'
    ],
    textarea: ["textarea", '[contenteditable="true"]'],
    select: ["select"],
    checkbox: ['input[type="checkbox"]'],
    radio: ['input[type="radio"]', '[role="radio"]:not(input)'],
    dropdownTrigger: CUSTOM_DROPDOWN_TRIGGERS
  };

  window.JobAutofillConfig = {
    PLATFORM_CONFIGS,
    GENERIC_SELECTORS,
    CUSTOM_DROPDOWN_TRIGGERS
  };
})();
