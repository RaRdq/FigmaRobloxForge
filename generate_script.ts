import { buildExtractionScript } from './figma-forge-extract';
import * as fs from 'fs';

const script = buildExtractionScript("31:13");
fs.writeFileSync('extraction_script.js', script);
console.log('Generated extraction_script.js');
