// Upload PNGs using Node.js built-in fetch (no deps) 
const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'roblox-config.json'), 'utf-8'));
const CACHE_PATH = path.join(__dirname, 'dist', '.figmaforge-image-cache.json');

async function uploadImage(filePath, displayName) {
  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  const fileBytes = fs.readFileSync(filePath);
  
  const requestJson = JSON.stringify({
    assetType: 'Image',
    displayName,
    description: 'FigmaForge export',
    creationContext: { creator: { userId: config.creatorId } },
  });

  // Build multipart body manually
  const parts = [];
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n${requestJson}`);
  
  // Combine text prefix + binary + text suffix
  const prefix = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="fileContent"; filename="${path.basename(filePath)}"\r\nContent-Type: image/png\r\n\r\n`);
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const textPrefix = Buffer.from(parts.join(''));
  
  const body = Buffer.concat([textPrefix, prefix, fileBytes, suffix]);

  const resp = await fetch('https://apis.roblox.com/assets/v1/assets', {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'x-api-key': config.apiKey,
    },
    body,
  });

  const json = await resp.json();
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${JSON.stringify(json)}`);
  return json;
}

async function pollOp(opPath) {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const resp = await fetch(`https://apis.roblox.com/${opPath}`, {
      headers: { 'x-api-key': config.apiKey }
    });
    const json = await resp.json();
    if (json.done) return json;
    process.stdout.write('.');
  }
  throw new Error('Timeout');
}

async function main() {
  const uploads = [
    { file: path.join(__dirname, 'temp_titlebar.png'), name: 'DailyReward_TitleBar_v2', cacheKey: 'raster_60_1027' },
    { file: path.join(__dirname, 'temp_closebtn.png'), name: 'DailyReward_CloseBtn_v2', cacheKey: 'raster_60_1080' },
  ];

  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));

  for (const { file, name, cacheKey } of uploads) {
    console.log(`Uploading ${name} (${fs.statSync(file).size} bytes)...`);
    const op = await uploadImage(file, name);
    console.log(`  Operation: ${op.path}`);
    
    const result = await pollOp(op.path);
    if (result.response?.assetId) {
      console.log(`  ✅ ${cacheKey} → ${result.response.assetId}`);
      cache.entries[cacheKey] = { assetId: result.response.assetId, uploadedAt: new Date().toISOString() };
    } else {
      console.error(`  ❌ No assetId:`, JSON.stringify(result));
    }
  }

  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  console.log('✅ Cache saved');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
