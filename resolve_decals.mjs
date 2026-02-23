/**
 * FigmaForge Decal → Image ID Resolver
 * 
 * Resolves Roblox Decal asset IDs to their underlying Image texture IDs.
 * This is needed because:
 * - Open Cloud API uploads return Decal IDs (AssetType 13)
 * - ImageLabel.Image requires Image IDs (AssetType 1)
 * - There's no direct API to get Image ID from Decal ID without auth
 * 
 * Usage: node resolve_decals.mjs [--cookie ROBLOSECURITY_COOKIE]
 *   If no cookie, tries to read from ROBLOSECURITY env var.
 * 
 * Output: Updates .figmaforge-image-cache.json with resolved Image IDs
 *         and rewrites all .rbxmx files replacing rbxthumb:// with rbxassetid://
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CACHE_FILE = path.join(__dirname, '.figmaforge-image-cache.json');

// Parse args
let cookie = process.env.ROBLOSECURITY || '';
const cookieArgIdx = process.argv.indexOf('--cookie');
if (cookieArgIdx !== -1 && process.argv[cookieArgIdx + 1]) {
  cookie = process.argv[cookieArgIdx + 1];
}

// Collect all Decal IDs from .rbxmx files
function findDecalIds() {
  const rbxmxDir = path.join(PROJECT_ROOT, 'src');
  const ids = new Set();
  
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.rbxmx')) {
        const content = fs.readFileSync(full, 'utf-8');
        // Match both escaped and unescaped rbxthumb URLs
        const matches = content.matchAll(/rbxthumb:\/\/type=Asset[&;]amp;id=(\d+)/g);
        for (const m of matches) ids.add(m[1]);
        // Also match unescaped
        const unescaped = content.matchAll(/rbxthumb:\/\/type=Asset&id=(\d+)/g);
        for (const m of unescaped) ids.add(m[1]);
      }
    }
  }
  
  walk(rbxmxDir);
  return [...ids];
}

// Resolve a single Decal ID to its Image texture ID
async function resolveDecalId(decalId, authCookie) {
  const url = `https://assetdelivery.roblox.com/v1/asset/?id=${decalId}`;
  const headers = {};
  if (authCookie) {
    headers['Cookie'] = `.ROBLOSECURITY=${authCookie}`;
  }
  
  try {
    const resp = await fetch(url, { headers, redirect: 'follow' });
    if (!resp.ok) {
      console.error(`  ❌ ${decalId}: HTTP ${resp.status}`);
      return null;
    }
    
    const xml = await resp.text();
    // The XML contains <url>rbxassetid://IMAGE_ID</url> inside the Texture property
    const match = xml.match(/rbxassetid:\/\/(\d+)/);
    if (match) {
      return match[1];
    }
    console.error(`  ❌ ${decalId}: No rbxassetid found in XML`);
    return null;
  } catch (err) {
    console.error(`  ❌ ${decalId}: ${err.message}`);
    return null;
  }
}

// Replace rbxthumb URLs in all .rbxmx files with rbxassetid://IMAGE_ID
function rewriteRbxmxFiles(mapping) {
  const rbxmxDir = path.join(PROJECT_ROOT, 'src');
  let totalFixed = 0;
  
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.rbxmx')) {
        let content = fs.readFileSync(full, 'utf-8');
        let changed = false;
        
        for (const [decalId, imageId] of Object.entries(mapping)) {
          // Replace escaped rbxthumb URLs
          const escapedPattern = `rbxthumb://type=Asset&amp;id=${decalId}&amp;w=420&amp;h=420`;
          const unescapedPattern = `rbxthumb://type=Asset&id=${decalId}&w=420&h=420`;
          const replacement = `rbxassetid://${imageId}`;
          
          if (content.includes(escapedPattern)) {
            content = content.replaceAll(escapedPattern, replacement);
            changed = true;
          }
          if (content.includes(unescapedPattern)) {
            content = content.replaceAll(unescapedPattern, replacement);
            changed = true;
          }
        }
        
        if (changed) {
          fs.writeFileSync(full, content, 'utf-8');
          totalFixed++;
          console.log(`  ✅ Updated: ${path.relative(PROJECT_ROOT, full)}`);
        }
      }
    }
  }
  
  walk(rbxmxDir);
  return totalFixed;
}

// Main
async function main() {
  console.log('🔍 FigmaForge Decal → Image ID Resolver');
  console.log('========================================\n');
  
  // Find all Decal IDs
  const decalIds = findDecalIds();
  console.log(`Found ${decalIds.length} Decal IDs to resolve\n`);
  
  if (decalIds.length === 0) {
    console.log('No rbxthumb:// URLs found in .rbxmx files. Nothing to do.');
    return;
  }
  
  if (!cookie) {
    console.error('❌ No .ROBLOSECURITY cookie provided!');
    console.error('   Usage: node resolve_decals.mjs --cookie YOUR_COOKIE');
    console.error('   Or set ROBLOSECURITY env var');
    console.error('');
    console.error('   To get your cookie:');
    console.error('   1. Open roblox.com in your browser');
    console.error('   2. Open DevTools (F12) → Application → Cookies');
    console.error('   3. Copy the .ROBLOSECURITY cookie value');
    process.exit(1);
  }
  
  // Resolve each Decal ID
  console.log('Resolving Decal IDs to Image texture IDs...\n');
  const mapping = {};
  let resolved = 0;
  
  for (const decalId of decalIds) {
    const imageId = await resolveDecalId(decalId, cookie);
    if (imageId) {
      mapping[decalId] = imageId;
      resolved++;
      console.log(`  ✅ ${decalId} → rbxassetid://${imageId}`);
    }
  }
  
  console.log(`\nResolved ${resolved}/${decalIds.length} Decal IDs\n`);
  
  if (resolved === 0) {
    console.error('❌ Failed to resolve any IDs. Check your cookie.');
    process.exit(1);
  }
  
  // Rewrite .rbxmx files
  console.log('Rewriting .rbxmx files with real Image IDs...\n');
  const filesFixed = rewriteRbxmxFiles(mapping);
  console.log(`\n✅ Updated ${filesFixed} .rbxmx files`);
  
  // Save mapping for future reference
  const cacheFile = path.join(__dirname, '.decal-image-mapping.json');
  fs.writeFileSync(cacheFile, JSON.stringify(mapping, null, 2));
  console.log(`📋 Mapping saved to ${path.relative(PROJECT_ROOT, cacheFile)}`);
}

main().catch(console.error);
