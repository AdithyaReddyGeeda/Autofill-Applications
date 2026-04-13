const DEFAULT_SETTINGS = {
  dryRunMode: false,
  devMode: false,
  pinEnabled: false,
  pinCode: ""
};
/** Packaged asset — Brave/Chromium reject data: URLs for notification icons ("Unable to download all specified images"). */
const NOTIFICATION_ICON = chrome.runtime.getURL("icons/notification.png");

function ignoreSendError() {
  void chrome.runtime.lastError;
}

async function broadcastMessageToTabFrames(tabId, message) {
  await new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, () => {
      ignoreSendError();
      resolve();
    });
  });
  let frames;
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch {
    return;
  }
  await Promise.all(
    (frames || [])
      .filter((f) => f.frameId !== 0)
      .map(
        (f) =>
          new Promise((resolve) => {
            chrome.tabs.sendMessage(tabId, message, { frameId: f.frameId }, () => {
              ignoreSendError();
              resolve();
            });
          })
      )
  );
}

function registerSidePanelClickOpensPanel() {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => {
  registerSidePanelClickOpensPanel();
  chrome.contextMenus.create({
    id: "job-autofill-run",
    title: "Fill Form with Saved Details",
    contexts: ["page"]
  });
  chrome.storage.local.get(["settings"], (result) => {
    if (!result.settings) chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  });
});

chrome.runtime.onStartup.addListener(() => {
  registerSidePanelClickOpensPanel();
});

registerSidePanelClickOpensPanel();

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "job-autofill-run" || !tab?.id) return;
  const { settings } = await chrome.storage.local.get(["settings"]);
  await broadcastMessageToTabFrames(tab.id, {
    type: "fillNow",
    payload: {
      dryRun: Boolean(settings?.dryRunMode),
      matchThreshold: Number(settings?.matchThreshold ?? 0.38)
    }
  });
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "trigger-fill") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const { settings } = await chrome.storage.local.get(["settings"]);
  await broadcastMessageToTabFrames(tab.id, {
    type: "fillNow",
    payload: {
      dryRun: Boolean(settings?.dryRunMode),
      matchThreshold: Number(settings?.matchThreshold ?? 0.38)
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "openSidePanel") {
    const tabId = sender?.tab?.id;
    if (typeof tabId !== "number" || !chrome.sidePanel?.open) {
      sendResponse({ ok: false });
      return;
    }
    chrome.sidePanel
      .open({ tabId })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === "notify") {
    const level = message.payload?.level || "info";
    const opts = {
      type: "basic",
      iconUrl: NOTIFICATION_ICON,
      title: `Job Auto Fill (${level})`,
      message: message.payload?.message || "Notification"
    };
    const finish = () => {
      void chrome.runtime.lastError;
      sendResponse({ ok: true });
    };
    try {
      chrome.notifications.create("", opts, finish);
    } catch {
      finish();
    }
    return true;
  }

  if (message?.type === "setBadge") {
    const count = Number(message.payload?.count || 0);
    const tabId = sender?.tab?.id;
    if (typeof tabId === "number") {
      chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : "" });
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" });
    } else {
      chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
      chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
    }
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "getSettings") {
    chrome.storage.local.get(["settings"], (result) => {
      sendResponse({ ok: true, settings: result.settings || DEFAULT_SETTINGS });
    });
    return true;
  }

  if (message?.type === "saveSettings") {
    chrome.storage.local.set({ settings: message.payload || DEFAULT_SETTINGS }, () => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === "triggerFillOnActiveTab") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        sendResponse({ ok: false });
        return;
      }
      chrome.storage.local.get(["settings"], async (result) => {
        const settings = result.settings || DEFAULT_SETTINGS;
        const payload = {
          dryRun: Boolean(message.payload?.dryRun ?? settings.dryRunMode),
          matchThreshold: Number(message.payload?.matchThreshold ?? settings.matchThreshold ?? 0.38)
        };
        try {
          await broadcastMessageToTabFrames(tab.id, { type: "fillNow", payload });
          sendResponse({ ok: true });
        } catch {
          sendResponse({ ok: false });
        }
      });
    });
    return true;
  }

  if (message?.type === "getActiveSettings") {
    chrome.storage.local.get(["settings"], (result) => {
      const settings = result.settings || DEFAULT_SETTINGS;
      sendResponse({
        ok: true,
        settings: {
          dryRunMode: Boolean(settings.dryRunMode),
          matchThreshold: Number(settings.matchThreshold ?? 0.38)
        }
      });
    });
    return true;
  }

  if (message?.type === "triggerUndoOnActiveTab") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        sendResponse({ ok: false });
        return;
      }
      void (async () => {
        try {
          await broadcastMessageToTabFrames(tab.id, { type: "undoFill" });
          sendResponse({ ok: true });
        } catch {
          sendResponse({ ok: false });
        }
      })();
    });
    return true;
  }
});
