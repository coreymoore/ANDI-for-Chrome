// background.js — service worker for toggling ANDI
// Uses the scripting API to inject jquery and ANDI into the active tab (main world)

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  const tabId = tab.id;

  const extAndiBase = chrome.runtime.getURL('andi/');

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

  // Step 1.5: Inject Trusted Types policy to allow innerHTML/html() operations (for pages with strict CSP)
  // (Note: a declarative content script in manifest also handles this at document_start for early coverage)
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      if (window.trustedTypes) {
        try {
          window.trustedTypes.createPolicy('default', {
            createHTML: (s) => s,
            createScript: (s) => s,
            createScriptURL: (s) => s,
            createURL: (s) => s
          });
        } catch (e) {
          // Policy already exists or creation failed; ignore
        }
      }
    },
    world: 'MAIN'
  });

  if (!hasJquery) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['jquery.min.js'],
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
