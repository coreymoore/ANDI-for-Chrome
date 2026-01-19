const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

// Configuration
const config = {
  sourceAndiDir: './andi',
  targetAndiDir: './extension/andi',
  targetLibDir: './extension/lib',
  jqueryTargetFile: './extension/lib/jquery.min.js',
  originalAndiFile: './andi/andi.js',
  targetAndiFile: './extension/andi/andi.js',
  modulesSourceDir: './andi',
  modulesWrappedDir: './extension/andi/modules-wrapped',
  readmeSourceFile: './readme.md',
  readmeTargetFile: './extension/README.md',
  privacySourceFile: './PRIVACY_POLICY.md',
  privacyTargetFile: './extension/PRIVACY_POLICY.md',
  cleanBuild: process.argv.includes('--clean')
};

// jQuery source to download if missing
const jqueryDownloadUrl = 'https://code.jquery.com/jquery-4.0.0.min.js';

// Extension version: use window.host_url if background.js set it; otherwise throw
const extensionHostUrl = `var host_url = (function() {
  if (typeof window === "undefined") {
    throw new Error("ANDI: window is undefined; host_url cannot be determined. Ensure ANDI is running in a browser context.");
  }
  if (typeof window.host_url === "string" && window.host_url.length > 0) {
    return window.host_url;
  }
  throw new Error("ANDI: window.host_url is undefined or empty; ANDI assets cannot be loaded. Ensure background.js sets window.host_url before loading andi.js.");
})();`;

const originalJqueryDownloadSource = `var jqueryDownloadSource = "https://ajax.googleapis.com/ajax/libs/jquery/";`;
const extensionJqueryDownloadSource = `var jqueryDownloadSource = ""; // Disabled for extension build`;

// Trusted Types helper to wrap strings before passing to jQuery 4.0.0
// This is necessary because jQuery 4.0 supports TrustedHTML but doesn't auto-sanitize strings
const ttHelper = `// Trusted Types helper injected by extension build
(function() {
  if (!window.trustedTypes) return;
  
  var policy = null;
  try {
    policy = window.trustedTypes.createPolicy('andi-policy', {
      createHTML: function(s) { return s; },
      createScript: function(s) { return s; },
      createScriptURL: function(s) { return s; }
    });
  } catch(e) {
    // Fallback to default policy if it exists
    if (window.trustedTypes.defaultPolicy) {
       policy = window.trustedTypes.defaultPolicy;
    }
  }
  
  if (!policy) return;
  
  var makeHTML = function(str) { return policy.createHTML(str); };
  var makeScriptURL = function(str) { return policy.createScriptURL(str); };
  
  window.ANDI_TRUSTED = window.ANDI_TRUSTED || {};
  window.ANDI_TRUSTED.makeScriptURL = makeScriptURL;
  
  // Patch jQuery.htmlPrefilter to auto-wrap strings in TrustedHTML
  // This covers $() creation, .html(), .append(), .wrapInner(), etc.
  if (window.jQuery) {
    var originalPrefilter = window.jQuery.htmlPrefilter;
    window.jQuery.htmlPrefilter = function(html) {
      var result = originalPrefilter ? originalPrefilter(html) : html;
      if (typeof result === 'string') {
        return makeHTML(result);
      }
      return result;
    };
  }
})();`;

