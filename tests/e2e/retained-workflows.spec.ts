import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { zipSync, strToU8 } from "fflate";
import postgres from "postgres";
import { startControllableNetwork } from "../parity/harness/network";
import { TEST_CLIENT_HEADERS } from "../shared/test-client-ip";
import { testAccountPassword } from "../shared/test-account-password";
import {
  awaitRetainedAuthBudget,
  findRetainedAccount,
  RETAINED_CREDENTIAL_DIAGNOSTIC,
  RETAINED_EMAIL,
} from "../shared/retained-auth";
import { closeSql, resetAccount, sql } from "../sync/harness/app";

test.use({ extraHTTPHeaders: TEST_CLIENT_HEADERS.retained });
test.afterAll(closeSql);

async function openAccount(page: Page, origin = "", waitUntilReady = true) {
  page.setDefaultTimeout(15000);
  // Reuse one disposable identity across runs. Only the account-deletion
  // journey removes it; resets leave auth sessions and real rate limits intact.
  const email = RETAINED_EMAIL;
  const password = testAccountPassword("retained-workflows");
  const existing = await findRetainedAccount(password);
  await retainedBudget(existing ? "sign-in" : "sign-up");
  if (existing) {
    await resetAccount(existing.id);
  }
  console.log(`[retained] ${existing ? "reuse/sign-in" : "create disposable account"}`);
  await page.goto(`${origin}/${existing ? "login" : "register"}`);
  if (!existing) await page.getByLabel("Name").fill("Disposable workflow account");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel(/Password/).fill(password);
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes(`/api/auth/${existing ? "sign-in" : "sign-up"}/email`),
  );
  await page.getByRole("button", { name: existing ? "Sign in" : "Create account" }).click();
  const response = await responsePromise;
  expect(
    response.status(),
    "Authentication rate-limited: wait for the real database-backed window; do not reset it",
  ).not.toBe(429);
  expect(response.ok(), `Authentication returned HTTP ${response.status()}`).toBe(true);
  await expect(page).toHaveURL(/\/library/);
  if (waitUntilReady) {
    await expect(page.locator('[data-launch-ready="empty"]')).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  }
  return { email, password };
}

async function retainedBudget(operation: "sign-in" | "sign-up") {
  await awaitRetainedAuthBudget(operation, (waitMs) => {
    // A real signup idle window can exceed the individual test's normal limit.
    test.setTimeout(test.info().timeout + waitMs);
    console.log(`[retained] waiting ${Math.ceil(waitMs / 1000)}s for the real ${operation} bucket`);
  });
}
const chooser = (page: Page) =>
  page.locator('input[aria-label="Choose an audiobook or document to import"]');
const position = (page: Page) => page.getByRole("slider", { name: "Audiobook position" });
async function shot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
}

function chapteredAudio(info: TestInfo) {
  const metadata = info.outputPath("chapters.txt");
  const audio = info.outputPath("chapters.mp3");
  writeFileSync(
    metadata,
    ";FFMETADATA1\ntitle=Objective Chapters\nartist=Disposable fixture\n" +
      [0, 1, 2]
        .map(
          (i) =>
            `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${i * 30000}\nEND=${(i + 1) * 30000}\ntitle=Part ${i + 1}\n`,
        )
        .join(""),
  );
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=90",
    "-i",
    metadata,
    "-map_metadata",
    "1",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "64k",
    "-y",
    audio,
  ]);
  return audio;
}

