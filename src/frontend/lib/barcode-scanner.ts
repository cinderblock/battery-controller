/**
 * Barcode scanner engine — runtime detection of available APIs.
 *
 * Strategy (in order of preference):
 * 1. Native BarcodeDetector API (Chrome Android, future Safari)
 * 2. zbar.wasm loaded from server at /static/zbar.wasm
 * 3. Manual text entry fallback (always available)
 *
 * The WASM binary is served as a static file from the server to avoid
 * npm bundling issues (zbar.wasm's npm package has Node.js-only imports
 * that break Bun's bundler).
 *
 * Camera access (getUserMedia) requires a secure context on most
 * browsers. Over plain HTTP, only localhost qualifies. On iOS over
 * HTTP to a LAN address, the camera will be unavailable — the UI
 * shows manual entry as the primary input in that case.
 */

// ── Capability detection ──────────────────────────────────────────

export function hasCameraAccess(): boolean {
  return !!navigator.mediaDevices?.getUserMedia;
}

export function hasNativeBarcodeDetector(): boolean {
  return 'BarcodeDetector' in window;
}

// ── Native BarcodeDetector ────────────────────────────────────────

async function scanWithNativeDetector(imageData: ImageData): Promise<string | null> {
  // @ts-expect-error — BarcodeDetector not in lib.dom.d.ts
  const detector = new window.BarcodeDetector({
    formats: ['code_128', 'ean_13', 'ean_8', 'qr_code'],
  });
  const results: { rawValue: string }[] = await detector.detect(imageData);
  return results.length > 0 ? results[0].rawValue : null;
}

// ── zbar.wasm self-hosted path ────────────────────────────────────

/**
 * Minimal zbar WASM scanner loaded from /static/zbar.wasm.
 *
 * Uses the Emscripten-generated glue code (zbar.js) served inline
 * and the WASM binary served as a static file. This avoids all npm
 * bundling issues while keeping the scanner self-hosted (no CDN).
 */

interface ZBarModule {
  _ImageScanner_create(): number;
  _ImageScanner_scan(scanner: number, image: number): number;
  _ImageScanner_get_results(scanner: number): number;
  _Image_create(width: number, height: number, format: number, data: number, dataLen: number, seqNum: number): number;
  _Image_destory(image: number): void; // sic — typo in zbar.wasm
  _Image_get_symbols(image: number): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
}

let zbarModule: ZBarModule | null = null;
let zbarLoadPromise: Promise<ZBarModule> | null = null;

async function loadZbar(): Promise<ZBarModule> {
  // Fetch the Emscripten glue JS and WASM binary from our server
  const [glueResponse] = await Promise.all([fetch('/static/zbar.js')]);

  if (!glueResponse.ok) {
    throw new Error(`Failed to load zbar.js: ${glueResponse.status}`);
  }

  const glueCode = await glueResponse.text();

  // The glue code defines a factory function. Evaluate it in a way
  // that captures the factory without polluting globals.
  const factory = new Function(`
    var module = { exports: {} };
    var exports = module.exports;
    var define = undefined; // prevent AMD detection
    ${glueCode}
    return module.exports;
  `)();

  // Call the Emscripten factory with locateFile pointing to our server
  const instance: ZBarModule = await factory({
    locateFile: (file: string) => {
      if (file === 'zbar.wasm') return '/static/zbar.wasm';
      return file;
    },
  });

  return instance;
}

function getZbar(): Promise<ZBarModule> {
  if (zbarModule) return Promise.resolve(zbarModule);
  if (!zbarLoadPromise) {
    zbarLoadPromise = loadZbar()
      .then(mod => {
        zbarModule = mod;
        return mod;
      })
      .catch(err => {
        zbarLoadPromise = null;
        throw err;
      });
  }
  return zbarLoadPromise;
}

// Y800 fourcc = 0x30303859 (grayscale 8-bit)
const Y800_FOURCC = 0x30303859;

/**
 * Convert RGBA ImageData to grayscale Y800 buffer.
 */
function rgbaToGray(imageData: ImageData): Uint8Array {
  const { data, width, height } = imageData;
  const gray = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    // ITU-R BT.601 luma
    gray[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }
  return gray;
}

/**
 * Read zbar symbol results from the result set pointer.
 *
 * Struct offsets derived from zbar.wasm's Symbol.js:
 * - SymbolSet: [refcnt, nsyms, head_ptr, tail_ptr]  (uint32 each)
 *     head_ptr at offset +2 (in uint32 units)
 * - Symbol: [type, configs, modifiers, data_len, (padding), data_ptr, ...]
 *     data_len at offset +4 (uint32), data_ptr at offset +5 (uint32)
 *     next at offset +11 (uint32)
 */
function readResults(mod: ZBarModule, resultsPtr: number): string[] {
  if (resultsPtr === 0) return [];

  const buf = mod.HEAPU8.buffer;
  const HEAPU32 = new Uint32Array(buf);
  const HEAP8 = new Int8Array(buf);

  // SymbolSet.head — pointer to first symbol in linked list
  const headPtr = HEAPU32[(resultsPtr >> 2) + 2];
  if (headPtr === 0) return [];

  const results: string[] = [];
  let symPtr = headPtr;
  let safety = 0;

  while (symPtr !== 0 && safety < 20) {
    const ptr32 = symPtr >> 2;

    // data_len at offset +4, data_ptr at offset +5
    const dataLen = HEAPU32[ptr32 + 4];
    const dataPtr = HEAPU32[ptr32 + 5];

    if (dataPtr !== 0 && dataLen > 0) {
      const bytes = Int8Array.from(HEAP8.subarray(dataPtr, dataPtr + dataLen));
      const text = new TextDecoder().decode(bytes);
      results.push(text);
    }

    // next symbol at offset +11
    symPtr = HEAPU32[ptr32 + 11];
    safety++;
  }

  return results;
}

let scannerPtr = 0;

async function scanWithZbar(imageData: ImageData): Promise<string | null> {
  const mod = await getZbar();

  if (scannerPtr === 0) {
    scannerPtr = mod._ImageScanner_create();
  }

  const gray = rgbaToGray(imageData);
  const { width, height } = imageData;

  // Allocate WASM memory for the image data
  const dataPtr = mod._malloc(gray.length);
  mod.HEAPU8.set(gray, dataPtr);

  // Create zbar image
  const imagePtr = mod._Image_create(
    width,
    height,
    Y800_FOURCC,
    dataPtr,
    gray.length,
    0 // sequence number
  );

  try {
    const count = mod._ImageScanner_scan(scannerPtr, imagePtr);
    if (count > 0) {
      const resultsPtr = mod._Image_get_symbols(imagePtr);
      const decoded = readResults(mod, resultsPtr);
      if (decoded.length > 0) return decoded[0];
    }
    return null;
  } finally {
    mod._Image_destory(imagePtr); // also frees the data buffer
  }
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Scan an ImageData for barcodes using the best available method.
 */
export async function scanImageData(imageData: ImageData): Promise<string | null> {
  if (hasNativeBarcodeDetector()) {
    return scanWithNativeDetector(imageData);
  }
  return scanWithZbar(imageData);
}
