// SSXMOD fingerprint cookies for chat.qwen.ai anti-bot (WAF/baxia).
//
// Ported from UltraFEmotes/qwen3.8-api lib/ssxmod.ts (itself ported from
// angyedz/QwenFreeApi). Alibaba treats ssxmod_itna / ssxmod_itna2 as a device
// fingerprint: 37 fields → LZW → custom base64 → "1-<encoded>". Without these
// cookies, direct (non-browser) requests to chat.qwen.ai frequently return
// FAIL_SYS_USER_VALIDATE / captcha HTML instead of a real completion.
//
// This module lets the proxy talk to Qwen over plain node fetch — no Puppeteer —
// with the browser kept as fallback when the WAF still challenges.

import { randomUUID } from "node:crypto";

// --- fingerprint (37 fields, '^'-joined) ------------------------------------

const DEFAULT_TEMPLATE = {
  deviceId: "84985177a19a010dea49",
  sdkVersion: "websdk-2.3.15d",
  initTimestamp: "1765348410850",
  field3: "91",
  field4: "1|15",
  language: "zh-CN",
  timezoneOffset: "-480",
  colorDepth: "16705151|12791",
  screenInfo: "1920|1080|283|1080|158|0|1920|1080|1920|922|0|0",
  field9: "5",
  platform: "Win32",
  field11: "10",
  webglRenderer:
    "ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)|Google Inc. (NVIDIA)",
  field13: "30|30",
  field14: "0",
  field15: "28",
  pluginCount: "5",
  vendor: "Google Inc.",
  field29: "8",
  touchInfo: "-1|0|0|0|0",
  field32: "11",
  field35: "0",
  mode: "P",
};

const generateHash = () => Math.floor(Math.random() * 4294967296);

