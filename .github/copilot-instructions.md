# Copilot Instructions for ANDI-for-Chrome

## Project Overview
- This is a Chrome extension for the ANDI accessibility inspector, based on Manifest V3.
- The extension toggles the ANDI overlay in the active tab when the extension button is clicked.
- Core logic is in `background.js` (service worker) and `andi/andi.js` (main overlay code).

## Key Components
- `background.js`: Handles extension button clicks, injects jQuery (if missing), then injects `andi/andi.js` and `andi/andi.css` into the page.
- `andi/andi.js`: Main ANDI logic. Uses global variables for config (e.g., `host_url`, `icons_url`). On extension injection, these are rewritten to use `chrome.runtime.getURL('andi/')`.
- `manifest.json`: Configures permissions (`scripting`, `activeTab`), web accessible resources, and service worker.
- `andi/`: Contains all ANDI modules, CSS, icons, and help assets. Each module (e.g., `fandi.js`, `candi.js`) provides a different accessibility analysis.

## Developer Workflows
- **Testing**: Load the extension unpacked in Chrome (`chrome://extensions` > "Load unpacked" > repo root). Click the extension button to toggle ANDI overlay.
- **jQuery**: `jquery.min.js` is a placeholder; replace with a real minified jQuery before packaging.
- **Packaging**: Only files in the repo root and `andi/` are needed. Exclude development/test files not meant for distribution.

## Project-Specific Patterns
- Asset URLs (CSS, icons, images) are rewritten after injection to use `chrome-extension://` URLs for CSP compatibility.
- The extension does not persist ANDI across navigations; it must be toggled per page load.
- Uses global objects (e.g., `andiResetter`, `andiSettings`) for state and configuration.
- Module pattern: Each accessibility module (e.g., `fandi.js`, `candi.js`) is loaded via `andi.js` and can be extended independently.

## Integration Points
- No external APIs; all dependencies are local (except for jQuery, which is bundled).
- Help and documentation are in `andi/help/` (HTML, CSS, JS).
- Icons and images are in `andi/icons/` and `andi/help/images/`.

## Example: Injecting ANDI
- On button click, `background.js`:
  1. Checks for `#ANDI508` in the page.
  2. If present, calls `andiResetter.hardReset()` to close overlay.
  3. If absent, injects jQuery (if missing), then `andi/andi.js` and `andi/andi.css`.
  4. Rewrites asset URLs and launches ANDI.

## References
- See `README-EXTENSION.md` for extension-specific details.
- See `andi/andi.js` for main overlay logic and module loading.
- See `manifest.json` for permissions and resource configuration.

---

**If any section is unclear or missing important project-specific details, please provide feedback so this guide can be improved.**
