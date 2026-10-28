const CAMERA_URL = chrome.runtime.getURL("camera.html");

let lastOpened = { tabId: null, at: 0 };
let queue = Promise.resolve();

async function focusTab(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

async function openCameraNow() {
  // Is the camera page already open? getContexts() lists this extension's own pages and does not
  // need the "tabs" permission. (A page that is still loading is not listed yet, so we also
  // remember the tab we opened a moment ago.)
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["TAB"],
    documentUrls: [CAMERA_URL]
  });

  if (existing.length > 0) {
    await focusTab(existing[0].tabId);
    return;
  }

  if (lastOpened.tabId !== null && Date.now() - lastOpened.at < 3000) {
    try {
      await focusTab(lastOpened.tabId);
      return;
    } catch {
      // That tab is already closed; open a new one below.
    }
  }

  const tab = await chrome.tabs.create({ url: CAMERA_URL });
  lastOpened = { tabId: tab.id, at: Date.now() };
}

// Open the camera page once and switch to it on later clicks, instead of opening a new tab each
// time (several tabs would fight over the webcam). Clicks are handled one at a time.
function openCamera() {
  queue = queue.then(openCameraNow, openCameraNow);
  return queue;
}

chrome.action.onClicked.addListener(openCamera);
