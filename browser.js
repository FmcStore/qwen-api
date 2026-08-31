// Browser-based fetch using Puppeteer + real Chrome.
//
// Alibaba's WAF (aliyun_waf / baxia) fingerprints TLS connections and blocks
// non-browser clients. This module launches a REAL Chrome instance, navigates
// to chat.qwen.ai (letting baxia.js fully initialize), then proxies all API
// calls through page.evaluate(fetch(...)) so the TLS fingerprint is genuine.
//
// The key insight: baxia.js must run and initialize. It sets up anti-bot
// cookies and headers that are checked server-side. Blocking JS = instant WAF.
// Letting the page load fully = clean session.
//
// Exports:
//   initBrowser(cookieStr, tokens)  -> launch Chrome, set cookies/token, wait for ready
//   browserFetch(url, opts)         -> non-streaming fetch via browser
//   browserFetchStream(url, opts, thinkEnabled, onChunk) -> streaming SSE via exposeFunction bridge
//   closeBrowser()                  -> shut down

import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
puppeteer.use(StealthPlugin());

// Python captcha solver sidecar URL
const CAPTCHA_SOLVER_URL = process.env.CAPTCHA_SOLVER_URL || "http://127.0.0.1:5555";

// Captcha coordinate mapping constants (discovered from Aliyun slider analysis)
const DRAG_DEAD_ZONE = parseFloat(process.env.DRAG_DEAD_ZONE || "94");
const DRAG_RATIO = parseFloat(process.env.DRAG_RATIO || "1.54");

const CHROME_PATH = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const QWEN_BASE = "https://chat.qwen.ai";

let browser = null;
let ready = false;
let initArgs = null;

// Worker pool: each worker is an isolated BrowserContext + page with its own
// baxia/WAF state. QWEN_WORKERS controls the count (default 1 = legacy behavior:
// one page, requests serialized by the acquire queue).
const WORKER_COUNT = Math.max(1, Number(process.env.QWEN_WORKERS || 1));
const workers = [];        // { id, context, page, busy }
const waiters = [];        // FIFO of resolvers waiting for a free worker

function acquireWorker() {
  const free = workers.find((w) => !w.busy);
  if (free) {
    free.busy = true;
    return Promise.resolve(free);
  }
  return new Promise((resolve, reject) => {
    const waiter = () => {
      const w = workers.find((x) => !x.busy);
      if (!w) {
        // Spurious wake with capacity momentarily gone (two wakes racing one
        // free worker is benign): keep my place at the front of the queue.
        if (workers.length > 0) {
          waiters.unshift(waiter);
          return;
        }
        // Pool permanently empty — every recycle failed, so nothing will ever
        // release again. Reject instead of hanging this request forever.
        reject(new Error("worker pool exhausted (all recycles failed)"));
        return;
      }
      w.busy = true;
      resolve(w);
    };
    waiters.push(waiter);
  });
}

function releaseWorker(w) {
  if (!w) return;
  w.busy = false;
  wakeNextWaiter();
}

function wakeNextWaiter() {
  const next = waiters.shift();
  if (next) next();
}

// Parse "key=val; key2=val2" into Puppeteer setCookie objects.
function parseCookieString(cookieStr) {
  if (!cookieStr) return [];
  return cookieStr.split(";").map((pair) => {
    const eq = pair.indexOf("=");
    if (eq === -1) return null;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    return { name, value, domain: ".qwen.ai", path: "/" };
  }).filter(Boolean);
}

export async function initBrowser(cookieString, tokens) {
  if (browser) return;
  initArgs = { cookieString, tokens };

  console.log("[browser] Launching Chrome...");

  browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    // stealth plugin handles most fingerprint evasion automatically
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-translate",
      "--metrics-recording-only",
      "--mute-audio",
      // Important: don't use --disable-web-security, we WANT the real origin
    ],
    protocolTimeout: 1200000,
  });

  for (let i = 0; i < WORKER_COUNT; i++) {
    workers.push(await buildWorker(i));
  }

  // Background auto-solver: checks every worker page every 3s for captcha popups
  setInterval(async () => {
    if (!ready) return;
    for (const worker of workers) {
      const page = worker.page;
      if (!page || page._solvingCaptcha) continue;
      try {
        // 1. Check main page for new-style Aliyun popup slider
        const detected = await page.evaluate(() => {
          const slider = document.querySelector('#aliyunCaptcha-sliding-slider');
          if (slider) return 'aliyun_new';
          const nc = document.querySelector('#nc_1_n1z, .btn_slide, .nc-container');
          if (nc) return 'aliyun_old';
          return null;
        });

        if (detected === 'aliyun_new') {
          page._solvingCaptcha = true;
          console.log(`[browser w${worker.id}] Aliyun captcha detected in main page — solving...`);
          try {
            await solveCaptchaCV(page);
          } finally {
            page._solvingCaptcha = false;
          }
          continue;
        }

        // 2. Check ALL iframes for BOTH captcha types
        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          try {
            // Check for new-style puzzle captcha INSIDE iframe first
            const frameHasPuzzle = await frame.$('#aliyunCaptcha-sliding-slider, #aliyunCaptcha-img');
            if (frameHasPuzzle) {
              const puzzleBox = await frameHasPuzzle.boundingBox();
              if (puzzleBox && puzzleBox.width > 0) {
                page._solvingCaptcha = true;
                console.log(`[browser w${worker.id}] Aliyun puzzle captcha found in iframe — solving with CV...`);
                try {
                  // For iframe puzzles, we need to use the frame context
                  await solveCaptchaCVInFrame(page, frame);
                } finally {
                  page._solvingCaptcha = false;
                }
                break;
              }
            }

            // Check for old-style nc slider
            const slider = await frame.$('#nc_1_n1z, .btn_slide, .nc-container');
            if (slider) {
              const box = await slider.boundingBox();
              if (box && box.width > 0) {
                page._solvingCaptcha = true;
                console.log(`[browser w${worker.id}] Old-style slider detected in frame — solving with human sim...`);
                try {
                  await solveOldSliderWithRetry(page, frame);
                } finally {
                  page._solvingCaptcha = false;
                }
                break;
              }
            }
          } catch { /* frame may have navigated away */ }
        }
      } catch (e) { /* silent */ }
    }
  }, 3000).unref();

  ready = true;
  // Probe the CV sidecar once and report the truth: this line used to claim
  // "+ CV solver" unconditionally, which was false whenever 5555 was down.
  // Without CV the simple slider still solves heuristically (DRAG_DEAD_ZONE /
  // DRAG_RATIO); only the puzzle captcha (see the NC-upgrade path below) needs it.
  const cvUp = await fetch(CAPTCHA_SOLVER_URL + "/solve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(1500),
  }).then(() => true, () => false);
  const workerNote = `${workers.length} worker${workers.length > 1 ? "s" : ""}`;
  if (cvUp) {
    console.log(`[browser] Chrome ready with stealth + CV solver (${workerNote}).`);
  } else {
    console.warn(
      `[browser] Chrome ready with stealth, NO CV solver at ${CAPTCHA_SOLVER_URL} (${workerNote}). ` +
      `Simple sliders still solve heuristically; puzzle captchas will fail.`
    );
  }
}