// Regex pattern for jQuery CDN URLs in HTML
const jqueryScriptRegex = /<script[^>]*src=["']https?:\/\/[^"']*jquery[^"']*\.min\.js["'][^>]*><\/script>/gi;
const jqueryScriptReplacement = '<script src="../../lib/jquery.min.js"></script>';

// Store original andi.js content for restoration (in memory, no backup file)
let originalAndiContent = null;
let wrappedModules = [];
let andiModuleCssFiles = [];

/**
 * Inject module file list and loader hook into extension/background.js
 * so modules are pre-injected via chrome.scripting (bypassing page CSP).
 */
function patchBackgroundForModules() {
  const bgPath = path.join(__dirname, 'extension', 'background.js');
  if (!fs.existsSync(bgPath)) {
    console.warn(`  ⚠ Warning: extension background.js not found at ${bgPath}`);
    return;
  }

  if (!wrappedModules.length) {
    console.warn('  ⚠ Warning: no wrapped modules found; skipping background patch');
    return;
  }

  const bgContent = fs.readFileSync(bgPath, 'utf8');
  const moduleArray = wrappedModules.map(m => `'${m}'`).join(', ');
  const cssMap = andiModuleCssFiles.length > 0 
    ? `const andiModuleCssMap = { ${andiModuleCssFiles.map(css => {
        const match = css.match(/andi\/(.)andi\.css/);
        return match ? `'${match[1]}': '${css}'` : null;
      }).filter(Boolean).join(', ')} };`
    : 'const andiModuleCssMap = {};';

  const modulesConst = `  const andiModuleFiles = [${moduleArray}];\n  ${cssMap}`;

  let updated = bgContent;

  // Remove any existing preload block to avoid duplicates
  const preloadBlockRegex = /\n\s*\/\/ Preload module scripts[\s\S]*?andiModuleFiles,[\s\S]*?}\);\n\s*}\n/;
  if (preloadBlockRegex.test(updated)) {
    updated = updated.replace(preloadBlockRegex, '\n');
  }

  // Insert module files constant after extAndiBase declaration
  const extBaseRegex = /(const extAndiBase = chrome\.runtime\.getURL\('andi\/'\);)/;
  if (!updated.includes('const andiModuleFiles') && extBaseRegex.test(updated)) {
    updated = updated.replace(extBaseRegex, (match) => match + '\n\n' + modulesConst);
  } else if (!extBaseRegex.test(updated)) {
    console.warn('  ⚠ Warning: could not find extAndiBase declaration to inject module list.');
  }

  // Add message listener for dynamic CSS injection at the top with CSS map
  const messageListenerRegex = /(chrome\.action\.onClicked\.addListener\(async \(tab\))/;
  
  // Remove any existing message listener block - matches from andiModuleCssMap to // background.js comment
  const existingListenerRegex = /^const andiModuleCssMap[\s\S]*?^\/\/ background\.js/m;
  updated = updated.replace(existingListenerRegex, '// background.js');
  
  if (messageListenerRegex.test(updated)) {
    const cssMapEntries = andiModuleCssFiles.map(css => {
      const match = css.match(/andi\/(.)andi\.css/);
      return match ? `'${match[1]}': '${css}'` : null;
    }).filter(Boolean).join(', ');
    const cssMapDecl = `const andiModuleCssMap = { ${cssMapEntries} };\n\n`;
    const messageListener = `${cssMapDecl}// Handle requests from content script to inject module CSS\nchrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {\n  if (request.action === 'injectModuleCss' && request.module && andiModuleCssMap[request.module]) {\n    try {\n      await chrome.scripting.insertCSS({\n        target: { tabId: sender.tab.id },\n        files: [andiModuleCssMap[request.module]]\n      });\n      sendResponse({ success: true });\n    } catch (e) {\n      console.warn('Failed to inject module CSS for', request.module, e);\n      sendResponse({ success: false });\n    }\n  }\n});\n`;
    updated = messageListener + updated;
  }

  // Insert module injection after injecting andi.js
  const injectAndiRegex = /(\/\/ Step 3: Inject ANDI[\s\S]*?files: \['andi\/andi\.js'\],[\s\S]*?\}\);)/m;
  if (!updated.includes('Preload module scripts') && injectAndiRegex.test(updated)) {
    updated = updated.replace(injectAndiRegex, (match) => `  // Preload module scripts via scripting API to avoid CSP script-src blocks\n  if (andiModuleFiles.length) {\n    await chrome.scripting.executeScript({\n      target: { tabId },\n      files: andiModuleFiles,\n      world: 'MAIN'\n    });\n  }\n\n` + match);
  } else if (!injectAndiRegex.test(updated)) {
    console.warn('  ⚠ Warning: could not find ANDI injection block to add module preload.');
  }

  fs.writeFileSync(bgPath, updated, 'utf8');
  console.log('  ✓ Updated extension/background.js with module CSS map and message listener');
}

/**
 * Get file modification time
 */
function getModTime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Check if file needs updating (incremental build)
 */
function needsUpdate(sourcePath, targetPath) {
  if (config.cleanBuild) return true;
  
  const sourceModTime = getModTime(sourcePath);
  const targetModTime = getModTime(targetPath);
  
  return sourceModTime > targetModTime;
}

/**
 * Recursively copy directory with incremental logic
 */
