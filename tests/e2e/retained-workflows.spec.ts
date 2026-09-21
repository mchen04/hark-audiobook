import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { zipSync, strToU8 } from "fflate";
import postgres from "postgres";
import { startControllableNetwork } from "../parity/harness/network";

test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.111" } });

async function register(page: Page, prefix: string) {
  page.setDefaultTimeout(15000);
  const email = `${prefix}-${Date.now()}@hark.test`;
  const password = `Disposable-${Date.now()}!`;
  await page.goto("/register");
  await page.getByLabel("Name").fill("Disposable workflow account");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel(/Password/).fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.locator('[data-launch-ready="empty"]')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  return { email, password };
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
  const account = await register(page, "retained");
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
  await position(page).fill("89500");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Tiny Fixture Book", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
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
  const account = await register(page, "documents");
  const sentBodies: string[] = [];
  context.on("request", (request) => {
    if (request.method() !== "GET") sentBodies.push(request.postData() ?? "");
  });
  await chooser(page).setInputFiles({
    name: "cancel.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("A long book to cancel. ".repeat(1000)),
  });
  await expect(page.getByRole("button", { name: "Cancel import", exact: true })).toBeVisible();
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
  expect(sentBodies.join("\n")).not.toContain("A calm voice reads this book");
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
    await page.goto(href!);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.goto("/library");
    await page
      .getByRole("button", { name: "Remove download of Objective TXT", exact: true })
      .click();
    await expect(page.locator("article.book-item", { hasText: "Objective TXT" })).toContainText(
      "Not on this device",
    );
    await page.goto(href!);
    await expect(
      page.getByText(/This saved narration was made with an older engine/),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Attach document", exact: true })).toBeDisabled();
    await shot(page, info, "legacy-rendition-refused");
    expect(await sql`select * from chapters where book_id=${bookId} order by position`).toEqual(
      before,
    );
    const [media] = await sql`select rendition_key from media_assets where book_id=${bookId}`;
    expect(media!.rendition_key).toMatch(/^lemonade-kokoro-v1:/);
  } finally {
    await sql.end();
  }
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
    await page.goto(`${net.origin}/register`);
    await page.getByLabel("Name").fill("Disposable loading state");
    await page.getByLabel("Email").fill(`loading-${Date.now()}@hark.test`);
    await page.getByLabel(/Password/).fill(`Loading-state-${Date.now()}!`);
    await page.getByRole("button", { name: "Create account" }).click();
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
