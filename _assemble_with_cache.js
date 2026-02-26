/**
 * Standalone assembler that injects cached image asset IDs into manifest nodes.
 * 
 * Root cause: Manifest nodes use `_imageKey` (set by turbo extract),
 * but resolveImages/backfillRasterHashes look for `_rasterizedImageHash` 
 * and match by node `id` (which is empty in turbo-extracted manifests).
 * 
 * Fix: Walk tree, match _imageKey to cache entries, set _resolvedImageId.
 */
const fs = require('fs');
const path = require('path');

const MANIFEST_PATH = path.join(__dirname, 'manifest_DailyReward_v2.json');
const CACHE_PATH = path.join(__dirname, 'dist', '.figmaforge-image-cache.json');
const OUTPUT_PATH = path.resolve(__dirname, '..', '..', 'src', 'ReplicatedStorage', 'DailyRewardModal.rbxmx');

// Load manifest & cache
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
console.log(`Manifest: ${manifest.unresolvedImages.length} unresolved images`);
console.log(`Cache: ${Object.keys(cache.entries).length} entries`);

// Build hash→assetId lookup
const hashToAssetId = {};
for (const [hash, entry] of Object.entries(cache.entries)) {
  hashToAssetId[hash] = entry.assetId;
}

// Walk tree and inject _resolvedImageId using _imageKey
let matched = 0;
function injectImageIds(node) {
  // Match by _imageKey (turbo extract sets this)
  if (node._imageKey && hashToAssetId[node._imageKey]) {
    node._resolvedImageId = `rbxassetid://${hashToAssetId[node._imageKey]}`;
    // Also set _rasterizedImageHash so classifyNode sees it as rasterized
    node._rasterizedImageHash = node._imageKey;
    matched++;
    console.log(`  ✅ ${node.name} (_imageKey=${node._imageKey}) → ${node._resolvedImageId}`);
  }
  
  // Match by IMAGE fills (for non-turbo extracted nodes)
  if (!node._resolvedImageId && node.fills) {
    const imgFill = node.fills.find(f => f.type === 'IMAGE' && f.imageHash);
    if (imgFill && hashToAssetId[imgFill.imageHash]) {
      node._resolvedImageId = `rbxassetid://${hashToAssetId[imgFill.imageHash]}`;
      node._rasterizedImageHash = imgFill.imageHash;
      matched++;
      console.log(`  ✅ ${node.name} (fill hash) → ${node._resolvedImageId}`);
    }
  }
  
  if (node.children) {
    for (const child of node.children) injectImageIds(child);
  }
}

injectImageIds(manifest.root);
console.log(`\nMatched: ${matched} nodes with _resolvedImageId`);

// Post-process: strip text children from nodes with baked images
// Two sources: (1) _isFlatten flag from turbo extract, (2) explicit list for
// nodes baked AFTER manifest generation (e.g. CloseBtn ✕ renamed in Figma)
const BAKED_NODES = ['CloseBtn']; // nodes whose text was baked post-manifest
function stripBakedTextChildren(node) {
  const isBaked = node._isFlatten 
    || (node.name && node.name.includes('[Flatten]'))
    || BAKED_NODES.includes(node.name);
  if (isBaked && node._resolvedImageId && node.children) {
    const before = node.children.length;
    node.children = node.children.filter(c => c.type !== 'TEXT');
    if (node.children.length < before) {
      console.log(`  🗑️ Stripped ${before - node.children.length} baked text from: ${node.name}`);
    }
  }
  if (node.children) {
    for (const child of node.children) stripBakedTextChildren(child);
  }
}
stripBakedTextChildren(manifest.root);

// Post-process: make ClaimedOverlay use full-parent scale sizing
// so it covers the card completely regardless of card size
function fixOverlaySizing(node) {
  if (node.name === 'ClaimedOverlay') {
    node.x = 0; node.y = 0;
    node._useScaleSize = true; // flag for assembler
  }
  if (node.children) {
    for (const child of node.children) fixOverlaySizing(child);
  }
}
fixOverlaySizing(manifest.root);

// Also mark manifest images as resolved so assembler doesn't complain  
manifest.unresolvedImages = [];

// Import and call assembler with proper config
const { assembleRbxmx } = require('./dist/figma-forge-assemble');
const { compileConfig } = require('./dist/figma-forge-shared');

// Build config matching CLI defaults
const config = compileConfig({
  textExport: 'all',
  defaultFont: 'BuilderSans',
  defaultFontWeight: 400,
  interactivePatterns: ['.*Button.*', '.*Btn.*', '.*Toggle.*', '.*Checkbox.*', '.*Switch.*'],
});

const rbxmx = assembleRbxmx(manifest, config);

// Verify
const assetIdMatches = rbxmx.match(/rbxassetid:\/\/\d+/g) || [];
const imageLabels = (rbxmx.match(/ImageLabel/g) || []).length;
console.log(`\nAssembled: ${rbxmx.length} chars, ${assetIdMatches.length} rbxassetid:// URLs, ${imageLabels} ImageLabel refs`);

if (assetIdMatches.length === 0 && imageLabels > 0) {
  console.error('⚠️ WARNING: ImageLabels exist but 0 rbxassetid — images will be broken!');
}

// Strip [Flatten] from names
let output = rbxmx.replace(/\[Flatten\]\s*/g, '');
const flattenRemoved = (rbxmx.match(/\[Flatten\]/g) || []).length;
console.log(`Stripped ${flattenRemoved} [Flatten] tags`);

// Post-process: fix ClaimedOverlay to use full-parent scale sizing  
// so it covers day cards completely (pixel sizing can leave gaps)
const overlayFixRegex = /(<string name="Name">ClaimedOverlay<\/string>[\s\S]*?<UDim2 name="Size">)<XS>0<\/XS><XO>\d+<\/XO><YS>0<\/YS><YO>\d+<\/YO>/g;
const overlayFixes = (output.match(overlayFixRegex) || []).length;
output = output.replace(overlayFixRegex, '$1<XS>1</XS><XO>0</XO><YS>1</YS><YO>0</YO>');
console.log(`Fixed ${overlayFixes} ClaimedOverlay sizing → Scale {1,0},{1,0}`);

fs.writeFileSync(OUTPUT_PATH, output);
console.log(`\n✅ Written: ${OUTPUT_PATH} (${output.length} chars)`);

