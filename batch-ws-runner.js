// batch-ws-runner.js — Runs all batch scripts via Figma Desktop Bridge WebSocket
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const BATCH_DIR = path.resolve(__dirname, '../../temp/figmaforge');
const PORT = parseInt(process.argv[2] || '9224');

function executeCode(ws, code, timeout = 28000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('execution timeout')), timeout + 10000);
    
    const handler = (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.result !== undefined || msg.error) {
          clearTimeout(timer);
          ws.removeListener('message', handler);
          resolve(msg);
        }
      } catch (e) {}
    };
    ws.on('message', handler);
    
    ws.send(JSON.stringify({
      id: 'b_' + Date.now(),
      type: 'execute',
      code: code,
      timeout: timeout,
    }));
  });
}

async function connectWS(port) {
  const urls = [`ws://[::1]:${port}`, `ws://127.0.0.1:${port}`, `ws://localhost:${port}`];
  for (const url of urls) {
    console.log(`Trying ${url}...`);
    try {
      const ws = await new Promise((resolve, reject) => {
        const w = new WebSocket(url);
        const timer = setTimeout(() => { w.close(); reject(new Error('timeout')); }, 3000);
        w.on('open', () => { clearTimeout(timer); console.log('Connected!'); resolve(w); });
        w.on('error', (e) => { clearTimeout(timer); reject(e); });
      });
      return ws;
    } catch(e) { console.log(`  Failed: ${e.message}`); }
  }
  throw new Error('Could not connect to Figma Bridge on any address');
}

async function main() {
  const scripts = [];
  for (let i = 0; i <= 99; i++) {
    const p = path.join(BATCH_DIR, `batch_script_${i}.js`);
    if (fs.existsSync(p)) scripts.push({ idx: i, path: p });
  }
  console.log(`Found ${scripts.length} batch scripts`);
  if (scripts.length === 0) return;

  const ws = await connectWS(PORT);
  
  // Listen for protocol messages
  ws.on('message', (raw) => {
    const s = raw.toString();
    if (s.length < 500) console.log('  [ws]', s.substring(0, 200));
  });
  
  await new Promise(r => setTimeout(r, 1000));
  
  let totalImages = 0;
  
  for (const script of scripts) {
    const code = fs.readFileSync(script.path, 'utf8');
    process.stdout.write(`Batch ${script.idx}: ${code.length} chars... `);
    
    try {
      const result = await executeCode(ws, code, 28000);
      const resultPath = path.join(BATCH_DIR, `batch_result_${script.idx}.json`);
      fs.writeFileSync(resultPath, JSON.stringify(result));
      
      const data = result.result || result;
      const count = data.exportedImages ? Object.keys(data.exportedImages).length : 0;
      totalImages += count;
      console.log(`✅ ${count} images (total: ${totalImages})`);
    } catch (e) {
      console.log(`❌ ${e.message}`);
    }
  }

  ws.close();
  console.log(`\nDone! ${totalImages} images. Now run:  cd temp/figmaforge && node batch_merge.js`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
