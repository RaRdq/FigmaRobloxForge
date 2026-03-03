// Run all batches through Figma Desktop Bridge WebSocket
// Usage: node run_figma_batches.js <maxBatchIndex>
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const TEMP_DIR = path.resolve(__dirname, '../../temp/figmaforge');
const PORT = 9225;
const EXEC_TIMEOUT = 28000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function execInFigma(ws, code) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error('Timeout'));
    }, EXEC_TIMEOUT + 5000);

    function handler(raw) {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      // The bridge returns messages with type 'eval-result' or includes a 'result' key
      if (msg.type === 'eval-result' || msg.result !== undefined || msg.success !== undefined) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    }
    ws.on('message', handler);

    // Send as eval command (Desktop Bridge protocol)
    ws.send(JSON.stringify({
      type: 'eval',
      code: code,
      timeout: EXEC_TIMEOUT
    }));
  });
}

async function main() {
  const maxBatch = parseInt(process.argv[2] || '14');
  
  const batchFiles = fs.readdirSync(TEMP_DIR)
    .filter(f => /^batch_script_\d+\.js$/.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]))
    .filter(f => parseInt(f.match(/\d+/)[0]) <= maxBatch);

  console.log(`[AutoBatch] ${batchFiles.length} scripts (0..${maxBatch}), port ${PORT}`);

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise((ok, fail) => {
    ws.once('open', ok);
    ws.once('error', fail);
    setTimeout(() => fail(new Error('WS connect timeout')), 5000);
  });
  console.log('[AutoBatch] Connected to Figma Bridge');

  // Drain any initial messages
  await sleep(1000);

  let successCount = 0;
  for (const file of batchFiles) {
    const idx = parseInt(file.match(/\d+/)[0]);
    const code = fs.readFileSync(path.join(TEMP_DIR, file), 'utf8');
    const outPath = path.join(TEMP_DIR, `batch_result_${idx}.json`);
    
    process.stdout.write(`  [${idx}/${maxBatch}] ${file}...`);
    const t0 = Date.now();
    
    try {
      const resp = await execInFigma(ws, code);
      const data = resp.result || resp;
      fs.writeFileSync(outPath, JSON.stringify(data));
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      const cnt = data.exportedCount || (data.exportedImages ? Object.keys(data.exportedImages).length : '?');
      console.log(` ✅ ${sec}s (${cnt} imgs)`);
      successCount++;
    } catch (err) {
      console.log(` ❌ ${err.message}`);
      fs.writeFileSync(outPath, JSON.stringify({ batchIndex: idx, exportedImages: {}, notFound: [err.message] }));
    }
    
    await sleep(300);
  }

  ws.close();
  console.log(`\n[AutoBatch] Done: ${successCount}/${batchFiles.length} succeeded`);
}

main().catch(e => { console.error(e); process.exit(1); });
