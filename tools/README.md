# Test tools for Miller's Planet

These tools drive the real page in headless Chrome on this Mac's GPU, take screenshots, time the GPU, press real keys and move a real mouse, and check the build. Nothing to install: they use plain Node (23 or newer) and the Google Chrome that is already on the machine. The only package any tool loads is Vite, which `target.mjs` uses to start the dev server.

Run everything from the project folder, usually through npm (`npm run shots`, and so on).

## Before you measure anything

- Plug in the laptop. On battery at 20% or less, Chrome slows animation to 30 fps and every timing is wrong.
- Close the Claude desktop app's Browser pane tab. It draws pages on the same GPU, and no tool can see it.
- Never run two timing tools at the same time. Two headless Chromes fight over the GPU and the main thread, and frames get dropped (seen while testing these tools: a 33 ms gap appeared in an otherwise perfect run).
- `npm run check:machine` tells you whether the machine is fit to measure.

## Settings most tools share

| Setting | Meaning |
|---|---|
| `SERVE=dev` | Default. Starts the Vite dev server on a free port (Vite 8 ignores "port 0", so the tool picks the port itself). |
| `SERVE=dist` | Serves the built `dist/` folder, like the real site. Run `npm run build` first; the tool warns if source files changed after the build. Use this for every gate-8 rerun. |
| `PAGE_URL=...` | Use a page that is already running somewhere, or a `file://` page such as `tools/probes/fake-page.html`. |
| `VIEWPORT=1728x1117`, `DPR=2` | Window size and pixel density. The default gives the 16-inch MacBook Pro's 3456x2234 canvas. |
| `QUERY=a=1&b=2` | Extra URL parameters for the page (they win over the tool's own). |
| `EVIDENCE_DIRECTORY=...` | Where images and JSON go. Default: `evidence/`. |
| `READY_TIMEOUT_MS=60000` | How long to wait for `millersPlanet.isReady`. |

Every tool kills the Chrome it starts, even on Ctrl+C or a crash, and never touches other Chrome windows.

## check:machine (`preflight.mjs`)

Checks the machine and the page before measuring:
- power source (warns on battery; `STRICT_POWER=1` makes it a failure);
- GPU load from other apps, 5 samples (warns above 10%; `STRICT_GPU=1` makes it a failure);
- other headless Chrome processes (warns, never kills them);
- a raw WebGPU probe page (`probes/timestamp-probe.html`): the GPU must offer `timestamp-query`, and 300 frames of a small compute pass must give timestamps with a greatest common divisor under 1000 ns (rounded timestamps fail). It also fails if Chrome caps the frame rate;
- inside the app: `stats().gpu.source` is `timestamp-query`, `stats().output` is 3456x2234, the GPU vendor is `apple`, the device is not lost, and there are no GPU errors.

Run: `npm run check:machine`. `SKIP_APP=1` skips the app part. Exit code 0 = fit to measure, 2 = something failed. `bench` and `flight` run the same checks themselves.

## shots (`shoot.mjs`, with the shot list in `shots.mjs`)

Takes the named screenshots. For each shot it calls `millersPlanet.setCameraShot(name)` (plus any setup the shot list names), renders 32 frames so the image settles, and saves `evidence/<phase>-<shot>.png` at full 3456x2234. If the page returns crop rectangles, each is saved as `evidence/<phase>-<shot>-<crop>.png`. It prints the GPU time, render scale and internal size for each shot.

Run: `npm run shots` (phase 2), `npm run shots -- 3` (all phase-3 shots) or `npm run shots -- empty spike-ground`. The list in `shots.mjs` already holds every shot from the project doc; later shots fail with "unknown shot" until the app builds them.

Settings: `PHASE` (default 2), `FRAMES` (settle frames, 32), `SCALE` (render scale, pinned to 0.7 by default; `SCALE=live` lets the controller run), `FINAL=1` (writes `evidence/final/<shot>.jpg` instead: JPEG quality 90 at 1728x1117, no crops). Exit code 1 if any shot fails, the page throws or logs an error, or `stats().gpuErrors` is not empty. Look at every image yourself before trusting it.

## bench (`bench.mjs`)

Times the GPU on fixed shots. Each run uses a fresh Chrome. For each shot it calls `millersPlanet.benchmark({ frames, warmup, paced })` and reports the frame span (first pass start to last pass end) at p50, p95, p99 and max, the per-pass times by label (p50 and p99), and the render scale. It also checks that every measured frame was timed, that no pipelines were created after warm-up, and that there were no GPU errors. It writes `evidence/<phase>-bench.json` with the raw numbers.

Run: `npm run bench` (the phase-2 shots marked for benchmarking), or `npm run bench -- empty`. Settings: `RUNS` (3; the report shows the worst value of each metric over all runs), `FRAMES` (300), `WARMUP` (90), `UNPACED=1` (render back to back instead of once per screen refresh, which keeps the GPU clock up), `SCALE` (pins the render scale), `SHOTS=a,b`, `PHASE`, `SPAN_P99_LIMIT_MS` (14). Exit code 0 = pass, 1 = a span p99 over the limit or a broken measurement, 2 = refused because a preflight check failed (for example no timestamp queries).

## flight (`flight.mjs`)

The 30-second pass-rule run with the dynamic resolution controller working. The page renders normally while Node moves the camera every 100 ms through `millersPlanet.debug.setOrbitCamera` (the page eases between those points itself). Afterwards the tool reads every frame from `millersPlanet.frameLog()` (it never samples `stats()`), so no frame can be missed.

Pass rule, checked on every one of the runs: GPU span p99 at most 14.0 ms, span max at most 16.6 ms, the gap between rendered frames at most 16.8 ms (plus 0.05 ms, because headless Chrome reports frame times in 0.1 ms steps, so a perfect 60 Hz stream reads 16.6 to 16.8 ms), render scale median at least 0.7 and minimum at least 0.5, and every frame timed. It prints a table per run and the worst value of each metric, plus the slowest frames and longest gaps with what the camera was doing, and the controller's response to the step from looking only at the sky to looking only at the ground. It writes `evidence/<phase>-flight-run<k>.json` with every frame.

Run: `npm run flight`. Settings: `FLIGHT=empty` (phase 2; `wave` and `walk` are placeholders until phases 7 and 5), `RUNS` (3), `SECONDS` (30), `SETTLE_SECONDS` (3), `VERBOSE=1`, `PHASE`. `SCALE` is refused, because the controller must be free. Exit code 0 = every run passed, 1 = a run failed, 2 = refused by preflight.

## interact (`interact.mjs`)

Real keyboard, mouse and wheel input through Chrome, checked against the page's state. With `PHASE=2` (the default) it runs:
1. start-up: ready, a 3456x2234 canvas, no console errors;
4. the first click on the canvas locks the pointer and starts audio, and adds no page elements;
5. the mouse wheel changes nothing;
6. ctrl+wheel changes nothing;
7. a trackpad-style pinch (many small ctrl+wheel steps) and the `+`, `-`, `=`, `_` keys (and the keypad ones) change nothing;
15. releasing the pointer lock clears held keys;
17. the console stays clean.

Each "changes nothing" test sends input in one direction per block and checks the camera, `visualViewport.scale` and scrolling after every block, both with the pointer locked and unlocked. Sending +N and then -N and comparing only the start and end would pass a page that zooms (the two halves cancel out); the tests were proved against a fake page that does exactly that. Every wheel event must also have been `preventDefault()`ed, or a real trackpad would zoom the browser. Esc cannot be tested headless (Esc sent through Chrome's remote control does not release the lock), so check 15 uses `document.exitPointerLock()`.

Checks 2, 3, 8 to 14 belong to later phases and fail with "not written yet" when `PHASE` reaches them; check 16 (the no-WebGPU line) runs from `PHASE=6`. Exit code 1 if any check fails.

## spike (`spike.mjs`)

The phase-2 engine checks. It runs `millersPlanet.debug.spike.runAll()` in the app (S0, S0b, S1 to S13), adds S0c from the timestamp probe, and does S14 itself: `npm run build`, serve `dist/`, record every network request while the page loads and renders for 10 s, and fail if anything other than the page, the JS and CSS files that `index.html` loads (directly or through static imports), `data:` URLs and the page's own `blob:` URLs is requested. A `.wasm` file (glslang or twgsl), a lazily loaded chunk, a favicon request or anything from another site fails. Items missing from `runAll()` count as failures, and so do errors the page logs while starting. Errors logged during `runAll()` are only listed (S12 and S13 break shaders on purpose, and Babylon logs that) and kept in the JSON file; a separate row fails if GPU errors are left over afterwards. If S0 fails, it says to stop and ask the user, as the plan requires. Writes `evidence/2-spike.json` and prints a PASS/FAIL table.

Run: `npm run spike`. Settings: `SKIP_BUILD=1` (use the existing `dist/`), `SPIKE_DIST_DIRECTORY` (serve another folder for S14), `S14_SECONDS` (10), `SKIP_S14=1`. Exit code 1 if any item fails.

## test:pacing (`test-pacing.mjs`)

Unit test for `createFramePacer` in `src/core/pacing.js`. It feeds 10-second streams of screen refreshes at 60, 90, 120 and 144 Hz, each with up to 0.3 ms of random jitter, and checks: at 60 Hz every refresh renders; at 120 Hz exactly every other refresh renders (gaps of 16.67 ms, give or take 0.6 ms); at 90 and 144 Hz the average is 60 fps, give or take 1. Two extra checks: `reset()` makes the next refresh render, and after a 500 ms stall at 120 Hz the pacer does not burst to catch up. Patterns are checked after the first 250 ms. A plain "15 ms since the last frame" rule fails this test (45 fps at 90 Hz).

Run: `npm run test:pacing`, or `node tools/test-pacing.mjs <other-pacer.js>` to test another file. Exit code 1 on any failure.

## sheet (`contact-sheet.mjs`)

Puts images side by side in one JPEG or PNG, without stretching them, each labelled with its file name. Chrome does the decoding and drawing, because this Mac has no ImageMagick, ffmpeg or Pillow.

Run: `npm run sheet -- evidence evidence/2-sheet.jpg --filter 2-` (options: `--columns 3`, `--tile-width 864`, `--filter <file name start>`), or `node tools/contact-sheet.mjs --pair <our image> <film still> <out.jpg> [--height 720]` for a side-by-side with a film still.

Film stills must never leave `reference-stills/`: if any input is in that folder, the output must be in that folder too, otherwise the tool refuses before reading or writing anything. Exit code 1 on refusal or error.

## measure-image (`measure-image.mjs`)

Measures colour in rectangles of an image: mean sRGB, mean linear RGB, linear luminance Y, sRGB luma Y', hue, saturation and (G+B)/2/R, and the contrast between two regions (as a percentage of the second region's brightness).

Run: `node tools/measure-image.mjs evidence/3-sky-away.png --region sky=0,0,1,0.4 --region sea=0,0.6,1,0.4 --contrast sky,sea`. Four numbers all between 0 and 1 are fractions of the image; other numbers are CSS pixels of a 1728-pixel-wide window (`--css-width` changes that); `px:` means raw image pixels. `--json` prints JSON; `--out file.json` writes it (with the same film-stills rule as the sheet). Exit code 1 on error.

## size (`size-report.mjs`)

The download size of `dist/`: every file's raw, gzip (level 9) and brotli (quality 11) size, the 15 biggest files, and the total against the 1.5 MB brotli budget (1,500,000 bytes; `BUDGET_BYTES` changes it). Source maps are listed but not counted; if they exist, it also lists the biggest source modules. Run: `npm run build && npm run size` (or `node tools/size-report.mjs <folder>`). Exit code 1 if over budget or `dist/` is missing.

## comments (`check-comments.mjs`)

Fails on any code comment in `src/` (JS, WGSL, CSS, HTML), `index.html`, `vite.config.js` and `tools/` (MJS, JS, HTML). The only exception is Noniv's exact licence header at the very top of a file that is derived from snowflow_demo or web-ocean. It reads the code properly, so `//` inside strings, template literals, regular expressions and URLs is not mistaken for a comment. It also flags a line inside a template literal that starts with `//` or `/*`, because that is a comment in shader code embedded in JavaScript. Prints `file:line` for each comment. Run: `npm run comments` (or `node tools/check-comments.mjs <files...>`). Exit code 1 if any comment is found.

## lockfile (`check-lockfile.mjs`)

Checks `package-lock.json`: every `resolved` address starts with `https://registry.npmjs.org/`, the office registry host `reports.mn` appears nowhere, and every locked name and version exists on jsDelivr (registry.npmjs.org itself is blocked on this network). Run: `npm run lockfile`. Exit code 1 on any problem.

## serve (`serve.mjs`)

A tiny static file server for `dist/` (or any folder) on 127.0.0.1, with the right content types and no caching. Run: `node tools/serve.mjs [folder] [port]`; Ctrl+C stops it. Other tools import `startStaticServer(folder, port)`.

## Black hole physics references (`kerr-reference.mjs`, `geodesic-lab.mjs`)

Copied unchanged from the user's black hole renderer for phase 3: a double-precision version of the ray integrator plus two independent references. Run `node tools/geodesic-lab.mjs [schwarzschild|kerr|shadow|cost|all]`.

## Shared pieces

- `cdp.mjs`: the Chrome driver (launch, pages, real key, mouse and wheel events, screenshots, network log, console and error collection).
- `target.mjs`: starts the right server, opens the page at 1728x1117 at 2x and waits for `millersPlanet.isReady`.
- `page-results.mjs`: reads what `benchmark()` and `frameLog()` return.
- `stats.mjs`: percentiles (nearest rank, the same formula as the black hole tools) and tables.
- `image-workbench.mjs`: image decoding in Chrome and the film-stills guard.
- `probes/timestamp-probe.html`: the raw WebGPU timestamp probe.
- `probes/fake-page.html`: a stand-in for the app with the same `window.millersPlanet` shapes. Add `?fault=<name>` to plant a fault (for example `wheel-zoom`, `no-prevent`, `keep-keys`, `slow-frames`, `drop-frames`, `untimed`, `pipelines`, `gpu-errors`) and prove a check can fail: `PAGE_URL=file://$PWD/tools/probes/fake-page.html?fault=wheel-zoom npm run interact`.

## What the tools expect from the page

`window.millersPlanet` must exist as soon as the page script runs, with `isReady` and `ready`. The tools call `stats()`, `renderFrames(n)`, `setCameraShot(name)`, `freezeTime(seconds)`, `setViewPreset(n)`, `setShipState(n)`, `benchmark({ frames, warmup, paced })`, `frameLog(sinceFrameIndex)`, `debug.setOrbitCamera({ yawDegrees, pitchDegrees, distance, targetHeight, transitionSeconds })` and `debug.spike.runAll()`. From `stats()` they read `gpu.source`, `gpu.quantizedSuspect`, `gpuErrors`, `output`, `adapter.vendor`, `deviceLost`, `camera`, `pointerLocked`, `audio.state` and `heldKeys` (or `input.heldKeys`). `frameLog(since)` returns frames after `since` with `frameIndex`, `rafTimeMs`, `gpuSpanMs`, `scale` and friends, plus `latestFrameIndex`. `benchmark()` returns per-frame `spans` (or `spanMs`), `passes` by label, `scale`, `intervals`, the frame counters `framesMeasured` (or `framesSubmitted`) and `framesTimed`, and `pipelinesCreated`.
