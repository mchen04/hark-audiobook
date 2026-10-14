export function frameSampler() {
  const documentId = `${performance.timeOrigin}`;
  const frames = [];
  const actions = [];
  let pending = [];
  let activeAction = null;
  let sampling = true;
  let firstPaint = false;
  let imports = 0;
  const scriptError = (kind, message, stack) =>
    void window.__harkScriptError?.({
      documentId,
      wallTime: performance.timeOrigin + performance.now(),
      kind,
      message,
      stack,
    });
  addEventListener("error", (event) => {
    if (event.message) scriptError("error", event.message, event.error?.stack ?? null);
  });
  addEventListener("unhandledrejection", (event) =>
    scriptError("unhandledrejection", String(event.reason), event.reason?.stack ?? null),
  );
  document.addEventListener(
    "change",
    (event) => {
      if (event.target?.matches("input[type=file]") && event.target.files?.length) imports++;
    },
    true,
  );
  const visible = (element) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (
      !rect.width ||
      !rect.height ||
      style.visibility === "hidden" ||
      style.display === "none" ||
      Number(style.opacity) === 0 ||
      rect.bottom <= 0 ||
      rect.top >= innerHeight ||
      rect.right <= 0 ||
      rect.left >= innerWidth
    )
      return null;
    return {
      identity:
        element.tagName === "HEADER"
          ? "app-header"
          : element.querySelector("a.book-title")?.getAttribute("href") ||
            `${element.id || element.tagName}:${element.textContent?.trim() || element.getAttribute("aria-label") || ""}`,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      text: element.textContent?.trim().slice(0, 120) || element.getAttribute("aria-label") || "",
    };
  };
  const flush = () => {
    if (pending.length) {
      const batch = pending;
      pending = [];
      void window.__harkFrameBatch?.({ documentId, frames: batch });
    }
  };
  window.__harkSampler = {
    documentId,
    frames,
    actions,
    flush,
    stop() {
      sampling = false;
      flush();
    },
    begin(action) {
      activeAction = {
        ...action,
        id: `${documentId}:${actions.length}`,
        documentId,
        start: performance.now(),
        startWallTime: performance.timeOrigin + performance.now(),
        end: null,
      };
      actions.push(activeAction);
      return activeAction;
    },
    end() {
      if (activeAction) activeAction.end = performance.now();
      activeAction = null;
    },
  };
  const tick = () => {
    if (!sampling) return;
    const heading = document.querySelector("h1");
    const playerHeading = document.querySelector(".player-page h1, #book-title");
    const play = [...document.querySelectorAll(".player-page button")].find(
      (button) => (button.getAttribute("aria-label") || button.textContent?.trim()) === "Play",
    );
    const landmarks = {
      header: visible(document.querySelector("header.app-header")),
      mainHeading: visible(heading),
      firstCard: visible(document.querySelector(".book-grid .book-item")),
      playerHeading: visible(playerHeading),
      playButton: visible(play),
    };
    const marker =
      document.querySelector("[data-launch-ready]")?.getAttribute("data-launch-ready") ?? null;
    const cards = document.querySelectorAll(".book-grid .book-item").length;
    const notice = document.querySelector(
      ".library-content[aria-busy='true'] .no-results, .library-content .no-results h2",
    );
    const login = visible(document.querySelector('input[type="password"]'));
    const state = login
      ? "login"
      : landmarks.playerHeading
        ? "player"
        : marker === "books" && cards > 0
          ? "books"
          : visible(notice)
            ? "first-sync notice"
            : marker === "empty"
              ? "empty library"
              : landmarks.mainHeading?.text === "Settings"
                ? "settings"
                : Object.values(landmarks).some(Boolean)
                  ? "header-only"
                  : "blank";
    firstPaint ||=
      state !== "blank" ||
      performance
        .getEntriesByType("paint")
        .some((entry) => entry.name === "first-contentful-paint");
    const frame = {
      documentId,
      time: performance.now(),
      wallTime: performance.timeOrigin + performance.now(),
      url: location.pathname + location.search,
      marker,
      cards,
      landmarks,
      state,
      firstPaint,
      imports,
      action: activeAction ? { ...activeAction } : null,
    };
    frames.push(frame);
    pending.push(frame);
    if (pending.length >= 30) flush();
    requestAnimationFrame(tick);
  };
  addEventListener("pagehide", flush);
  requestAnimationFrame(tick);
}

