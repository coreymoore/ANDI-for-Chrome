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
  const scriptSrcRegex = /script\.src\s*=\s*host_url\s*\+\s*module\s*\+\s*"andi\.js";/;

  let modifiedContent = originalContent
    .replace(hostRegex, extensionHostUrl)
    .replace(jquerySourceRegex, extensionJqueryDownloadSource)
    .replace(iconsRegex, `$1\n\n${ttHelper}\n`)
    .replace(scriptSrcRegex, 'script.src = (window.ANDI_TRUSTED && window.ANDI_TRUSTED.makeScriptURL) ? window.ANDI_TRUSTED.makeScriptURL(host_url + module + "andi.js") : (host_url + module + "andi.js");');
  
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
