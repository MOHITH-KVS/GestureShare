// Clicking the toolbar icon opens GestureShare in Chrome's side panel. The side panel stays open
// while you switch tabs, so hand tracking keeps running (a normal tab is paused by Chrome as soon
// as you look at another tab).
//
// This file also keeps a hidden background page alive (hub.html) so files from your trusted devices
// can arrive while GestureShare is closed, saves them to Downloads, and shows small notifications.

function enableSidePanelOnClick() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(error => console.error("GestureShare: could not set side panel behavior:", error));
}

async function ensureHub() {
  try {
    const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (existing.length) return;
    await chrome.offscreen.createDocument({
      url: "hub.html",
      reasons: ["WEB_RTC"],
      justification: "Receive files from your trusted devices while GestureShare is closed."
    });
  } catch (error) {
    console.warn("GestureShare: background receiver not started:", error && error.message);
  }
}

chrome.runtime.onInstalled.addListener(() => { enableSidePanelOnClick(); ensureHub(); });
chrome.runtime.onStartup.addListener(() => { enableSidePanelOnClick(); ensureHub(); });
enableSidePanelOnClick();
ensureHub();

const safeName = name => String(name || "file").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 200) || "file";

function notify(title, message) {
  try {
    chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title, message, priority: 0 });
  } catch (error) { console.warn("GestureShare: notification failed:", error && error.message); }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || sender.id !== chrome.runtime.id) return;
  if (message.t === "save") {
    chrome.downloads.download({ url: message.url, filename: safeName(message.name), conflictAction: "uniquify" })
      .then(() => notify(`Received ${safeName(message.name)}`, message.from ? `From ${message.from}. Saved to your Downloads folder.` : "Saved to your Downloads folder."))
      .catch(error => notify("Could not save a file", String(error && error.message || error)));
  } else if (message.t === "notify") {
    notify(message.title || "GestureShare", message.message || "");
  } else if (message.t === "ensure-hub") {
    ensureHub();
  }
});

chrome.notifications.onClicked.addListener(id => {
  chrome.notifications.clear(id);
  chrome.tabs.create({ url: chrome.runtime.getURL("camera.html?mode=tab") });
});

// ---- Right-click "Send with GestureShare" (images, links, videos, audio on web pages) -----------
// The click opens the side panel and leaves a note for it ("fetch this address"). The panel does the
// download, and asks for permission to read that one site only if Chrome needs it.
function createMenu() {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({ id: "gs-send", title: "Send with GestureShare", contexts: ["image", "video", "audio", "link"] });
    });
  } catch (error) { console.warn("GestureShare: right-click menu not created:", error && error.message); }
}
chrome.runtime.onInstalled.addListener(createMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "gs-send") return;
  const url = info.srcUrl || info.linkUrl;
  if (!url || !/^https?:/i.test(url)) return;
  // Open the panel first: Chrome only allows that straight from the click.
  try { chrome.sidePanel.open(tab && tab.id >= 0 ? { tabId: tab.id } : { windowId: tab && tab.windowId }).catch(() => {}); } catch {}
  chrome.storage.session.set({ "gs.pending": { url, at: Date.now() } }).catch(() => {});
});
