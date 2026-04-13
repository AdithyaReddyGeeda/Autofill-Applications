(() => {
  const PLATFORM_CONFIGS = {
    linkedin: {
      hostPatterns: [/linkedin\.com/i],
      selectors: {
        text: ['input[name*="first"]', 'input[name*="last"]', 'input[name*="email"]'],
        textarea: ["textarea"],
        select: ["select"],
        checkbox: ['input[type="checkbox"]'],
        radio: ['input[type="radio"]', '[role="radio"]:not(input)']
      }
    },
    indeed: {
      hostPatterns: [/indeed\./i],
      selectors: {
        text: ["input"],
        textarea: ["textarea"],
        select: ["select"],
        checkbox: ['input[type="checkbox"]'],
        radio: ['input[type="radio"]', '[role="radio"]:not(input)']
      }
    },
    greenhouse: {
      hostPatterns: [/greenhouse\.io/i],
      selectors: {
        text: ["input"],
        textarea: ["textarea"],
        select: ["select"],
        checkbox: ['input[type="checkbox"]'],
        radio: ['input[type="radio"]', '[role="radio"]:not(input)']
      }
    },
    lever: {
      hostPatterns: [/lever\.co/i],
      selectors: {
        text: ["input"],
        textarea: ["textarea"],
        select: ["select"],
        checkbox: ['input[type="checkbox"]'],
        radio: ['input[type="radio"]', '[role="radio"]:not(input)']
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
        dropdownTrigger: [
          '[data-automation-id="selectWidget"]',
          'div[id*="dropDownSelectList"]',
          'button[data-automation-id="selectWidget"]',
          'button[data-automation-id*="dropDown"]',
          'button[data-automation-id*="DropDown"]',
          'div[data-automation-id*="dropDown"][tabindex]',
          'div[data-automation-id*="DropDown"][tabindex]'
        ]
      }
    },
    ashby: {
      hostPatterns: [/ashbyhq\.com/i],
      selectors: {
        text: ["input"],
        textarea: ["textarea"],
        select: ["select"],
        checkbox: ['input[type="checkbox"]'],
        radio: ['input[type="radio"]', '[role="radio"]:not(input)']
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
    radio: ['input[type="radio"]', '[role="radio"]:not(input)']
  };

  window.JobAutofillConfig = {
    PLATFORM_CONFIGS,
    GENERIC_SELECTORS
  };
})();
