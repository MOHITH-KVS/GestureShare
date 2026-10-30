// Clicking the toolbar icon opens GestureShare in Chrome's side panel. The side panel stays open
// while you switch tabs, so hand tracking keeps running (a normal tab is paused by Chrome as soon
// as you look at another tab).
//
// "Open in a tab" (a button inside the page) opens camera.html?mode=tab as a fallback.

function enableSidePanelOnClick() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(error => console.error("GestureShare: could not set side panel behavior:", error));
}

chrome.runtime.onInstalled.addListener(enableSidePanelOnClick);
chrome.runtime.onStartup.addListener(enableSidePanelOnClick);
enableSidePanelOnClick();