test("retained player, organization, transcript, settings, export and deletion workflows", async ({
  page,
}, info) => {
  test.setTimeout(180000);
  const account = await openAccount(page);
  await shot(page, info, "empty");
  const audio = chapteredAudio(info);
  await chooser(page).setInputFiles(audio);
  const link = page.getByRole("link", { name: "Objective Chapters", exact: true });
  await expect(link).toBeVisible();
  const bookUrl = await link.getAttribute("href");
  await link.click();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await position(page).fill("20000");
  await page.getByRole("button", { name: "Forward 30 seconds", exact: true }).click();
  await expect(position(page)).toHaveValue("50000");
  await page.getByRole("button", { name: "Back 15 seconds", exact: true }).click();
  await expect(position(page)).toHaveValue("35000");
  await page.getByRole("combobox", { name: /Playback speed/ }).selectOption("1.5");
  await page.getByRole("button", { name: "Chapters", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Chapters", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Part 3/ }).click();
  await expect(position(page)).toHaveValue("60000");
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.locator(".history-list li")).not.toHaveCount(0);
  await page.locator(".history-list button").filter({ hasText: "Fast-forwarded" }).first().click();
  await expect(position(page)).toHaveValue("50000");
  await shot(page, info, "player");

  // Real decoder time crosses the chapter boundary; no synthetic ended/timeupdate.
  await position(page).fill("29000");
  await page.locator(".sleep-menu summary").click();
  await page.getByRole("button", { name: "End of chapter", exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible({
    timeout: 10000,
  });
  await expect(position(page)).toHaveValue("30000");
  await page.reload();
  await expect(position(page)).toHaveValue("30000");
  await expect(page.getByRole("combobox", { name: /Playback speed/ })).toHaveValue("1.5");

  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page.getByLabel("Tags (comma separated)").fill("Calm, Travel");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toContainText("Saved to this device");
  await page.getByLabel("New collection name").fill("Evening");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Evening" })).toBeChecked();
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unarchive", exact: true })).toBeVisible();
  await shot(page, info, "organization");
  await page.getByRole("button", { name: "Close details" }).click();
  await page.goto("/library");
  await page.getByRole("button", { name: "Archived", exact: true }).click();
  await expect(link).toBeVisible();
  await link.click();
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page.getByRole("button", { name: "Unarchive", exact: true }).click();
  await page.getByRole("button", { name: "Close details" }).click();

  await page.goto("/settings");
  await expect(page.getByText("Lemonade narration", { exact: true })).toHaveCount(0);
  await page.getByRole("combobox", { name: /Skip back/ }).selectOption("10000");
  await page.getByRole("combobox", { name: /Skip forward/ }).selectOption("15000");
  await page.getByRole("checkbox", { name: /Smart rewind/ }).uncheck();
  await page.getByRole("checkbox", { name: /Play the next book/ }).check();
  await page.reload();
  await expect(page.getByRole("combobox", { name: /Skip back/ })).toHaveValue("10000");
  await expect(page.getByRole("checkbox", { name: /Smart rewind/ })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: /Play the next book/ })).toBeChecked();
  await expect(page.getByText("Resume diagnostics", { exact: true })).toBeVisible();
  await shot(page, info, "settings-diagnostics");
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("link", { name: "Export my data" }).click();
  const download = await downloadEvent;
  const exportPath = info.outputPath("metadata-export.json");
  await download.saveAs(exportPath);
  const exported = JSON.parse(readFileSync(exportPath, "utf8"));
  expect(JSON.stringify(exported)).toContain("Objective Chapters");
  expect(JSON.stringify(exported)).toContain("Evening");

  await page.goto("/library");
  await page.getByRole("button", { name: "All", exact: true }).click();
  await chooser(page).setInputFiles("tests/fixtures/transcripts/tiny-book.mp3");
  await page.getByRole("link", { name: "Tiny Fixture Book", exact: true }).click();
  await page.getByRole("button", { name: "Show text", exact: true }).click();
  await expect(page.locator(".transcript-pane")).toBeVisible();
  await shot(page, info, "transcript");
  await page.locator(".transcript-pane button").first().click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(() => page.locator("audio").evaluate((a: HTMLAudioElement) => a.currentTime))
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "Pause", exact: true }).click();

  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page.getByRole("checkbox", { name: "Evening", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Evening", exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Close details" }).click();
  await page.goto(bookUrl!);
  await expect(page.getByText(/Up next in Evening/)).toBeVisible();
  await position(page).fill("89000");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Tiny Fixture Book", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator("audio")
        .evaluate(
          (audio: HTMLAudioElement) => !audio.paused && !audio.seeking && audio.readyState >= 3,
        ),
    )
    .toBe(true);
  // This book already has a saved position. Non-zero time alone could be a
  // restored seek with a stalled decoder; measure advancement from this sample.
  const autoplaySample = await page
    .locator("audio")
    .evaluate((audio: HTMLAudioElement) => audio.currentTime);
  await expect
    .poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.currentTime))
    .toBeGreaterThan(autoplaySample + 0.1);
  const autoplayAdvanced = await page
    .locator("audio")
    .evaluate((audio: HTMLAudioElement) => audio.currentTime);
  expect(autoplayAdvanced).toBeGreaterThan(autoplaySample + 0.1);
  writeFileSync(
    info.outputPath("collection-autoplay.json"),
    JSON.stringify(
      {
        nextBookTitle: await page
          .getByRole("heading", { name: "Tiny Fixture Book", exact: true })
          .textContent(),
        sampledPositionSeconds: autoplaySample,
        advancedPositionSeconds: autoplayAdvanced,
        autoplayQuery: new URL(page.url()).searchParams.get("autoplay"),
      },
      null,
      2,
    ),
  );
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await shot(page, info, "collection-autoplay");

  await page.goto(bookUrl!);
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page.getByRole("button", { name: "Delete this book", exact: true }).click();
  await page.getByRole("button", { name: "Tap again to permanently delete", exact: true }).click();
  await expect(page).toHaveURL(/\/library/);
  await expect(link).toHaveCount(0);
  await page.goto("/settings");
  await page.getByLabel("Type your email to confirm").fill(account.email);
  await page.getByLabel("Current password").fill(account.password);
  await page.getByRole("button", { name: "Delete my account", exact: true }).click();
  await expect(page).toHaveURL(/\/register/, { timeout: 30000 });
  await shot(page, info, "account-deleted");
});