function copyDirRecursive(src, dest, processCallback) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const files = fs.readdirSync(src);
  
  files.forEach(file => {
    // Skip backup files
    if (file.endsWith('.backup')) {
      return;
    }
    
    const srcPath = path.join(src, file);
    const destPath = path.join(dest, file);
    const stat = fs.statSync(srcPath);

    if (stat.isDirectory()) {
      copyDirRecursive(srcPath, destPath, processCallback);
    } else if (needsUpdate(srcPath, destPath)) {
      // For HTML, run callback and write as text; otherwise copy as binary
      if (processCallback && file.endsWith('.html')) {
        let content = fs.readFileSync(srcPath, 'utf8');
        content = processCallback(content, file);
        fs.writeFileSync(destPath, content, 'utf8');
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
      console.log(`  ✓ ${destPath}`);
    }
  });
}

/**
 * Process HTML file to replace jQuery CDN with local reference
 */
function processHtmlFile(content, filename) {
  if (filename.endsWith('.html')) {
    return content.replace(jqueryScriptRegex, jqueryScriptReplacement);
  }
  return content;
}

/**
 * Download jQuery into the lib folder if missing or on clean build
 */
function ensureJquery() {
  const target = config.jqueryTargetFile;

  const needsDownload = config.cleanBuild || !fs.existsSync(target);
  if (!needsDownload) {
    return;
  }

  fs.mkdirSync(config.targetLibDir, { recursive: true });

  console.log(`\n⬇️  Downloading jQuery to ${target} ...`);

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(target);
    https.get(jqueryDownloadUrl, response => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download jQuery: HTTP ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => {
      fs.unlink(target, () => reject(err));
    });
  });
}

/**
 * Wrap module scripts so they expose a factory without polluting globals
 * and record the list for injection via background.js (bypasses CSP).
 */
function wrapModules() {
  const srcDir = config.modulesSourceDir;
  const destDir = config.modulesWrappedDir;
  if (!fs.existsSync(srcDir)) {
    console.warn(`  ⚠ Warning: modules source dir missing at ${srcDir}`);
    return;
  }
  fs.mkdirSync(destDir, { recursive: true });

  const moduleFiles = fs.readdirSync(srcDir)
    .filter(f => /^[a-z]andi\.js$/.test(f));

  wrappedModules = [];
  andiModuleCssFiles = [];

  moduleFiles.forEach(file => {
    const letter = file[0];
    const srcPath = path.join(srcDir, file);
    const destPath = path.join(destDir, file);
    const content = fs.readFileSync(srcPath, 'utf8');

    const wrapped = `// Auto-wrapped by build to allow CSP-safe module loading\n` +
      `(function(){\n` +
      `  window.ANDI_MODULES = window.ANDI_MODULES || {};\n` +
      `  window.ANDI_MODULES['${letter}'] = function(){\n` +
      `    var capturedInit = null;\n` +
      `    (function(){\n${content}\n      if (typeof init_module === 'function') {\n        capturedInit = init_module;\n      } else if (typeof window.init_module === 'function') {\n        capturedInit = window.init_module;\n      }\n    })();\n` +
      `    return capturedInit;\n` +
      `  };\n` +
      `})();\n`;

    fs.writeFileSync(destPath, wrapped, 'utf8');
    wrappedModules.push(`andi/modules-wrapped/${file}`);
    
    // Track CSS file if it exists
    const cssFile = `${letter}andi.css`;
    const cssPath = path.join(srcDir, cssFile);
    if (fs.existsSync(cssPath)) {
      andiModuleCssFiles.push(`andi/${cssFile}`);
      console.log(`  ✓ Wrapped module ${file} (with CSS)`);
    } else {
      console.log(`  ✓ Wrapped module ${file}`);
    }
  });
}

/**
 * Backup original file content in memory and apply modifications for extension build
 */
