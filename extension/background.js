const andiModuleCssMap = { 'c': 'andi/candi.css', 'g': 'andi/gandi.css', 'h': 'andi/handi.css', 'i': 'andi/iandi.css', 'l': 'andi/landi.css', 's': 'andi/sandi.css', 't': 'andi/tandi.css' };

// Handle requests from content script to inject module CSS
chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
  if (request.action === 'injectModuleCss' && request.module && andiModuleCssMap[request.module]) {
    try {
      await chrome.scripting.insertCSS({
        target: { tabId: sender.tab.id },
        files: [andiModuleCssMap[request.module]]
      });
      sendResponse({ success: true });
    } catch (e) {
      console.warn('Failed to inject module CSS for', request.module, e);
      sendResponse({ success: false });
    }
  }
});
// background.js — service worker for toggling ANDI
// Uses the scripting API to inject jquery and ANDI into the active tab (main world)

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  const tabId = tab.id;

  const extAndiBase = chrome.runtime.getURL('andi/');

  const andiModuleFiles = ['andi/modules-wrapped/candi.js', 'andi/modules-wrapped/fandi.js', 'andi/modules-wrapped/gandi.js', 'andi/modules-wrapped/handi.js', 'andi/modules-wrapped/iandi.js', 'andi/modules-wrapped/landi.js', 'andi/modules-wrapped/sandi.js', 'andi/modules-wrapped/tandi.js'];

  // Step 1: Check if ANDI is already present
  const [{result: isPresent}] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => !!document.getElementById('ANDI508'),
    world: 'MAIN'
  });

  if (isPresent) {
    // Close ANDI
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try { if (window.andiResetter && typeof window.andiResetter.hardReset === 'function') window.andiResetter.hardReset(); }
        catch (e) { console.warn('Error closing ANDI', e); }
      },
      world: 'MAIN'
    });
    return;
  }

  // Step 2: Inject local jQuery (if the page does not provide a usable one)
  const [{result: hasJquery}] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      try {
        // simple version check
        return !!(window.jQuery && window.jQuery.fn && window.jQuery.fn.jquery);
      } catch (e) { return false; }
    },
    world: 'MAIN'
  });

  if (!hasJquery) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['lib/jquery.min.js'],
      world: 'MAIN'
    });
  }

  // Step 2.5: Set host_url to extension URL so ANDI uses it for all asset/module loads
  await chrome.scripting.executeScript({
    target: { tabId },
    args: [extAndiBase],
    func: (extBase) => {
      window.host_url = extBase;
    },
    world: 'MAIN'
  });

  // Preload module scripts via scripting API to avoid CSP script-src blocks
  if (andiModuleFiles.length) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: andiModuleFiles,
      world: 'MAIN'
    });
  }

// Step 3: Inject ANDI
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['andi/andi.js'],
    world: 'MAIN'
  });

  // Inject ANDI CSS directly from the extension to avoid page CSP/style-src issues.
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['andi/andi.css']
    });
  } catch (e) {
    console.warn('Failed to insert ANDI CSS', e);
  }

  // Do not manually call launchAndi here; andi.js initializes itself.
});
