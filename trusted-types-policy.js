// Inject a permissive default Trusted Types policy early (runs at document_start)
// This allows jQuery and ANDI to use innerHTML/html() even on pages with strict Trusted Types CSP.
(function() {
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
})();