function documentFiles() {
  const text = "A calm voice reads this book.";
  const zip = (entries: Record<string, string>) =>
    Buffer.from(
      zipSync(
        Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, strToU8(value)])),
      ),
    );
  // Minimal selectable-text PDF with explicit offsets, generated as a fixture.
  const stream = `BT /F1 12 Tf 30 100 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return [
    { name: "Objective TXT.txt", mimeType: "text/plain", buffer: Buffer.from(text) },
    {
      name: "Objective Markdown.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(`# Opening\n\n${text}`),
    },
    {
      name: "Objective HTML.html",
      mimeType: "text/html",
      buffer: Buffer.from(`<html><body><h1>Opening</h1><p>${text}</p></body></html>`),
    },
    { name: "Objective PDF.pdf", mimeType: "application/pdf", buffer: Buffer.from(pdf) },
    {
      name: "Objective DOCX.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: zip({
        "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
      }),
    },
    {
      name: "Objective EPUB.epub",
      mimeType: "application/epub+zip",
      buffer: zip({
        mimetype: "application/epub+zip",
        "META-INF/container.xml":
          '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
        "book.opf":
          '<package><metadata><title>Objective EPUB</title></metadata><manifest><item id="one" href="one.xhtml"/></manifest><spine><itemref idref="one"/></spine></package>',
        "one.xhtml": `<html><body><p>${text}</p></body></html>`,
      }),
    },
  ];
}