export async function attachSampler(context) {
  const frames = [];
  const actions = [];
  const scriptErrors = [];
  await context.exposeBinding("__harkFrameBatch", (_source, batch) => frames.push(...batch.frames));
  await context.exposeBinding("__harkScriptError", (_source, error) => scriptErrors.push(error));
  await context.addInitScript(frameSampler);
  return {
    async begin(page, target, leaving, kind = "click") {
      const action = await page.evaluate(
        ({ target, leaving, kind }) => window.__harkSampler.begin({ target, leaving, kind }),
        { target, leaving, kind },
      );
      actions.push(action);
      return action;
    },
    async end(page, action) {
      action.endWallTime = Date.now();
      await page.evaluate(() => window.__harkSampler?.end());
    },
    async stop(page) {
      await page.evaluate(() => window.__harkSampler?.stop());
    },
    async read(context) {
      for (const page of context.pages())
        await page.evaluate(() => window.__harkSampler?.flush()).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { frames: [...frames].sort((a, b) => a.wallTime - b.wallTime), actions, scriptErrors };
    },
  };
}

export function analyzeFrames(recording) {
  const events = [];
  const add = (kind, frame, detail) =>
    events.push({
      kind,
      documentId: frame.documentId,
      time: frame.time,
      wallTime: frame.wallTime,
      url: frame.url,
      ...detail,
    });
  const seen = new Map();
  let previous;
  let blank = false;
  let painted = false;
  const emptyRuns = new Map();
  const expiredDocuments = new Set();
  recording.expectedTransitions = [];
  for (const frame of recording.frames) {
    const history = emptyRuns.get(frame.documentId) ?? { runs: [], previous: null };
    if (frame.state === "empty library") {
      if (history.previous?.state !== "empty library")
        history.runs.push({ start: frame.time, end: null, frames: 0, imports: frame.imports ?? 0 });
      history.runs.at(-1).frames++;
    } else if (history.previous?.state === "empty library") history.runs.at(-1).end = frame.time;
    if (frame.state === "books") {
      for (const run of history.runs)
        if (run.imports === (frame.imports ?? 0))
          add("false-empty", frame, {
            emptyFrames: run.frames,
            emptyDurationMs: run.end - run.start,
            emptyStartedAt: run.start,
            emptyEndedAt: run.end,
          });
      history.runs = [];
    }
    history.previous = frame;
    emptyRuns.set(frame.documentId, history);
    const action =
      frame.action ||
      recording.actions.find(
        (a) => frame.wallTime >= a.startWallTime && frame.wallTime <= (a.endWallTime ?? Infinity),
      );
    if (previous && previous.documentId !== frame.documentId) {
      seen.clear();
      painted = false;
      blank = false;
    }
    painted ||= frame.firstPaint;
    if (painted && frame.state === "blank") {
      if (!blank) add("blank-after-first-paint", frame, {});
      blank = true;
    } else blank = false;
    if (previous?.state === "books" && frame.state !== "books" && !action) {
      const expiry = recording.responses?.find(
        (response) =>
          response.documentId === previous.documentId &&
          [401, 403].includes(response.status) &&
          new URL(response.url).pathname === "/api/sync/pull" &&
          response.wallTime <= frame.wallTime,
      );
      if (
        frame.documentId !== previous.documentId &&
        frame.url.split("?")[0] === "/login" &&
        expiry &&
        !expiredDocuments.has(previous.documentId)
      ) {
        expiredDocuments.add(previous.documentId);
        recording.expectedTransitions.push({
          kind: "confirmed-session-expiry",
          fromDocumentId: previous.documentId,
          toDocumentId: frame.documentId,
          wallTime: frame.wallTime,
          response: expiry,
        });
      } else add("state-regression", frame, { from: "books", to: frame.state });
    }
    for (const [name, rect] of Object.entries(frame.landmarks)) {
      const past = seen.get(name);
      const leaving = action?.leaving?.includes(name);
      if (!rect) {
        if (past && !past.missing)
          past.missing = { time: frame.time, documentId: frame.documentId, expected: !!leaving };
        continue;
      }
      const identityChanged = past && past.rect.identity !== rect.identity;
      if (past?.missing && !past.missing.expected)
        add("blink", frame, {
          landmark: name,
          disappearedAt: past.missing.time,
          disappearedDocument: past.missing.documentId,
        });
      if (past && !identityChanged && !past.missing?.expected && !leaving) {
        const delta = Math.max(
          ...["x", "y", "width", "height"].map((key) => Math.abs(rect[key] - past.anchor[key])),
        );
        if (delta > 1 && (!past.moved || past.missing))
          add("layout-jump", frame, {
            landmark: name,
            deltaPx: delta,
            from: past.anchor,
            to: rect,
          });
        past.moved = delta > 1;
      }
      seen.set(name, {
        rect,
        anchor: !past || identityChanged || past.missing?.expected ? rect : past.anchor,
        missing: null,
        moved: !past || identityChanged || past.missing?.expected ? false : past.moved,
      });
    }
    previous = frame;
  }
  return events;
}