function generateFingerprint() {
  const config = { ...DEFAULT_TEMPLATE };
  const deviceId = Array.from({ length: 20 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join("");
  const currentTimestamp = Date.now();

  const fields = [
    deviceId,                      // 0
    config.sdkVersion,             // 1
    config.initTimestamp,          // 2
    config.field3,                 // 3
    config.field4,                 // 4
    config.language,               // 5
    config.timezoneOffset,         // 6
    config.colorDepth,             // 7
    config.screenInfo,             // 8
    config.field9,                 // 9
    config.platform,               // 10
    config.field11,                // 11
    config.webglRenderer,          // 12
    config.field13,                // 13
    config.field14,                // 14
    config.field15,                // 15
    `${config.pluginCount}|${generateHash()}`, // 16 plugins hash
    generateHash(),                // 17 canvas
    generateHash(),                // 18 ua hash1
    "1",                           // 19
    "0",                           // 20
    "1",                           // 21
    "0",                           // 22
    config.mode,                   // 23
    "0",                           // 24
    "0",                           // 25
    "0",                           // 26
    "416",                         // 27
    config.vendor,                 // 28
    config.field29,                // 29
    config.touchInfo,              // 30
    generateHash(),                // 31 ua hash2
    config.field32,                // 32
    currentTimestamp,              // 33
    generateHash(),                // 34 url hash
    config.field35,                // 35
    Math.floor(Math.random() * 91) + 10, // 36 doc hash
  ];

  return fields.join("^");
}

// --- LZW + custom base64 (SSXMOD encoding) ----------------------------------

const CUSTOM_BASE64_CHARS = "DGi0YA7BemWnQjCl4_bR3f8SKIF9tUz/xhr2oEOgPpac=61ZqwTudLkM5vHyNXsVJ";

function lzwCompress(data, bits, charFunc) {
  if (data == null) return "";

  const dict = {};
  const dictToCreate = {};
  let w = "";
  let enlargeIn = 2;
  let dictSize = 3;
  let numBits = 2;
  const result = [];
  let value = 0;
  let position = 0;

  const pushBits = (bitCount, fill) => {
    for (let j = 0; j < bitCount; j++) {
      value = (value << 1) | (fill & 1);
      if (position === bits - 1) {
        position = 0;
        result.push(charFunc(value));
        value = 0;
      } else {
        position++;
      }
      fill >>= 1;
    }
  };

  for (let i = 0; i < data.length; i++) {
    const c = data.charAt(i);
    if (!Object.prototype.hasOwnProperty.call(dict, c)) {
      dict[c] = dictSize++;
      dictToCreate[c] = true;
    }

    const wc = w + c;
    if (Object.prototype.hasOwnProperty.call(dict, wc)) {
      w = wc;
    } else {
      if (Object.prototype.hasOwnProperty.call(dictToCreate, w)) {
        if (w.charCodeAt(0) < 256) {
          pushBits(numBits, 0);
          pushBits(8, w.charCodeAt(0));
        } else {
          pushBits(numBits, 1);
          pushBits(16, w.charCodeAt(0));
        }
        enlargeIn--;
        if (enlargeIn === 0) {
          enlargeIn = Math.pow(2, numBits);
          numBits++;
        }
        delete dictToCreate[w];
      } else {
        pushBits(numBits, dict[w]);
      }

      enlargeIn--;
      if (enlargeIn === 0) {
        enlargeIn = Math.pow(2, numBits);
        numBits++;
      }

      dict[wc] = dictSize++;
      w = String(c);
    }
  }

  if (w !== "") {
    if (Object.prototype.hasOwnProperty.call(dictToCreate, w)) {
      if (w.charCodeAt(0) < 256) {
        pushBits(numBits, 0);
        pushBits(8, w.charCodeAt(0));
      } else {
        pushBits(numBits, 1);
        pushBits(16, w.charCodeAt(0));
      }
      enlargeIn--;
      if (enlargeIn === 0) {
        enlargeIn = Math.pow(2, numBits);
        numBits++;
      }
      delete dictToCreate[w];
    } else {
      pushBits(numBits, dict[w]);
    }
    enlargeIn--;
    if (enlargeIn === 0) {
      enlargeIn = Math.pow(2, numBits);
      numBits++;
    }
  }

  // End of stream
  pushBits(numBits, 2);
  while (true) {
    value = value << 1;
    if (position === bits - 1) {
      result.push(charFunc(value));
      break;
    }
    position++;
  }

  return result.join("");
}

function customEncode(data) {
  if (data == null) return "";
  const compressed = lzwCompress(data, 6, (index) => CUSTOM_BASE64_CHARS.charAt(index));
  switch (compressed.length % 4) {
    case 1: return compressed + "===";
    case 2: return compressed + "==";
    case 3: return compressed + "=";
    default: return compressed;
  }
}

/**
 * Mint a fresh ssxmod_itna / ssxmod_itna2 pair.
 * Returns { ssxmod_itna, ssxmod_itna2, timestamp, deviceId }.
 */
export function generateSsxmodCookies() {
  const fp = generateFingerprint();
  const fields = fp.split("^");

  // Hash positions are randomized per mint (upstream verifies structure, not content).
  fields[16] = `${fields[16].split("|")[0]}|${generateHash()}`;
  fields[17] = generateHash();
  fields[18] = generateHash();
  fields[31] = generateHash();
  fields[34] = generateHash();
  fields[36] = Math.floor(Math.random() * 91) + 10;
  fields[33] = Date.now();

  const itnaData = fields.join("^");
  const ssxmod_itna = "1-" + customEncode(itnaData);

  // itna2 is an 18-field subset of the full fingerprint.
  const itna2Data = [
    fields[0],   // deviceId
    fields[1],   // sdkVersion
    fields[23],  // mode
    0, "", 0, "", "", 0, 0, 0,
    fields[32],
    fields[33],  // timestamp
    0, 0, 0, 0, 0,
  ].join("^");
  const ssxmod_itna2 = "1-" + customEncode(itna2Data);

  return {
    ssxmod_itna,
    ssxmod_itna2,
    timestamp: parseInt(String(fields[33]), 10),
    deviceId: String(fields[0]),
  };
}

// --- manager (cached rotation every 15 min) ---------------------------------

const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

let current = null;

function refresh() {
  try {
    current = { ...generateSsxmodCookies(), at: Date.now() };
  } catch {
    // Keep the previous pair if minting fails — empty cookies are worse.
  }
}

function ensureFresh() {
  if (!current || Date.now() - current.at >= REFRESH_INTERVAL_MS) refresh();
}

/** Force a re-mint (e.g. after a WAF challenge on the direct path). */
export function rotateSsxmod() {
  refresh();
}

/**
 * Cookie header for direct fetches:
 *   token=<jwt>; ssxmod_itna=...; ssxmod_itna2=...
 */
export function buildDirectCookieHeader(token) {
  ensureFresh();
  const parts = [];
  if (token) parts.push(`token=${token}`);
  if (current?.ssxmod_itna) parts.push(`ssxmod_itna=${current.ssxmod_itna}`);
  if (current?.ssxmod_itna2) parts.push(`ssxmod_itna2=${current.ssxmod_itna2}`);
  return parts.join("; ");
}

// --- challenge detection ----------------------------------------------------
// Deciding "this response is a WAF block" wrongly is expensive: it throws the
// whole turn at the Puppeteer fallback, which is slow and can stream empty.

// Which signal fired, so a fallback is diagnosable from the log instead of
// guessing. Returns null when the response looks clean.
export function challengeMarker(status, bodyText) {
  if (status === 403 || status === 401) return `HTTP ${status}`;
  if (!bodyText) return null;
  const hit = bodyText.match(
    /access verification|verify that you are|captcha|risk|please complete the operation|FAIL_SYS_USER_VALIDATE|RGV587_ERROR/i
  );
  return hit ? hit[0] : null;
}

// Hard WAF markers only — no loose English words. Used where the body is
// legitimate model output rather than an error page.
function hardChallengeMarker(bodyText) {
  const hit = String(bodyText || "").match(/FAIL_SYS_USER_VALIDATE|RGV587_ERROR/);
  return hit ? hit[0] : null;
}

// A 200 event-stream IS the answer. Keyword-scanning it treats any reply that
// happens to contain "risk" or "captcha" as a WAF block and throws the whole
// turn at the browser fallback — which is where empty completions come from.
// Real mid-stream WAF frames carry FAIL_SYS_USER_VALIDATE, so the hard markers
// still apply (and the per-event check in the parse loop catches them too).
export function directChallengeMarker(res, bodyText) {
  if (res.status === 504) return "HTTP 504";
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/html")) return "text/html body";
  if (res.ok && ct.includes("event-stream")) return hardChallengeMarker(bodyText);
  return challengeMarker(res.status, bodyText || "");
}
