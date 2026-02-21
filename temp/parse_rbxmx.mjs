import { readFileSync } from 'fs';
const xml = readFileSync('./DailyRewardModal.rbxmx', 'utf8');
const lines = xml.split('\n');
const nodeAssets = [];
lines.forEach((line, i) => {
  if (line.includes('rbxassetid://') && !line.includes('rbxasset://fonts')) {
    let name = 'unknown';
    for (let j = i-1; j >= Math.max(0, i-20); j--) {
      const m = lines[j].match(/<string name="Name">([^<]+)<\/string>/);
      if (m) { name = m[1]; break; }
    }
    const id = line.match(/rbxassetid:\/\/(\d+)/)?.[1];
    if (id) nodeAssets.push({ name, id });
  }
});
nodeAssets.forEach(r => console.log(r.name + ': rbxassetid://' + r.id));
