/**
 * Reliable batch image uploader for FigmaForge.
 * - Loads manifest and roblox-config.json
 * - Uploads all 39 images with rate limiting
 * - SAVES CACHE AFTER EACH SUCCESSFUL UPLOAD (crash-safe)
 * - Then assembles the rbxmx at the end
 * 
 * Usage: node _upload_all.js
 */
const fs = require('fs');
const path = require('path');

const MANIFEST_PATH = path.join(__dirname, 'manifest_DailyReward_v2.json');
const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'scripts', 'roblox-config.json');
const CACHE_PATH = path.join(__dirname, 'dist', '.figmaforge-image-cache.json');
const OUTPUT_PATH = path.resolve(__dirname, '..', '..', 'src', 'ReplicatedStorage', 'DailyRewardModal.rbxmx');
const RATE_LIMIT_MS = 2000;
const POLL_DELAY_MS = 2000;
const MAX_POLL_ATTEMPTS = 30;

// Load config
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
if (!cfg.apiKey || !cfg.creatorId) {
  console.error('Missing apiKey or creatorId in', CONFIG_PATH);
  process.exit(1);
}
console.log('Config: apiKey=' + cfg.apiKey.length + 'chars, creatorId=' + cfg.creatorId);

// Load cache
function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
  } catch {
    return { version: '1.0.0', entries: {} };
  }
}
function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

async function pollOperation(opPath) {
  const url = opPath.startsWith('http')
    ? opPath
    : 'https://apis.roblox.com/assets/v1/' + opPath;
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await new Promise(r => setTimeout(r, POLL_DELAY_MS));
    try {
      const resp = await fetch(url, { headers: { 'x-api-key': cfg.apiKey.trim() } });
      if (resp.ok) {
        const result = await resp.json();
        if (result.done) return result;
      }
    } catch {}
  }
  throw new Error('Poll timeout after ' + (MAX_POLL_ATTEMPTS * POLL_DELAY_MS / 1000) + 's');
}

async function uploadImage(imageBuffer, displayName) {
  const boundary = '----FF' + Date.now();
  const CRLF = '\r\n';
  const reqJson = JSON.stringify({
    assetType: 'Image',
    displayName: displayName.slice(0, 50),
    description: 'FigmaForge export',
    creationContext: { creator: { userId: cfg.creatorId } },
  });
  const preamble = Buffer.from(
    '--' + boundary + CRLF +
    'Content-Disposition: form-data; name="request"' + CRLF +
    'Content-Type: application/json' + CRLF + CRLF +
    reqJson + CRLF +
    '--' + boundary + CRLF +
    'Content-Disposition: form-data; name="fileContent"; filename="' + displayName + '.png"' + CRLF +
    'Content-Type: image/png' + CRLF + CRLF
  );
  const epilogue = Buffer.from(CRLF + '--' + boundary + '--' + CRLF);
  const body = Buffer.concat([preamble, imageBuffer, epilogue]);

  const resp = await fetch('https://apis.roblox.com/assets/v1/assets', {
    method: 'POST',
    headers: {
      'x-api-key': cfg.apiKey.trim(),
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      'Content-Length': String(body.length),
    },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error('HTTP ' + resp.status + ': ' + text.slice(0, 300));
  }
  const result = await resp.json();
  
  if (result.done && result.response?.assetId) {
    return String(result.response.assetId);
  }
  if (result.path) {
    const final = await pollOperation(result.path);
    if (final?.response?.assetId) return String(final.response.assetId);
  }
  if (result.assetId) return String(result.assetId);
  throw new Error('No assetId in response: ' + JSON.stringify(result).slice(0, 200));
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  const exportedImages = manifest.exportedImages || {};
  const unresolvedImages = manifest.unresolvedImages || [];
  
  console.log('Manifest: ' + unresolvedImages.length + ' unresolved images, ' + Object.keys(exportedImages).length + ' exported');
  
  const cache = loadCache();
  let uploaded = 0, cached = 0, failed = 0;
  
  for (let i = 0; i < unresolvedImages.length; i++) {
    const hash = unresolvedImages[i];
    
    // Check cache
    if (cache.entries[hash]) {
      cached++;
      console.log('[' + (i + 1) + '/' + unresolvedImages.length + '] 📦 Cached: ' + hash.slice(0, 15) + '... → rbxassetid://' + cache.entries[hash].assetId);
      continue;
    }
    
    // Get base64 data
    const b64 = exportedImages[hash];
    if (!b64) {
      console.error('[' + (i + 1) + '/' + unresolvedImages.length + '] ❌ No data for: ' + hash);
      failed++;
      continue;
    }
    
    const buf = Buffer.from(b64, 'base64');
    const name = 'figmaforge_' + hash.slice(0, 8);
    console.log('[' + (i + 1) + '/' + unresolvedImages.length + '] 🔄 Uploading: ' + hash.slice(0, 15) + '... (' + (buf.length / 1024).toFixed(1) + 'KB)');
    
    try {
      const assetId = await uploadImage(buf, name);
      cache.entries[hash] = { imageHash: hash, assetId, uploadedAt: new Date().toISOString() };
      saveCache(cache); // SAVE AFTER EACH SUCCESS
      uploaded++;
      console.log('[' + (i + 1) + '/' + unresolvedImages.length + '] ✅ rbxassetid://' + assetId);
      
      // Rate limit
      if (i < unresolvedImages.length - 1) {
        await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
      }
    } catch (e) {
      console.error('[' + (i + 1) + '/' + unresolvedImages.length + '] ❌ Upload failed: ' + e.message);
      failed++;
      // Continue instead of fail-fast — upload remaining images
    }
  }
  
  console.log('\n=== Upload Summary ===');
  console.log('Uploaded: ' + uploaded + ', Cached: ' + cached + ', Failed: ' + failed);
  console.log('Cache saved: ' + Object.keys(cache.entries).length + ' entries');
  
  if (failed > 0) {
    console.error('⚠️  ' + failed + ' images failed — rbxmx will have missing assets');
  }
  
  // Now assemble rbxmx using the CLI (with cache populated)
  console.log('\n=== Assembling rbxmx ===');
  const { setConfig, resolveImages } = require('./dist/figma-forge-images');
  const { processManifestAsync } = require('./dist/figma-forge-cli');
  
  setConfig(cfg.apiKey, cfg.creatorId);
  
  const manifestJson = fs.readFileSync(MANIFEST_PATH, 'utf-8');
  const rbxmx = await processManifestAsync(manifestJson, {
    resolveImages: true,
    verbose: true,
    scale: 2,
    exportedImages: exportedImages,
  });
  
  fs.writeFileSync(OUTPUT_PATH, rbxmx);
  console.log('✅ Written: ' + OUTPUT_PATH + ' (' + rbxmx.length + ' chars)');
}

main().then(() => { console.log('DONE'); process.exit(0); }).catch(e => { console.error('FATAL:', e.message); process.exit(1); });