test("real document formats finish before playback, cancel safely and preserve legacy identities", async ({
  page,
  context,
}, info) => {
  test.setTimeout(300000);
  const wire: Array<{ method: string; url: string; body: Buffer }> = [];
  const net = await startControllableNetwork(
    process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000",
    (request) => wire.push(request),
  );
  const browserRequests: string[] = [];
  // Start before authentication. Cross-origin coverage is limited to events
  // Playwright exposes: WebKit can omit Blob bodies and worker requests.
  // privacy-transport.spec.ts measures those gaps with loopback wire controls.
  context.on("request", (request) => {
    browserRequests.push(request.url(), request.postDataBuffer()?.toString("utf8") ?? "");
  });
  try {
    const account = await openAccount(page, net.origin);
    // Real GET/POST requests against a read-only endpoint prove URL and raw-body
    // capture, including transports WebKit's postData() cannot reliably expose.
    await page.evaluate(async () => {
      await fetch(`/api/sync/pull?privacy_control=${encodeURIComponent("privacy positive url")}`);
      const form = new FormData();
      form.append("control", "privacy-positive-multipart");
      for (const body of [
        JSON.stringify({ control: "privacy-positive-json" }),
        new Blob(["privacy-positive-blob"]),
        form,
      ]) {
        await fetch("/api/sync/pull", { method: "POST", body });
      }
      if (!navigator.sendBeacon("/api/sync/pull", "privacy-positive-beacon")) {
        throw new Error("Privacy positive-control beacon was not queued");
      }
    });
    await expect
      .poll(() => wire.some((request) => request.body.includes("privacy-positive-beacon")))
      .toBe(true);
    expect(
      wire.some(
        (request) =>
          request.method === "GET" &&
          decodeURIComponent(request.url).includes("privacy positive url"),
      ),
    ).toBe(true);
    for (const kind of ["json", "blob", "multipart", "beacon"]) {
      expect(
        wire.some((request) => request.body.includes(`privacy-positive-${kind}`)),
        `${kind} positive control reached the socket`,
      ).toBe(true);
    }
    await chooser(page).setInputFiles({
      name: "cancel.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("A long book to cancel. ".repeat(1000)),
    });
    await expect(page.getByRole("button", { name: "Cancel import", exact: true })).toBeVisible();
    await expect(page.locator(".narrating-book [role=status]")).toContainText("Narrating chapter", {
      timeout: 120000,
    });
    await expect(page.locator(".narrating-book a")).toHaveCount(0);
    await expect(page.locator("article.book-item")).toHaveCount(0);
    await shot(page, info, "narration-cancel");
    await page.getByRole("button", { name: "Cancel import", exact: true }).click();
    await expect(page.locator(".narrating-book")).toHaveCount(0);
    await expect(page.locator('[data-launch-ready="empty"]')).toBeVisible();

    const timings: Array<{ name: string; ms: number }> = [];
    for (const [index, file] of documentFiles().entries()) {
      await test.step(`real local narration: ${file.name}`, async () => {
        const start = Date.now();
        await chooser(page).setInputFiles(file);
        await expect(page.locator(".narrating-book")).toBeVisible();
        await expect(page.locator(".narrating-book a")).toHaveCount(0);
        await expect(page.locator("article.book-item")).toHaveCount(index);
        await expect(page.locator("article.book-item")).toHaveCount(index + 1, { timeout: 120000 });
        timings.push({ name: file.name, ms: Date.now() - start });
      });
    }
    writeFileSync(info.outputPath("narration-times.json"), JSON.stringify(timings, null, 2));
    const captured = [
      ...browserRequests,
      ...wire.flatMap((request) => [request.url, request.body.toString("utf8")]),
    ];
    for (const value of captured) {
      expect(value).not.toContain("A calm voice reads this book");
      // A GET could percent-encode the source; inspect decoded content as well.
      let decoded = value;
      try {
        decoded = decodeURIComponent(value.replaceAll("+", " "));
      } catch {
        /* Raw binary bodies need not be URI encoded. */
      }
      expect(decoded).not.toContain("A calm voice reads this book");
    }
    writeFileSync(
      info.outputPath("privacy-capture.json"),
      JSON.stringify(
        {
          browserObservations: browserRequests.length,
          wireRequests: wire.length,
          wireBodies: wire.filter((request) => request.body.length > 0).length,
          positiveControls: ["GET query", "JSON", "Blob", "multipart", "sendBeacon"],
          documentTextFound: false,
          scope:
            "App-origin wire URLs/bodies plus browser-exposed URLs/bodies; no claim for arbitrary cross-origin Blob or service-worker traffic, encoded/encrypted payloads or binary audio.",
        },
        null,
        2,
      ),
    );
    await shot(page, info, "six-document-formats");
    const txt = page.getByRole("link", { name: "Objective TXT", exact: true });
    const href = await txt.getAttribute("href");
    await txt.click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect
      .poll(() => page.locator("audio").evaluate((a: HTMLAudioElement) => a.currentTime))
      .toBeGreaterThan(0);
    await page.getByRole("button", { name: "Pause", exact: true }).click();

    // Migration fixture only: relabel this disposable completed rendition as
    // legacy metadata. This is not a claim to have run the removed engine.
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const [owner] = await sql`select id from "user" where email=${account.email}`;
      const bookId = href!.split("/").pop()!;
      const before = await sql`select * from chapters where book_id=${bookId} order by position`;
      await sql`update media_assets set rendition_key=replace(rendition_key,'kestrel-fast-v1','lemonade-kokoro-v1') where book_id=${bookId} and owner_id=${owner!.id}`;
      await page.goto(`${net.origin}${href!}`);
      await page.getByRole("button", { name: "Play", exact: true }).click();
      await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await page.goto(`${net.origin}/library`);
      await page
        .getByRole("button", { name: "Remove download of Objective TXT", exact: true })
        .click();
      await expect(page.locator("article.book-item", { hasText: "Objective TXT" })).toContainText(
        "Not on this device",
      );
      await page.goto(`${net.origin}${href!}`);
      await expect(
        page.getByText(/This saved narration was made with an older engine/),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Attach document", exact: true }),
      ).toBeDisabled();
      await shot(page, info, "legacy-rendition-refused");
      expect(await sql`select * from chapters where book_id=${bookId} order by position`).toEqual(
        before,
      );
      const [media] = await sql`select rendition_key from media_assets where book_id=${bookId}`;
      expect(media!.rendition_key).toMatch(/^lemonade-kokoro-v1:/);
    } finally {
      await sql.end();
    }
  } finally {
    await net.close();
  }
});