// Builds one fully-initialized worker (fresh BrowserContext + page + baxia state).
async function buildWorker(id) {
  const { cookieString, tokens } = initArgs || {};
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.__workerId = id;

  // Chunk callback ref — swapped per-request by browserFetchStream
  page.__chunkCallback = null;

  // Bridge: browser JS calls window.__onChunk(piece, phase) → Node.js callback
  // exposeFunction can only be called ONCE per name per page, so we register it
  // here and swap the backing callback per-request.
  await page.exposeFunction('__onChunk', (piece, phase, rawJSON) => {
    if (page.__chunkCallback) {
      page.__chunkCallback(piece, phase, rawJSON);
    }
  });

  page.on('console', msg => {
    if (msg.text().includes('WAF_ABORT') || msg.text().includes('[browser') || msg.text().includes('CHUNK:')) {
      console.log(`${msg.text()}`);
    }
  });

  // stealth plugin handles UA — no manual override needed

  // Set viewport to look like a real desktop session
  await page.setViewport({ width: 1920, height: 1080 });

  // Inject cookies BEFORE navigation
  if (cookieString) {
    const cookies = parseCookieString(cookieString);
    if (cookies.length) {
      await page.setCookie(...cookies);
      console.log(`[browser w${id}] Set ${cookies.length} cookies for .qwen.ai`);
    }
  }

  // Navigate to chat.qwen.ai — let EVERYTHING load (JS, CSS, images).
  // baxia.js MUST execute to set up the anti-bot context.
  // networkidle0 = wait until there are 0 network connections for 500ms.
  console.log(`[browser w${id}] Navigating to chat.qwen.ai (full page load)...`);
  try {
    await page.goto(QWEN_BASE, { waitUntil: "networkidle0", timeout: 45000 });
  } catch (e) {
    // Timeout on networkidle0 is common (SSE connections stay open).
    // Fall back to domcontentloaded which is sufficient.
    console.warn(`[browser w${id}] networkidle0 timed out, that's fine: ${e.message}`);
    try {
      await page.goto(QWEN_BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (e2) {
      console.warn(`[browser w${id}] Navigation warning: ${e2.message}`);
    }
  }

  // Give baxia.js a moment to fully initialize
  await new Promise(r => setTimeout(r, 3000));

  // Set the auth token in localStorage (this is how the web app reads it).
  // Round-robin tokens across workers so parallel requests look like distinct users.
  if (tokens && tokens.length > 0) {
    const token = tokens[id % tokens.length];
    await page.evaluate((t) => {
      try { localStorage.setItem("token", t); } catch {}
    }, token);
    console.log(`[browser w${id}] Set token in localStorage`);
  }

  // Check if we landed on a captcha page or a normal page
  const pageTitle = await page.title().catch(() => "");
  const pageUrl = page.url();
  console.log(`[browser w${id}] Page loaded: "${pageTitle}" at ${pageUrl}`);

  // Check for Aliyun slider captcha — both old-style (#nc_1_n1z) and new-style (#aliyunCaptcha-sliding-slider)
  const hasCaptcha = await page.evaluate(() => {
    return !!(
      document.querySelector("#aliyunCaptcha-sliding-slider") ||
      document.querySelector("#nc_1_n1z") ||
      document.querySelector(".nc-container") ||
      document.querySelector("[id*='baxia']") ||
      document.querySelector(".aliyun-sec") ||
      document.querySelector("iframe[src*='captcha']")
    );
  });

  if (hasCaptcha) {
    console.log(`[browser w${id}] Initial captcha detected — attempting CV solve...`);
    await solveCaptchaCV(page);
  }

  return { id, context, page, busy: false };
}

// Replace a poisoned worker with a fresh one. Poison signature: the WAF
// navigates the tab off-origin, after which same-origin page.fetch() dies with
// "Failed to fetch", or streams complete with zero chunks. The dead worker
// stays busy (invisible to acquirers) until the fresh one is fully initialized.
// ponytail: if re-init fails, the pool permanently shrinks by one until
// restart — deliberate, prevents recycle storms against a blocked IP.
async function recycleWorker(worker) {
  console.warn(`[browser w${worker.id}] Recycling poisoned worker (fresh context)...`);
  try { await worker.context.close(); } catch {}
  const idx = workers.indexOf(worker);
  if (idx === -1) return;
  try {
    workers[idx] = await buildWorker(worker.id);
    console.log(`[browser w${worker.id}] Worker recycled.`);
  } catch (e) {
    console.error(`[browser w${worker.id}] Recycle failed (${e.message}) — pool shrinks to ${workers.length - 1}`);
    workers.splice(idx, 1);
  }
  wakeNextWaiter();
}

// ---------------------------------------------------------------------------
// Bézier curve mouse movement — looks human, not robotic
// ---------------------------------------------------------------------------

function generateBezierPath(startX, startY, endX, endY, numPoints = null) {
  if (!numPoints) numPoints = 25 + Math.floor(Math.random() * 20);

  const cx1 = startX + (endX - startX) * (0.2 + Math.random() * 0.2) + (Math.random() * 60 - 30);
  const cy1 = startY + (endY - startY) * (0.2 + Math.random() * 0.2) + (Math.random() * 40 - 20);
  const cx2 = startX + (endX - startX) * (0.6 + Math.random() * 0.2) + (Math.random() * 60 - 30);
  const cy2 = startY + (endY - startY) * (0.6 + Math.random() * 0.2) + (Math.random() * 40 - 20);

  const points = [];
  for (let i = 0; i <= numPoints; i++) {
    const t = i / numPoints;
    const eased = t * t * (3 - 2 * t);
    const x = Math.pow(1 - eased, 3) * startX
            + 3 * Math.pow(1 - eased, 2) * eased * cx1
            + 3 * (1 - eased) * Math.pow(eased, 2) * cx2
            + Math.pow(eased, 3) * endX
            + (Math.random() - 0.5);
    const y = Math.pow(1 - eased, 3) * startY
            + 3 * Math.pow(1 - eased, 2) * eased * cy1
            + 3 * (1 - eased) * Math.pow(eased, 2) * cy2
            + Math.pow(eased, 3) * endY
            + (Math.random() - 0.5);
    points.push({ x, y });
  }
  return points;
}

async function humanMove(pg, startX, startY, endX, endY) {
  const points = generateBezierPath(startX, startY, endX, endY);
  const baseDuration = 0.3 + Math.random() * 0.5;
  const stepTime = baseDuration / points.length;

  for (let i = 0; i < points.length; i++) {
    const t = i / points.length;
    let delay;
    if (t < 0.15) delay = stepTime * (1.5 + Math.random());
    else if (t < 0.85) delay = stepTime * (0.5 + Math.random() * 0.3);
    else delay = stepTime * (1.2 + Math.random() * 0.8);

    if (Math.random() < 0.01 && t > 0.2 && t < 0.8) {
      await new Promise(r => setTimeout(r, 20 + Math.random() * 60));
    }

    await pg.mouse.move(points[i].x, points[i].y);
    await new Promise(r => setTimeout(r, delay * 1000));
  }

  for (let j = 0; j < 2 + Math.floor(Math.random() * 3); j++) {
    await pg.mouse.move(endX + (Math.random() * 3 - 1.5), endY + (Math.random() * 3 - 1.5));
    await new Promise(r => setTimeout(r, 10 + Math.random() * 20));
  }
  await pg.mouse.move(endX, endY);
}

// ---------------------------------------------------------------------------
// CV-based captcha solver — calls Python sidecar for distance
// ---------------------------------------------------------------------------

async function callCaptchaSolver(captchaData) {
  try {
    const resp = await fetch(CAPTCHA_SOLVER_URL + '/solve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(captchaData),
      signal: AbortSignal.timeout(15000),
    });
    return await resp.json();
  } catch (e) {
    console.warn(`[browser] Captcha sidecar error: ${e.message}`);
    return null;
  }
}

async function solveCaptchaCV(pg, maxAttempts = 10) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`[browser w${pg.__workerId}] CV solve attempt ${attempt}/${maxAttempts}`);

    try {
      await pg.waitForSelector('#aliyunCaptcha-sliding-slider', { visible: true, timeout: 5000 });
    } catch {
      console.warn('[browser] Slider not found — captcha may have cleared');
      return true;
    }

    const imagesReady = await pg.evaluate(() => {
      const bg = document.querySelector('#aliyunCaptcha-img');
      const puzzle = document.querySelector('#aliyunCaptcha-puzzle');
      return !!(bg && puzzle && bg.naturalWidth > 50 && puzzle.naturalWidth > 10);
    });

    if (!imagesReady) {
      console.warn('[browser] Captcha images not loaded — waiting...');
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }

    const captchaData = await pg.evaluate(async () => {
      const bg = document.querySelector('#aliyunCaptcha-img');
      const puzzle = document.querySelector('#aliyunCaptcha-puzzle');
      if (!bg || !puzzle || !bg.src || !puzzle.src) return null;

      const bgRect = bg.getBoundingClientRect();
      const puzzleRect = puzzle.getBoundingClientRect();

      const fetchImage = async (url) => {
        if (url.startsWith('data:image')) return url;
        try {
          const resp = await fetch(url);
          const blob = await resp.blob();
          return await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(blob);
          });
        } catch { return null; }
      };

      const bg_b64 = await fetchImage(bg.src);
      const puzzle_b64 = await fetchImage(puzzle.src);
      if (!bg_b64 || !puzzle_b64) return null;

      return {
        bg_b64,
        puzzle_b64,
        bg_css_width: bgRect.width,
        bg_natural_width: bg.naturalWidth || bg.width || 300,
        puzzle_css_width: puzzleRect.width,
        puzzle_natural_width: puzzle.naturalWidth || puzzle.width || 60,
        puzzle_left_css: puzzleRect.left - bgRect.left,
      };
    });

    if (!captchaData) {
      console.warn('[browser] Failed to extract captcha data');
      continue;
    }

    const solverResult = await callCaptchaSolver(captchaData);
    if (!solverResult || solverResult.error === 'All methods failed' || !solverResult.distance) {
      console.warn('[browser] CV solver returned no distance — refreshing captcha');
      await clickRefreshButton(pg);
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }

    if (solverResult.spread > 30 && solverResult.confidence < 0.4) {
      console.warn(`[browser] Low confidence (${solverResult.confidence}, spread=${solverResult.spread}) — refreshing`);
      await clickRefreshButton(pg);
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }

    console.log(`[browser] CV distance: ${solverResult.distance}px (conf=${solverResult.confidence}, methods=${JSON.stringify(solverResult.methods)})`);

    const targetPx = Math.max(30, Math.min(350, solverResult.distance + (Math.random() - 0.5)));
    const mouseDistance = Math.round(targetPx / DRAG_RATIO + DRAG_DEAD_ZONE);
    console.log(`[browser] Target=${targetPx}px → mouse=${mouseDistance}px (ratio=${DRAG_RATIO}, deadzone=${DRAG_DEAD_ZONE})`);

    const sliderBox = await pg.evaluate(() => {
      const el = document.querySelector('#aliyunCaptcha-sliding-slider');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    if (!sliderBox) continue;

    const sliderCX = sliderBox.x + sliderBox.width / 2;
    const sliderCY = sliderBox.y + sliderBox.height / 2;

    // Human scan of image before dragging
    const bgBox = await pg.evaluate(() => {
      const bg = document.querySelector('#aliyunCaptcha-img');
      if (!bg) return null;
      const r = bg.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    if (bgBox) {
      await humanMove(
        pg,
        bgBox.x + bgBox.width * (0.15 + Math.random() * 0.2),
        bgBox.y + bgBox.height * (0.2 + Math.random() * 0.2),
        bgBox.x + bgBox.width * (0.6 + Math.random() * 0.25),
        bgBox.y + bgBox.height * (0.45 + Math.random() * 0.2)
      );
      await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
    }

    await humanMove(
      pg,
      pg.__lastX || 640, pg.__lastY || 360,
      sliderCX, sliderCY
    );
    await new Promise(r => setTimeout(r, 150 + Math.random() * 150));

    const pieceBefore = await pg.evaluate(() => {
      const p = document.querySelector('#aliyunCaptcha-puzzle');
      return p ? p.getBoundingClientRect().x : null;
    });

    await pg.mouse.move(sliderCX, sliderCY);
    await pg.mouse.down();
    await new Promise(r => setTimeout(r, 150 + Math.random() * 100));

    // Overshoot/undershoot/exact
    let actualMoveDistance = mouseDistance;
    let correctionType = 'none';
    const roll = Math.random();
    if (roll < 0.70) {
      actualMoveDistance = mouseDistance + 3 + Math.random() * 6;
      correctionType = 'pullback';
    } else if (roll < 0.90) {
      actualMoveDistance = mouseDistance - 2 - Math.random() * 4;
      correctionType = 'creep';
    }

    const endX = sliderCX + actualMoveDistance;
    const endY = sliderCY + (Math.random() * 4 - 2);
    const dragSteps = 25 + Math.floor(Math.random() * 15);
    const totalDragTime = 0.4 + Math.random() * 0.3;

    for (let i = 0; i <= dragSteps; i++) {
      const t = i / dragSteps;
      const eased = 1 - Math.pow(1 - t, 3);
      const x = sliderCX + (endX - sliderCX) * eased;
      const y = sliderCY + (endY - sliderCY) * eased + Math.sin(t * Math.PI) * (Math.random() * 3 - 1.5);
      await pg.mouse.move(x, y);
      await new Promise(r => setTimeout(r, (totalDragTime / dragSteps) * 1000 * (0.8 + Math.random() * 0.4)));
    }

    if (correctionType === 'pullback') {
      const overshoot = actualMoveDistance - mouseDistance;
      const corrSteps = 10 + Math.floor(Math.random() * 8);
      for (let i = 1; i <= corrSteps; i++) {
        const t = i / corrSteps;
        const eased = t * t * (3 - 2 * t);
        await pg.mouse.move(sliderCX + actualMoveDistance - overshoot * eased, sliderCY + (Math.random() * 0.8 - 0.4));
        await new Promise(r => setTimeout(r, 20 + Math.random() * 30));
      }
    } else if (correctionType === 'creep') {
      const undershoot = mouseDistance - actualMoveDistance;
      const corrSteps = 8 + Math.floor(Math.random() * 6);
      for (let i = 1; i <= corrSteps; i++) {
        const t = i / corrSteps;
        const eased = t * t * (3 - 2 * t);
        await pg.mouse.move(sliderCX + actualMoveDistance + undershoot * eased, sliderCY + (Math.random() * 0.8 - 0.4));
        await new Promise(r => setTimeout(r, 20 + Math.random() * 30));
      }
    }

    await new Promise(r => setTimeout(r, 100 + Math.random() * 100));

    // Post-drag nudge
    const pieceAfter = await pg.evaluate(() => {
      const p = document.querySelector('#aliyunCaptcha-puzzle');
      return p ? p.getBoundingClientRect().x : null;
    });
    if (pieceAfter !== null && pieceBefore !== null) {
      const actualPieceMove = pieceAfter - pieceBefore;
      const pieceError = targetPx - actualPieceMove;
      console.log(`[browser] Piece moved ${actualPieceMove.toFixed(1)}px (target=${targetPx}px, error=${pieceError.toFixed(1)}px)`);
      if (Math.abs(pieceError) > 2) {
        const nudge = pieceError / DRAG_RATIO;
        console.log(`[browser] Correcting: nudge mouse by ${nudge.toFixed(1)}px`);
        const curBox = await pg.evaluate(() => {
          const s = document.querySelector('#aliyunCaptcha-sliding-slider');
          return s ? s.getBoundingClientRect() : null;
        });
        if (curBox) {
          await pg.mouse.move(curBox.x + curBox.width / 2 + nudge, curBox.y + curBox.height / 2, { steps: 10 });
          await new Promise(r => setTimeout(r, 100 + Math.random() * 100));
        }
      }
    }

    await pg.mouse.up();
    await new Promise(r => setTimeout(r, 500 + Math.random() * 500));

    const outcome = await checkCaptchaResult(pg);
    if (outcome === 'success') {
      console.log('[browser] ✓ CV solved puzzle successfully!');
      await new Promise(r => setTimeout(r, 1000));
      return true;
    } else if (outcome === 'failed') {
      console.warn(`[browser] Captcha attempt ${attempt} failed — retrying...`);
      await pg.evaluate(() => {
        if (window.abortCurrentFetch) window.abortCurrentFetch();
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
    }
  }

  console.error('[browser] Captcha solve exhausted all attempts');
  return false;
}

// Solve aliyunCaptcha puzzle that appears inside an iframe
async function solveCaptchaCVInFrame(pg, frame) {
  for (let attempt = 1; attempt <= 8; attempt++) {
    console.log(`[browser w${pg.__workerId}] CV iframe solve attempt ${attempt}/8`);

    // Extract captcha images from the frame context
    const captchaData = await frame.evaluate(async () => {
      const bg = document.querySelector('#aliyunCaptcha-img');
      const puzzle = document.querySelector('#aliyunCaptcha-puzzle');
      if (!bg || !puzzle || !bg.src || !puzzle.src) return null;

      const bgRect = bg.getBoundingClientRect();
      const puzzleRect = puzzle.getBoundingClientRect();

      const fetchImage = async (url) => {
        if (url.startsWith('data:image')) return url;
        try {
          const resp = await fetch(url);
          const blob = await resp.blob();
          return await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(blob);
          });
        } catch { return null; }
      };

      const bg_b64 = await fetchImage(bg.src);
      const puzzle_b64 = await fetchImage(puzzle.src);
      if (!bg_b64 || !puzzle_b64) return null;

      return {
        bg_b64, puzzle_b64,
        bg_css_width: bgRect.width,
        bg_natural_width: bg.naturalWidth || bg.width || 300,
        puzzle_css_width: puzzleRect.width,
        puzzle_natural_width: puzzle.naturalWidth || puzzle.width || 60,
        puzzle_left_css: puzzleRect.left - bgRect.left,
      };
    }).catch(() => null);

    if (!captchaData) {
      console.warn('[browser] Failed to extract captcha data from iframe');
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }

    const solverResult = await callCaptchaSolver(captchaData);
    if (!solverResult || !solverResult.distance) {
      console.warn('[browser] CV solver failed for iframe captcha');
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }

    console.log(`[browser] Iframe CV distance: ${solverResult.distance}px (conf=${solverResult.confidence})`);

    // Get slider bounding box (using frame context for element, but page mouse for input)
    const sliderEl = await frame.$('#aliyunCaptcha-sliding-slider');
    if (!sliderEl) continue;
    const sliderBox = await sliderEl.boundingBox();
    if (!sliderBox) continue;

    const frameEl = await frame.frameElement();
    const frameBox = frameEl ? await frameEl.boundingBox() : { x: 0, y: 0 };
    const offsetX = frameBox ? frameBox.x : 0;
    const offsetY = frameBox ? frameBox.y : 0;

    const targetPx = Math.max(30, Math.min(350, solverResult.distance + (Math.random() - 0.5)));
    const mouseDistance = Math.round(targetPx / DRAG_RATIO + DRAG_DEAD_ZONE);

    const sliderCX = sliderBox.x + sliderBox.width / 2 + offsetX;
    const sliderCY = sliderBox.y + sliderBox.height / 2 + offsetY;

    // Move to slider with human movement
    await humanMove(pg, pg.__lastX || 640, pg.__lastY || 360, sliderCX, sliderCY);
    await new Promise(r => setTimeout(r, 150 + Math.random() * 150));

    await pg.mouse.move(sliderCX, sliderCY);
    await pg.mouse.down();
    await new Promise(r => setTimeout(r, 150 + Math.random() * 100));

    // Drag with overshoot
    const overshoot = Math.random() < 0.7 ? (3 + Math.random() * 6) : 0;
    const dragTo = sliderCX + mouseDistance + overshoot;
    const dragSteps = 30 + Math.floor(Math.random() * 15);
    const dragTime = 0.5 + Math.random() * 0.3;

    for (let i = 0; i <= dragSteps; i++) {
      const t = i / dragSteps;
      const eased = 1 - Math.pow(1 - t, 3);
      const x = sliderCX + (dragTo - sliderCX) * eased;
      const y = sliderCY + Math.sin(t * Math.PI) * (Math.random() * 2 - 1);
      await pg.mouse.move(x, y);
      await new Promise(r => setTimeout(r, (dragTime / dragSteps) * 1000 * (0.8 + Math.random() * 0.4)));
    }

    // Pullback if overshoot
    if (overshoot > 0) {
      const corrSteps = 10 + Math.floor(Math.random() * 8);
      for (let i = 1; i <= corrSteps; i++) {
        const t = i / corrSteps;
        const eased = t * t * (3 - 2 * t);
        await pg.mouse.move(dragTo - overshoot * eased, sliderCY + (Math.random() * 0.8 - 0.4));
        await new Promise(r => setTimeout(r, 20 + Math.random() * 30));
      }
    }

    await new Promise(r => setTimeout(r, 100 + Math.random() * 100));

    await pg.screenshot({ path: `slider_w${pg.__workerId}_post_${attempt}.png` });

    await pg.mouse.up();
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 500));

    // Check if the captcha cleared
    const stillVisible = await frame.$('#aliyunCaptcha-sliding-slider').catch(() => null);
    const stillBox = stillVisible ? await stillVisible.boundingBox().catch(() => null) : null;

    if (!stillVisible || !stillBox) {
      console.log('[browser] ✓ Iframe captcha solved!');
      // Wait for cookies to propagate then abort
      await new Promise(r => setTimeout(r, 1500));
      await pg.evaluate(() => {
        if (window.abortCurrentFetch) window.abortCurrentFetch();
      }).catch(() => {});
      return true;
    }

    console.warn(`[browser] Iframe captcha attempt ${attempt} failed`);
    await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
  }

  console.error('[browser] Iframe captcha solve exhausted all attempts');
  return false;
}

