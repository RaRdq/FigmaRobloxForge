// Upload CloseBtn PNG only (TitleBar already done)
const fs = require('fs');
const path = require('path');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'roblox-config.json'), 'utf-8'));
const CACHE_PATH = path.join(__dirname, 'dist', '.figmaforge-image-cache.json');

async function upload(filePath, name) {
  const boundary = '----FB' + Math.random().toString(36).slice(2);
  const fileBytes = fs.readFileSync(filePath);
  const reqJson = JSON.stringify({ assetType: 'Image', displayName: name, description: 'FigmaForge export', creationContext: { creator: { userId: config.creatorId } } });
  const prefix = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n' + reqJson + '\r\n--' + boundary + '\r\nContent-Disposition: form-data; name="fileContent"; filename="close.png"\r\nContent-Type: image/png\r\n\r\n');
  const suffix = Buffer.from('\r\n--' + boundary + '--\r\n');
  const body = Buffer.concat([prefix, fileBytes, suffix]);
  const resp = await fetch('https://apis.roblox.com/assets/v1/assets', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'x-api-key': config.apiKey }, body });
  const json = await resp.json();
  if (!resp.ok) throw new Error(JSON.stringify(json));
  return json;
}

async function poll(opPath) {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const r = await fetch('https://apis.roblox.com/' + opPath, { headers: { 'x-api-key': config.apiKey } });
    const j = await r.json();
    if (j.done) return j;
    process.stdout.write('.');
  }
  throw new Error('timeout');
}

(async () => {
  // Upload CloseBtn
  console.log('Uploading CloseBtn...');
  const op = await upload(path.join(__dirname, 'temp_closebtn.png'), 'DailyReward_CloseBtn_v2');
  console.log('Op:', op.path);
  const result = await poll(op.path);
  const assetId = result.response?.assetId;
  console.log('AssetId:', assetId);

  // Update cache with BOTH new assets
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
  cache.entries['raster_60_1027'] = { assetId: '104485731534469', uploadedAt: new Date().toISOString() };
  if (assetId) {
    cache.entries['raster_60_1080'] = { assetId, uploadedAt: new Date().toISOString() };
  }
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  console.log('Cache saved');
})();