test("library filters include committed edits from another tab", async ({
  page,
  context,
}, info) => {
  await openAccount(page);
  await chooser(page).setInputFiles("tests/fixtures/Downloads/Chapterline-iPhone-Test.mp3");
  const title = "iPhone Downloads Test";
  await page.getByRole("link", { name: title, exact: true }).click();
  const library = await context.newPage();
  await library.goto("/library");
  await expect(library.getByRole("link", { name: title, exact: true })).toBeVisible();
  // Let the normal post-paint pull settle before the edit, otherwise that pull
  // can accidentally refresh a stale cache and make this regression vacuous.
  await library.waitForTimeout(2000);
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page.getByLabel("Tags (comma separated)").fill("Updated");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toContainText("Saved to this device");
  await library.getByRole("searchbox", { name: "Search your library" }).fill("Updated");
  await expect(library.getByRole("link", { name: title, exact: true })).toBeVisible();
  await shot(library, info, "filter-after-another-tab-edit");
  await library.close();
});

test("first sync distinguishes loading and unreachable from an empty library and recovers", async ({
  page,
}, info) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(15000);
  const net = await startControllableNetwork(
    process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000",
  );
  const held = net.holdNextResponse("GET", "/api/sync/pull");
  try {
    await openAccount(page, net.origin, false);
    expect(await held.upstreamStatus).toBe(200);
    await expect(page.getByRole("heading", { name: "Setting up your library" })).toBeVisible();
    await expect(page.locator("[data-launch-ready]")).toHaveCount(0);
    await shot(page, info, "first-sync-loading");
    await expect(page.getByText(/This one is taking longer than usual/)).toBeVisible({
      timeout: 10000,
    });
    net.cut();
    held.release();
    await expect(
      page.getByRole("heading", { name: "This device has not seen your library yet" }),
    ).toBeVisible();
    await expect(page.locator("[data-launch-ready]")).toHaveCount(0);
    await shot(page, info, "first-sync-unreachable");
    net.restore();
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.locator('[data-launch-ready="empty"]')).toBeVisible();
    await shot(page, info, "first-sync-recovered");

    // Hold an actual successful sync response at the socket, below the worker.
    // A completed local import must not wait for this subsequent sync response.
    const pendingPull = net.holdNextResponse("GET", "/api/sync/pull");
    try {
      await chooser(page).setInputFiles("tests/fixtures/Downloads/Chapterline-iPhone-Test.mp3");
      expect(await pendingPull.upstreamStatus).toBe(200);
      await expect(
        page.getByRole("link", { name: "iPhone Downloads Test", exact: true }),
      ).toBeVisible({ timeout: 5000 });
      await expect(page.locator(".narrating-book")).toHaveCount(0);
      await shot(page, info, "import-while-sync-stalled");
    } finally {
      pendingPull.release();
    }
  } finally {
    held.release();
    await net.close();
  }
});

