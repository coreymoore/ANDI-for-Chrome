const fs = require('fs');
const path = require('path');
const https = require('https');

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
const jqueryDownloadUrl = 'https://code.jquery.com/jquery-3.7.1.min.js';

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

  let modifiedContent = originalContent
    .replace(hostRegex, extensionHostUrl)
    .replace(jquerySourceRegex, extensionJqueryDownloadSource);
  
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
build().catch(error => {
  console.error('❌ Build failed:', error.message);
  process.exit(1);
});