async function clickRefreshButton(pg) {
  try {
    const refreshBox = await pg.evaluate(() => {
      const btn = document.querySelector('#aliyunCaptcha-btn-refresh');
      if (!btn || !btn.offsetParent) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    if (refreshBox) {
      const cx = refreshBox.x + refreshBox.width / 2 + (Math.random() * 6 - 3);
      const cy = refreshBox.y + refreshBox.height / 2 + (Math.random() * 6 - 3);
      await humanMove(pg, pg.__lastX || 640, pg.__lastY || 360, cx, cy);
      await pg.mouse.click(cx, cy);
      console.log('[browser] Clicked captcha refresh');
    }
  } catch (e) {
    console.warn(`[browser] Refresh click error: ${e.message}`);
  }
}

async function checkCaptchaResult(pg) {
  for (let poll = 0; poll < 30; poll++) {
    const state = await pg.evaluate(() => {
      if (document.querySelector('.aliyunCaptcha-verify-success')) return 'success';
      if (document.querySelector('.aliyunCaptcha-verify-error')) return 'error';
      const param = document.querySelector('#aliyunCaptcha-verify-param');
      if (param && param.value && param.value.length > 20) return 'success';
      const popup = document.querySelector('#aliyunCaptcha-popup');
      if (!popup || popup.style.display === 'none' || popup.offsetParent === null) return 'popup_gone';
      return 'pending';
    }).catch(() => 'pending');

    if (state === 'success') return 'success';
    if (state === 'error') return 'failed';
    if (state === 'popup_gone') {
      await new Promise(r => setTimeout(r, 300));
      return 'success';
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return 'failed';
}

// Old-style NC slider with human-like movement + retry + verification
// The NC slider is a behavioral verification — you drag full-width and it
// passes or fails based on HOW you dragged (speed, acceleration, jitter).
async function solveOldSliderWithRetry(pg, frame) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    console.log(`[browser w${pg.__workerId}] NC slider attempt ${attempt}/5`);

    // Re-find the slider each attempt (it may have refreshed)
    const slider = await frame.$('#nc_1_n1z, .btn_slide');
    if (!slider) {
      console.log('[browser] NC slider gone — may have cleared');
      // Check if it upgraded to an aliyunCaptcha puzzle
      const upgradedToPuzzle = await frame.$('#aliyunCaptcha-sliding-slider, #aliyunCaptcha-img');
      if (upgradedToPuzzle) {
        console.log('[browser] NC slider upgraded to puzzle captcha — switching to CV solver');
        return await solveCaptchaCVInFrame(pg, frame);
      }
      // Slider gone and no puzzle = likely solved or page navigated
      await new Promise(r => setTimeout(r, 1000));
      await pg.evaluate(() => {
        if (window.abortCurrentFetch) window.abortCurrentFetch();
      }).catch(() => {});
      return true;
    }

    const box = await slider.boundingBox();
    if (!box || box.width <= 0) {
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    const track = await frame.$('#nc_1__scale_text, .scale_text, .nc-container');
    const trackBox = track ? await track.boundingBox() : null;
    const slideDistance = trackBox ? trackBox.width - box.width : 300;

    const frameEl = await frame.frameElement();
    const frameBox = frameEl ? await frameEl.boundingBox() : { x: 0, y: 0 };
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    console.log(`[browser-debug] Slider solve: startX=${startX}, startY=${startY}, slideDistance=${slideDistance}, frameBox.x=${frameBox.x}, box.x=${box.x}`);

    // Human approach: move from a random nearby position to the slider
    const approachX = startX - 100 - Math.random() * 200;
    const approachY = startY + (Math.random() * 100 - 50);
    await humanMove(pg, approachX, approachY, startX, startY);
    await new Promise(r => setTimeout(r, 200 + Math.random() * 300));

    console.log('[browser-debug] Slider solve starting pre-screenshot...');
    await pg.screenshot({ path: `slider_w${pg.__workerId}_pre_${attempt}.png` });

    console.log('[browser-debug] Pressing down on slider...');
    // Press down on slider
    await slider.hover();
    await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
    await pg.mouse.down();
    await new Promise(r => setTimeout(r, 100 + Math.random() * 150));

    // Drag to end using Bézier-like path with overshoot
    const targetEndX = startX + slideDistance;
    const overshoot = Math.random() < 0.6 ? (2 + Math.random() * 5) : 0;
    const dragTo = targetEndX + overshoot;
    const numSteps = 40 + Math.floor(Math.random() * 20);
    const totalTime = 0.5 + Math.random() * 0.5;

    console.log(`[browser-debug] Starting drag with numSteps=${numSteps}, totalTime=${totalTime}, overshoot=${overshoot}`);
    for (let i = 0; i <= numSteps; i++) {
      const t = i / numSteps;
      // Ease-out cubic — fast start, slowing down
      const eased = 1 - Math.pow(1 - t, 3);
      const x = startX + (dragTo - startX) * eased;
      // Sine wave wobble + random jitter
      const wobble = Math.sin(t * Math.PI) * (1 + Math.random() * 1.5);
      const y = startY + wobble + (Math.random() * 0.6 - 0.3);

      // Variable speed: slow→fast→slow
      let stepDelay;
      if (t < 0.1) stepDelay = (totalTime / numSteps) * (1.8 + Math.random());
      else if (t < 0.85) stepDelay = (totalTime / numSteps) * (0.6 + Math.random() * 0.4);
      else stepDelay = (totalTime / numSteps) * (1.3 + Math.random() * 0.7);

      // 1.5% chance of micro-hesitation mid-drag
      if (Math.random() < 0.015 && t > 0.2 && t < 0.8) {
        await new Promise(r => setTimeout(r, 30 + Math.random() * 50));
      }

      await pg.mouse.move(x, y);
      await new Promise(r => setTimeout(r, stepDelay * 1000));
      if (i % 10 === 0 || i === numSteps) console.log(`[browser-debug] Drag step ${i}/${numSteps} completed.`);
    }

    console.log('[browser-debug] Drag completed, pulling back overshoot...');
    // Pull back from overshoot
    if (overshoot > 0) {
      const corrSteps = 8 + Math.floor(Math.random() * 6);
      for (let i = 1; i <= corrSteps; i++) {
        const t = i / corrSteps;
        const eased = t * t * (3 - 2 * t);
        const x = dragTo - overshoot * eased;
        const y = startY + (Math.random() * 0.6 - 0.3);
        await pg.mouse.move(x, y);
        await new Promise(r => setTimeout(r, 25 + Math.random() * 35));
      }
    }

    // Micro settle at end
    for (let j = 0; j < 2 + Math.floor(Math.random() * 3); j++) {
      await pg.mouse.move(
        targetEndX + (Math.random() * 2 - 1),
        startY + (Math.random() * 2 - 1)
      );
      await new Promise(r => setTimeout(r, 15 + Math.random() * 25));
    }

    await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
    await pg.mouse.up();
    await pg.screenshot({ path: `slider_w${pg.__workerId}_post_${attempt}.png` });

    // Wait for verification result
    await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));

    // Check if slider is still there and visible
    let isVisible = false;
    let isPuzzleVisible = false;
    try {
      const sliderStill = await frame.$('#nc_1_n1z, .btn_slide');
      isVisible = sliderStill ? await sliderStill.boundingBox().catch(() => null) : null;
      if (!isVisible) {
        const upgradedToPuzzle = await frame.$('#aliyunCaptcha-sliding-slider, #aliyunCaptcha-img');
        isPuzzleVisible = upgradedToPuzzle ? await upgradedToPuzzle.boundingBox().catch(() => null) : null;
      }
    } catch (e) {
      // Execution context destroyed means the captcha frame was removed (solved!)
      console.log(`[browser] Frame check threw (likely solved): ${e.message}`);
      isVisible = false;
    }

    if (!isVisible) {
      if (isPuzzleVisible) {
        console.log('[browser] NC slider upgraded to puzzle after attempt — switching to CV');
        return await solveCaptchaCVInFrame(pg, frame);
      }

      console.log('[browser] ✓ NC slider solved (element gone)!');
      await new Promise(r => setTimeout(r, 1000));
      return true;
    }

    // Check for error state / need to retry
    const errorState = await frame.evaluate(() => {
      const errEl = document.querySelector('.nc-lang-cnt .nc_1_errloading, .errloading, [class*="error"]');
      return !!errEl;
    }).catch(() => false);

    if (errorState) {
      console.warn('[browser] NC slider failed behavioral check — clicking retry...');
      // Look for retry/refresh button in the nc frame
      const retryBtn = await frame.$('.nc-lang-cnt a, .errloading a, [class*="reset"]');
      if (retryBtn) {
        const retryBox = await retryBtn.boundingBox();
        if (retryBox) {
          await humanMove(pg, targetEndX, startY, retryBox.x + retryBox.width / 2, retryBox.y + retryBox.height / 2);
          await pg.mouse.click(retryBox.x + retryBox.width / 2, retryBox.y + retryBox.height / 2);
          await new Promise(r => setTimeout(r, 1000 + Math.random() * 500));
        }
      }
    } else {
      console.warn(`[browser] NC slider attempt ${attempt} — element still present, retrying...`);
    }

    await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
  }

  console.error('[browser] NC slider solve exhausted all attempts');
  await pg.evaluate(() => {
    if (window.abortCurrentFetch) window.abortCurrentFetch();
  }).catch(() => {});
  return false;
}

// Execute a fetch request inside the browser context.
// The fetch happens from Chrome itself, so TLS = genuine Chrome.
// Acquires any free worker for the duration of the evaluate call.
export async function browserFetch(url, options = {}) {
  if (workers.length === 0) throw new Error("Browser not initialized. Call initBrowser() first.");

  const worker = await acquireWorker();
  try {
    const result = await worker.page.evaluate(async (url, options) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 600000);

        window.abortCurrentFetch = () => {
          controller.abort();
        };

        const res = await fetch(url, {
          method: options.method || "GET",
          headers: options.headers || {},
          body: options.body || undefined,
          signal: controller.signal,
        });
        clearTimeout(timeout);
        const contentType = res.headers.get("content-type") || "";
        const text = await res.text();
        return { ok: res.ok, status: res.status, contentType, body: text };
      } catch (e) {
        if (e.name === "AbortError") {
          return { ok: false, challenge: true, error: "WAF_ABORT" };
        }
        return { ok: false, status: 0, contentType: "", body: e.message, error: true };
      }
    }, url, options);

    // Page-level network death (off-origin WAF redirect etc.) — recycle, and
    // report as challenge so the server's retry loop re-runs on a fresh page.
    if (result.error && /failed to fetch/i.test(String(result.body))) {
      recycleWorker(worker).catch(() => {});
      return { ok: false, challenge: true, error: "worker page recycled after network failure" };
    }
    return result;
  } finally {
    // A recycled worker was replaced in the pool — only release one still registered
    if (workers.includes(worker)) releaseWorker(worker);
  }
}