test("cancelling after a real media commit recognizes the attachment and suppresses autoplay", async ({
  page,
}, info) => {
  await openAccount(page);
  const source = "tests/fixtures/Downloads/Chapterline-iPhone-Test.mp3";
  const title = "iPhone Downloads Test";
  await chooser(page).setInputFiles(source);
  const link = page.getByRole("link", { name: title, exact: true });
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  await page.getByRole("button", { name: `Remove download of ${title}`, exact: true }).click();
  await expect(page.locator("article.book-item", { hasText: title })).toContainText(
    "Not on this device",
  );
  await page.goto(`${href!}?autoplay=1`);
  await expect(page.getByRole("button", { name: "Attach MP3", exact: true })).toBeVisible();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // Page-wide prototype wrappers delegate to real IDBObjectStore.put and
  // BroadcastChannel.postMessage. The first observes transaction completion;
  // the second clicks Cancel in the post-commit/pre-promise-return microtask
  // window and restores both originals. This makes a race deterministic, not
  // a claim that an unaided human click can hit that window. No fake media.
  await page.evaluate((bookId) => {
    const evidence = { cancelled: false, committedUrl: "", playCalls: 0 };
    Object.assign(window, { attachmentCancellation: evidence });
    // Delegates every actual play() invocation, including rejected attempts;
    // paused alone could hide an autoplay attempt blocked by browser policy.
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      evidence.playCalls += 1;
      return play.call(this);
    };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      const request = put.call(this, value, key);
      if (this.name === "downloads" && value.book?.id === bookId && value.offlineMediaUrl) {
        this.transaction.addEventListener(
          "complete",
          () => {
            evidence.committedUrl = value.offlineMediaUrl;
          },
          { once: true },
        );
      }
      return request;
    };
    const postMessage = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (message) {
      if (
        this.name === "chapterline:library-changed" &&
        evidence.committedUrl &&
        !evidence.cancelled
      ) {
        const cancel = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent?.trim() === "Cancel attachment",
        );
        if (cancel) {
          evidence.cancelled = true;
          cancel.click();
          IDBObjectStore.prototype.put = put;
          BroadcastChannel.prototype.postMessage = postMessage;
        }
      }
      return postMessage.call(this, message);
    };
  }, href!.split("/").pop()!);
  await page.locator('.local-media-gate input[type="file"]').setInputFiles(source);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { attachmentCancellation: { cancelled: boolean } })
            .attachmentCancellation.cancelled,
      ),
    )
    .toBe(true);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Attach MP3", exact: true })).toHaveCount(0);
  await expect
    .poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.readyState))
    .toBeGreaterThanOrEqual(1); // preload="metadata" does not promise decoded data before Play.
  const evidence = await page.evaluate(async () => {
    const attachment = (
      window as unknown as {
        attachmentCancellation: { cancelled: boolean; committedUrl: string; playCalls: number };
      }
    ).attachmentCancellation;
    const { cancelled, committedUrl } = attachment;
    const response = await fetch(committedUrl, { headers: { Range: "bytes=0-1023" } });
    return {
      cancelled,
      mediaStatus: response.status,
      mediaBytes: (await response.arrayBuffer()).byteLength,
      playerUsesCommittedMedia:
        document.querySelector("audio")?.getAttribute("src") === committedUrl,
      pausedAfterCancel: document.querySelector("audio")?.paused,
      timeAfterCancel: document.querySelector("audio")?.currentTime,
      playCallsAfterCancel: attachment.playCalls,
    };
  });
  expect(evidence.mediaStatus).toBe(206);
  expect(evidence.mediaBytes).toBe(1024);
  expect(evidence.playerUsesCommittedMedia).toBe(true);
  expect(evidence.pausedAfterCancel).toBe(true);
  expect(evidence.timeAfterCancel).toBe(0);
  expect(evidence.playCallsAfterCancel).toBe(0);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.currentTime))
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const playCallsAfterManualPlay = await page.evaluate(
    () =>
      (window as unknown as { attachmentCancellation: { playCalls: number } })
        .attachmentCancellation.playCalls,
  );
  expect(playCallsAfterManualPlay).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
  await shot(page, info, "committed-attachment-after-cancel");
  writeFileSync(
    info.outputPath("committed-attachment.json"),
    JSON.stringify({ ...evidence, playCallsAfterManualPlay }, null, 2),
  );
});