export function isHandledReloadDiagnostic(error, recording) {
  const resource =
    (error.name === "Fetch API cannot load http" && error.stack.includes("/api/sync/pull?")) ||
    (error.name === "Cannot load blob" &&
      error.stack.startsWith("Cannot load blob:http://127.0.0.1:") &&
      error.stack.includes("at peekBuffer"));
  return (
    resource &&
    error.message.endsWith(" due to access control checks.") &&
    recording.scriptErrors.length === 0 &&
    recording.actions.some(
      (action) =>
        ["reload-player", "reload-library"].includes(action.kind) &&
        error.wallTime >= action.startWallTime &&
        error.wallTime <= action.endWallTime,
    )
  );
}

export function timingProbe() {
  window.__harkTiming = {
    books: null,
    target: null,
    clicked: null,
    targetAt: null,
    audioBefore: null,
    audioAt: null,
  };
  const shown = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.top < innerHeight &&
      rect.right > 0 &&
      rect.left < innerWidth &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) > 0
    );
  };
  document.addEventListener(
    "playing",
    () => {
      if (window.__harkTiming.target === "audio") window.__harkTiming.playingAt = performance.now();
    },
    true,
  );
  document.addEventListener(
    "click",
    (event) => {
      if (event.isTrusted && window.__harkTiming.target)
        window.__harkTiming.clicked = performance.now();
    },
    true,
  );
  const tick = () => {
    const timing = window.__harkTiming;
    const marker = document.querySelector('[data-launch-ready="books"]');
    const cards = document.querySelectorAll(".book-grid .book-item").length;
    if (marker && cards > 0 && !timing.books)
      timing.books = { ms: performance.now(), marker: "books", cards };
    const play = [...document.querySelectorAll(".player-page button")].find(
      (b) => (b.getAttribute("aria-label") || b.textContent?.trim()) === "Play",
    );
    const player = shown(document.querySelector(".player-page h1, #book-title")) && shown(play);
    const targetReady =
      timing.target === "books"
        ? marker && cards > 0 && shown(marker)
        : timing.target === "player"
          ? player
          : timing.target === "play-enabled"
            ? player && !play.disabled
            : timing.target === "settings"
              ? [...document.querySelectorAll("h1")].some(
                  (h) => h.textContent?.trim() === "Settings" && shown(h),
                )
              : false;
    if (timing.clicked !== null && targetReady && timing.targetAt === null)
      timing.targetAt = performance.now();
    const audio = document.querySelector("audio");
    if (
      timing.target === "audio" &&
      timing.clicked !== null &&
      audio &&
      !audio.paused &&
      audio.currentTime >= timing.audioBefore + 0.2 &&
      timing.audioAt === null
    )
      timing.audioAt = performance.now();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export async function timedClick(page, locator, target) {
  await locator.scrollIntoViewIfNeeded();
  await page.evaluate((target) => {
    Object.assign(window.__harkTiming, {
      target,
      clicked: null,
      targetAt: null,
      audioAt: null,
      playingAt: null,
      audioBefore: document.querySelector("audio")?.currentTime ?? 0,
    });
  }, target);
  await locator.click();
  await page.waitForFunction(
    (target) =>
      target === "audio"
        ? window.__harkTiming.audioAt !== null
        : window.__harkTiming.targetAt !== null,
    target,
    { timeout: 30000, polling: "raf" },
  );
  return page.evaluate((target) => {
    const timing = window.__harkTiming;
    const audio = document.querySelector("audio");
    return {
      ms: (target === "audio" ? timing.audioAt : timing.targetAt) - timing.clicked,
      clickedAt: timing.clicked,
      playingAt: timing.playingAt,
      paintedAt: target === "audio" ? timing.audioAt : timing.targetAt,
      playback:
        target === "audio"
          ? { before: timing.audioBefore, after: audio.currentTime, paused: audio.paused }
          : null,
    };
  }, target);
}