// Stream a completion via the browser, bridging chunks back to Node.js in real-time.
//
// Instead of accumulating inside page.evaluate() (which can't yield mid-execution),
// each parsed SSE chunk calls window.__onChunk(piece, phase) which Puppeteer
// marshals to the Node.js onChunk callback immediately.
//
// The abort problem is fixed with Promise.race: a manually-rejectable promise
// races against reader.read(). When the auto-solver calls abortCurrentFetch,
// it rejects the racing promise directly — no dependency on Chromium's stream
// abort behavior.
//
// Returns { ok, challenge?, error? } — content is already streamed via onChunk.
// Acquires a worker for the whole stream. Optional abortRef: an object that
// gets an .abort() bound to THIS stream's page (used by client-disconnect handling).
export async function browserFetchStream(url, options = {}, thinkEnabled = false, onChunk = () => {}, abortRef = null) {
  if (workers.length === 0) {
    // Distinguish "never started" from "every worker recycled away" — the
    // latter used to report a misleading init hint and cost a debugging session.
    throw new Error(
      ready
        ? "worker pool exhausted (all workers recycled away) — restart or re-init the browser"
        : "Browser not initialized. Call initBrowser() first.",
    );
  }

  const worker = await acquireWorker();
  const pg = worker.page;

  // Abort ONLY this worker's fetch — a global abort would hit other workers' streams
  const localAbort = async () => {
    try {
      await pg.evaluate(() => {
        if (typeof window.abortCurrentFetch === "function") {
          window.abortCurrentFetch();
        }
      });
    } catch (e) {}
  };
  if (abortRef) abortRef.abort = localAbort;

  const timeoutMs = Number(process.env.QWEN_TIMEOUT || 120000);
  let watchdogTimer = null;

  const resetWatchdog = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(async () => {
      console.warn(`[qwen-proxy w${worker.id}] Watchdog: No activity for ${timeoutMs}ms. Aborting stream.`);
      await localAbort();
    }, timeoutMs);
  };

  resetWatchdog();

  // Wire the per-request callback wrapped with watchdog reset; track liveness
  let gotAnyChunk = false;
  pg.__chunkCallback = (piece, phase, rawJSON) => {
    gotAnyChunk = true;
    resetWatchdog();
    onChunk(piece, phase, rawJSON);
  };

  let result;
  let healed = false;
  try {
    result = await pg.evaluate(async (url, options, thinkEnabled) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 600000);

      // Manual abort promise — THIS is what actually unblocks reader.read()
      let rejectRead;
      const abortPromise = new Promise((_, reject) => {
        rejectRead = reject;
      });

      window.abortCurrentFetch = () => {
        console.log("[browser-console] window.abortCurrentFetch called!");
        controller.abort();
        // Directly reject the Promise.race — guarantees the read loop breaks
        // even if Chromium's stream doesn't propagate the abort.
        rejectRead(new DOMException('WAF abort', 'AbortError'));
      };

      let res;
      try {
        res = await Promise.race([
          fetch(url, {
            method: options.method || "GET",
            headers: options.headers || {},
            body: options.body || undefined,
            signal: controller.signal,
          }),
          abortPromise,
        ]);
      } catch (e) {
        clearTimeout(timeout);
        console.log(`[browser-console] fetch catch: ${e.name} ${e.message}`);
        if (e.name === "AbortError") {
          return { ok: false, challenge: true, error: "WAF_ABORT" };
        }
        return { ok: false, error: e.message };
      }

      if (!res.ok || !res.body) {
        clearTimeout(timeout);
        const text = await res.text().catch(() => "");
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 2000)}`, status: res.status, body: text };
      }

      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("event-stream") && !ct.includes("octet-stream")) {
        const text = await res.text().catch(() => "");
        clearTimeout(timeout);

        if (text.includes("FAIL_SYS_USER_VALIDATE")) {
          try {
            const j = JSON.parse(text);
            if (j.data && j.data.url) {
              return { ok: false, challenge: true, punishUrl: j.data.url };
            }
          } catch(e) {}
          return { ok: false, challenge: true, error: "WAF triggered" };
        }

        return { ok: false, error: `Unexpected content-type "${ct}": ${text.slice(0, 2000)}`, status: res.status, body: text };
      }

      // Stream the SSE body, sending each chunk back to Node.js via __onChunk
      let buffer = "";
      let wafTriggered = false;
      let streamError = null;
      let streamFinished = false;
      let sawDoneMarker = false;

      // Returns true when this line terminates the stream ([DONE], WAF block,
      // upstream error). Everything else — including answer-phase "finished" —
      // keeps the loop reading.
      const handleLine = (line) => {
        if (!line || !line.startsWith("data:")) return false;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          sawDoneMarker = true;
          return true;
        }

        let evt;
        try { evt = JSON.parse(data); } catch { return false; }

        if (evt?.ret && Array.isArray(evt.ret) && evt.ret.includes("FAIL_SYS_USER_VALIDATE")) {
          wafTriggered = true;
          return true;
        }

        if (evt?.error) {
          streamError = `Qwen stream error: ${evt.error.details || evt.error.code || "unknown"}`;
          return true;
        }

        const delta = evt?.choices?.[0]?.delta;
        if (!delta) {
          // Some Qwen media events carry the artifact outside a text delta.
          // Forward the raw event so the proxy can inspect it.
          window.__onChunk("", "event", JSON.stringify(evt));
          return false;
        }
        const phase = delta.phase;
        const piece = delta.content || "";

        // Qwen never sends [DONE]; delta.status === "finished" marks the end of
        // a SEGMENT, not of the response — thinking_summary closes with it too,
        // and one generation can raise it many times while switching tools
        // (16 measured on the direct path). Record it and KEEP READING; only
        // body-close ends the stream. Mirrors server.js directRunCompletion.
        if (delta.status === "finished" && (!phase || phase === "answer")) {
          window.__onChunk(piece || "", phase || "answer", JSON.stringify(evt));
          streamFinished = true;
          return false;
        }

        if (phase === "think" && !thinkEnabled) return false;

        // Bridge to Node.js in real-time — this is the magic.
        // Puppeteer marshals this call via CDP (Runtime.bindingCalled).
        window.__onChunk(piece, phase || "answer", JSON.stringify(evt));
        return false;
      };

      try {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let readerDone = false;

        while (true) {
          // Promise.race: if abortCurrentFetch fires, abortPromise rejects
          // and we break out immediately — even if reader.read() is stuck.
          const { done, value } = await Promise.race([
            reader.read(),
            abortPromise,
          ]);
          if (done) {
            readerDone = true;
            break;
          }

          buffer += decoder.decode(value, { stream: true });

          let idx;
          let stop = false;
          while ((idx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (handleLine(line)) {
              stop = true;
              break;
            }
          }
          if (stop) break;
        }

        if (readerDone) {
          // Flush any multibyte sequence the decoder held back, then process an
          // unterminated final line — some streams end without a trailing
          // newline, and the splitter above would silently drop it (which could
          // flip a COMPLETE answer to finished:false -> finish_reason "length").
          buffer += decoder.decode();
          handleLine(buffer.trim());
        }
      } catch (e) {
        console.log(`WAF_ABORT DEBUG: name=${e.name}, message=${e.message}`);
        if (e.name === "AbortError") {
          return { ok: false, challenge: true, error: "WAF_ABORT" };
        } else {
          streamError = e.message;
        }
      } finally {
        controller.abort();
        clearTimeout(timeout);
      }

      if (wafTriggered) return { ok: false, challenge: true, error: "WAF triggered during stream" };
      if (streamError) return { ok: false, error: streamError };

      // finished=false means the connection closed without ANY answer-phase
      // terminator — a severed/truncated reply, not a clean one. Multi-segment
      // generations report finished=true as long as at least one segment
      // completed, matching the direct path's semantics.
      return { ok: true, finished: streamFinished };
    }, url, options, thinkEnabled);
  } finally {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    // Always clear the callback when page.evaluate resolves/rejects
    pg.__chunkCallback = null;

    // Poison signatures: page-level network death, or an ok stream that
    // produced zero chunks (any real completion emits at least think/answer/
    // event pieces). Recycle and let the server retry on the fresh page.
    const networkDead = !!result && result.ok === false && /failed to fetch/i.test(String(result.error || ""));
    const emptyStream = !!result && result.ok === true && !gotAnyChunk;
    if (networkDead || emptyStream) {
      healed = true;
      console.warn(`[browser w${worker.id}] ${networkDead ? "network failure" : "empty stream"} — recycling worker`);
      recycleWorker(worker).catch(() => {});
    } else if (workers.includes(worker)) {
      releaseWorker(worker);
    }
  }

  if (healed) return { ok: false, challenge: true, error: "worker page recycled" };
  return result;
}



export async function closeBrowser() {
  if (browser) {
    for (const w of workers) {
      await w.context.close().catch(() => {});
    }
    workers.length = 0;
    // Nobody will ever release a worker again — drain queued acquirers so
    // their promises reject instead of hanging forever.
    const stranded = waiters.splice(0);
    for (const w of stranded) {
      try { w(); } catch {}
    }
    await browser.close().catch(() => {});
    browser = null;
    ready = false;
  }
}

// Test hook: exposes pool internals for unit tests without launching Chrome
export const __pool = { workers, waiters, acquireWorker, releaseWorker };
