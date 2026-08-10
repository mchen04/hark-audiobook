import path from "node:path";

export type RenderEngine = "webkit" | "chromium";

/** Recognises a renderer without matching another installed browser build. */
export function isRendererCommand(
  command: string,
  engine: RenderEngine,
  browserExecutable: string,
): boolean {
  if (engine === "chromium") {
    return command.includes(browserExecutable) && command.includes("--type=renderer");
  }

  const buildDirectory = path.dirname(browserExecutable);
  if (!command.includes(buildDirectory)) return false;
  return ["com.apple.WebKit.WebContent", "WebKitWebProcess", "WPEWebProcess"].some((name) =>
    command.includes(name),
  );
}
