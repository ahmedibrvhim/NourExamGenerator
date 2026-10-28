// Copies the Tesseract OCR engine (worker + wasm core) into public/tesseract so the browser loads it from
// this site (works offline, no CDN). Runs automatically after `npm install`.
import { cpSync, mkdirSync, existsSync } from "node:fs";
const out = "public/tesseract";
mkdirSync(out, { recursive: true });
try {
  cpSync("node_modules/tesseract.js/dist/worker.min.js", `${out}/worker.min.js`);
  for (const f of ["tesseract-core-simd-lstm.wasm.js", "tesseract-core-lstm.wasm.js"]) {
    const src = `node_modules/tesseract.js-core/${f}`;
    if (existsSync(src)) cpSync(src, `${out}/${f}`);
  }
  console.log("OCR engine copied to public/tesseract");
} catch (e) {
  console.warn("setup-ocr: could not copy the OCR engine:", e.message);
}