function backupAndModifyAndi() {
  const originalContent = fs.readFileSync(config.originalAndiFile, 'utf8');
  
  // Store original content in memory for later restoration
  originalAndiContent = originalContent;
  
  // Create modified content for extension
  // Use regex to be resilient to whitespace/formatting changes
  const hostRegex = /var\s+host_url\s*=\s*(?:\(function\(\)\s*{[\s\S]*?}\s*\)\(\)|"[^"]+"|\'[^\']+\');/m;
  const jquerySourceRegex = /var\s+jqueryDownloadSource\s*=\s*"https:\/\/ajax\.googleapis\.com\/ajax\/libs\/jquery\/";/;
  const iconsRegex = /(var\s+icons_url\s*=\s*host_url\+"icons\/";\s*)/;
  const scriptSrcBlockRegex = /\/\/Load the module's script[\s\S]*?document\.getElementsByTagName\("head"\)\[0\]\.appendChild\(script\);/m;

  // CSP Fix Regexes
  const manualCssRegex = /\/\/Load andi\.css file immediately[\s\S]*?\}\)\(\);/m;
  const wrapInnerRegex = /var\s+body_padding\s*=\s*"padding:"\s*\+\s*\$\(body\)\.css\("padding-top"\)[\s\S]*?\.prepend\(andiBar\);\s*\/\/insert ANDI display into body/m;
  const javascriptVoidRegex = /(listItemHtml\s*\+=\s*["'])href='javascript:void\(0\)'/g;
  const frameStyleRegex = /<style>body\{margin-left:1em;\}[\s\S]*?<\/style>/;

  const wrapInnerReplacement = [
    '',
    '		//CSP Fix: Use .css() instead of style attribute',
    '		var paddingVal = $(body).css("padding-top")+" "+$(body).css("padding-right")+" "+',
    '			$(body).css("padding-bottom")+" "+$(body).css("padding-left");',
    '		var marginVal = $(body).css("margin-top")+" 0px "+',
    '			$(body).css("margin-bottom")+" 0px";',
    '',
    '		$("html").addClass("ANDI508-testPage");',
    '		$(body)',
    '			.addClass("ANDI508-testPage")',
    '			.wrapInner("<div id=\'ANDI508-testPage\'></div>") //removed inline style',
    '			.prepend(andiBar);',
    '		$("#ANDI508-testPage").css({"padding": paddingVal, "margin": marginVal});'
  ].join("\n");

  const dynamicCssHelper = `// Dynamic CSS injection helper for CSP compliance
    window.andiRequestModuleCss = function(moduleLetter) {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage(
          { action: 'injectModuleCss', module: moduleLetter },
          function(response) {
            if (response && !response.success) {
              console.warn('Failed to inject CSS for module:', moduleLetter);
            }
          }
        );
      }
    };`;

  let modifiedContent = originalContent
    .replace(hostRegex, extensionHostUrl)
    .replace(jquerySourceRegex, extensionJqueryDownloadSource)
    .replace(iconsRegex, `$1\n\n${ttHelper}\n\n${dynamicCssHelper}\n`)
    .replace(manualCssRegex, '// Manual CSS injection removed for extension (handled by background.js)')
    .replace(wrapInnerRegex, wrapInnerReplacement)
    .replace(javascriptVoidRegex, "$1href='#'")
    .replace(frameStyleRegex, "")
    .replace(scriptSrcBlockRegex, `//Load the module's script\n    var factory = (window.ANDI_MODULES && window.ANDI_MODULES[module]);\n    var moduleInit = factory ? factory() : null;\n\n    $("#andiModuleScript").remove(); //Remove previously added module script\n    $("#andiModuleCss").remove();//remove previously added module css\n\n    if (typeof moduleInit === "function") {\n      // Request module CSS injection via message\n      if (typeof window.andiRequestModuleCss === 'function') {\n        window.andiRequestModuleCss(module);\n      }\n      init_module = moduleInit;\n      init_module();\n    } else {\n      console.error("ANDI: module factory not found for " + module);\n    }`);
  
  fs.writeFileSync(config.targetAndiFile, modifiedContent, 'utf8');
  console.log(`  ✓ ${config.targetAndiFile} (modified with chrome.runtime.getURL)`);
}

/**
 * Copy README and PRIVACY_POLICY files to extension folder
 */
function copyDocumentationFiles() {
  // Copy README
  if (fs.existsSync(config.readmeSourceFile)) {
    const readmeContent = fs.readFileSync(config.readmeSourceFile, 'utf8');
    fs.writeFileSync(config.readmeTargetFile, readmeContent, 'utf8');
    console.log(`  ✓ ${config.readmeTargetFile}`);
  } else {
    console.warn(`  ⚠ Warning: README file not found at ${config.readmeSourceFile}`);
  }

  // Copy PRIVACY_POLICY
  if (fs.existsSync(config.privacySourceFile)) {
    const privacyContent = fs.readFileSync(config.privacySourceFile, 'utf8');
    fs.writeFileSync(config.privacyTargetFile, privacyContent, 'utf8');
    console.log(`  ✓ ${config.privacyTargetFile}`);
  } else {
    console.warn(`  ⚠ Warning: PRIVACY_POLICY file not found at ${config.privacySourceFile}`);
  }
}

/**
 * Restore original andi.js file from memory
 */
function restoreOriginalAndi() {
  if (originalAndiContent) {
    fs.writeFileSync(config.originalAndiFile, originalAndiContent, 'utf8');
    console.log(`  ✓ Restored original ${config.originalAndiFile}`);
  }
}

/**
 * Main build process
 */
async function build() {
  console.log('\n🚀 ANDI Extension Build Process\n');
  
  // Clean build: delete andi and lib directories
  if (config.cleanBuild) {
    console.log('🗑️  Clean build: removing previous builds...');
    if (fs.existsSync(config.targetAndiDir)) {
      fs.rmSync(config.targetAndiDir, { recursive: true, force: true });
      console.log(`  ✓ Removed ${config.targetAndiDir}`);
    }
  }
  
  // Step 1: Ensure jQuery is present in lib
  await ensureJquery();

  // Step 1.5: Wrap modules for CSP-safe injection
  console.log('\n🧩 Wrapping module scripts for CSP-safe injection...');
  wrapModules();

  // Step 1.6: Patch background.js to preload wrapped modules
  console.log('\n🛰️  Updating background.js with module preload list...');
  patchBackgroundForModules();

  // Step 2: Copy andi directory with HTML processing
  console.log('\n📂 Copying andi directory (with jQuery CDN replacement)...');
  if (!fs.existsSync(config.sourceAndiDir)) {
    console.error(`  ✗ Error: Source andi directory not found at ${config.sourceAndiDir}`);
    process.exit(1);
  }
  copyDirRecursive(config.sourceAndiDir, config.targetAndiDir, processHtmlFile);
  
  // Step 3: Copy documentation files
  console.log('\n📄 Copying documentation files...');
  copyDocumentationFiles();
  
  // Step 4: Backup original andi.js and apply modifications
  console.log('\n🔧 Modifying host_url and jqueryDownloadSource in andi.js...');
  backupAndModifyAndi();
  
  // Step 5: Restore original andi.js
  console.log('\n✨ Restoring original andi.js...');
  restoreOriginalAndi();
  
  console.log('\n✅ Build complete!\n');
}

// Run build
async function zipExtension() {
  try {
    const pkgPath = path.join(__dirname, 'package.json');
    const pkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')) : {};

    // Prefer extension manifest version; fall back to package.json
    const manifestPath = path.join(__dirname, 'extension', 'manifest.json');
    let version = '0.0.0';
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest && manifest.version) {
          version = manifest.version;
          console.log(`  ℹ Using version ${version} from extension/manifest.json`);
        } else if (pkg.version) {
          version = pkg.version;
          console.log(`  ℹ extension/manifest.json missing version; falling back to package.json version ${version}`);
        }
      } catch (e) {
        if (pkg.version) {
          version = pkg.version;
          console.log(`  ℹ Failed to parse extension/manifest.json; using package.json version ${version}`);
        } else {
          console.log(`  ⚠ Could not determine version from manifest or package.json; using ${version}`);
        }
      }
    } else {
      version = pkg.version || version;
      console.log(`  ℹ extension/manifest.json not found; using package.json version ${version}`);
    }

    const distDir = path.join(__dirname, 'dist');
    if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });

    const zipName = `andi-extension-v${version}.zip`;
    const zipPath = path.join(distDir, zipName);

    console.log(`\n📦 Creating zip ${zipPath} ...`);

    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

    // Use system zip command to create archive of the extension folder
    const cmd = `zip -r "${zipPath}" extension -x "*.DS_Store"`;
    execSync(cmd, { stdio: 'inherit' });

    console.log(`  ✓ Created ${zipPath}`);

    // Ensure .gitignore has /dist/
    const gitignorePath = path.join(__dirname, '.gitignore');
    let gitignoreContent = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
    const gitignoreLine = '/dist/';
    const lines = gitignoreContent.split(/\r?\n/).map(l => l.trim());
    if (!lines.includes(gitignoreLine)) {
      gitignoreContent = (gitignoreContent.trim().length ? gitignoreContent + '\n' : '') + gitignoreLine + '\n';
      fs.writeFileSync(gitignorePath, gitignoreContent, 'utf8');
      console.log(`  ✓ Added ${gitignoreLine} to .gitignore`);
    } else {
      console.log(`  ✓ ${gitignoreLine} already present in .gitignore`);
    }
  } catch (err) {
    console.warn(`  ⚠ Warning: creating zip or updating .gitignore failed: ${err.message}`);
  }
}

build().then(async () => {
  await zipExtension();
  console.log('\n✅ Build + zip complete!\n');
}).catch(error => {
  console.error('❌ Build failed:', error.message);
  process.exit(1);
});