test("retained database password mismatch fails before fixture reset and correct credentials still work", async ({
  page,
  context,
}, info) => {
  await openAccount(page);
  await chooser(page).setInputFiles("tests/fixtures/Downloads/Chapterline-iPhone-Test.mp3");
  await expect(
    page.getByRole("link", { name: "iPhone Downloads Test", exact: true }),
  ).toBeVisible();
  const password = testAccountPassword("retained-workflows");
  const existing = await findRetainedAccount(password);
  expect(existing).toBeTruthy();
  await expect
    .poll(async () => (await sql()`select id from books where owner_id=${existing!.id}`).length)
    .toBe(1);
  const before = await sql()`select id from books where owner_id=${existing!.id} order by id`;
  // Model regenerating .env.test against a retained DB without changing any
  // actual credential, environment file or database record. Never persist it.
  const mismatchedPassword = crypto.randomUUID();
  await retainedBudget("sign-in");
  const rejectedStatus = await page.evaluate(
    async (credentials) =>
      (
        await fetch("/api/auth/sign-in/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(credentials),
        })
      ).status,
    { email: RETAINED_EMAIL, password: mismatchedPassword },
  );
  expect(rejectedStatus).toBe(401);
  const rejected: unknown = await findRetainedAccount(mismatchedPassword).catch(
    (error: unknown) => error,
  );
  expect(rejected instanceof Error).toBe(true);
  const diagnostic = (rejected as Error).message;
  // Compare the actual rejection exactly. Boolean assertions also keep an
  // accidentally appended credential out of failure diffs and persisted logs.
  expect(diagnostic.includes(mismatchedPassword), "Diagnostic leaked attempted credential").toBe(
    false,
  );
  expect(diagnostic === RETAINED_CREDENTIAL_DIAGNOSTIC, "Unexpected credential diagnostic").toBe(
    true,
  );
  const after = await sql()`select id from books where owner_id=${existing!.id} order by id`;
  expect(after).toEqual(before);
  await context.clearCookies();
  await retainedBudget("sign-in");
  await page.goto("/login");
  await page.getByLabel("Email").fill(RETAINED_EMAIL);
  await page.getByLabel(/Password/).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/library/);
  await expect(page.locator("article.book-item")).toHaveCount(before.length);
  writeFileSync(
    info.outputPath("credential-mismatch.json"),
    JSON.stringify(
      {
        mismatchHttpStatus: rejectedStatus,
        actionableDiagnostic: diagnostic,
        fixtureBooksBefore: before.length,
        fixtureBooksAfter: after.length,
        originalCredentialsStillWork: true,
        credentialOrLibraryResetOnMismatch: false,
      },
      null,
      2,
    ),
  );
});
