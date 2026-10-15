import { execFileSync } from "node:child_process";
import path from "node:path";

export function isRendererCommand(command, engine, executable) {
  if (engine === "chromium")
    return command.includes(browserBuild(executable)) && command.includes("--type=renderer");
  return (
    command.includes(browserBuild(executable)) &&
    ["com.apple.WebKit.WebContent", "WebKitWebProcess", "WPEWebProcess"].some((name) =>
      command.includes(name),
    )
  );
}

function browserBuild(executable) {
  const app = executable.indexOf(".app/");
  return app < 0 ? path.dirname(executable) : executable.slice(0, app + 4);
}

export function processSnapshot() {
  return execFileSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,rss=,command="], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      return match
        ? [{ pid: +match[1], parent: +match[2], rssKiB: +match[3], executable: match[4] }]
        : [];
    });
}

export function attributeBrowserProcesses({
  processes,
  engine,
  executable,
  nodePid,
  platform,
  mainPid,
  requireRenderer,
}) {
  const table = new Map(processes.map((entry) => [entry.pid, entry]));
  const descends = (pid, ancestor) => {
    const seen = new Set();
    while (pid && !seen.has(pid)) {
      if (pid === ancestor) return true;
      seen.add(pid);
      pid = table.get(pid)?.parent;
    }
    return false;
  };
  const candidates = processes.filter((entry) =>
    entry.executable.includes(browserBuild(executable)),
  );
  const mains = candidates.filter(({ executable: command }) =>
    engine === "chromium"
      ? (command === executable || command.startsWith(`${executable} `)) &&
        !command.includes("--type=")
      : /\/(?:Playwright|MiniBrowser|WPEWebKitMiniBrowser)(?:\s|$)/.test(command),
  );
  const owned = mains.filter(
    (entry) => descends(entry.pid, nodePid) && (!mainPid || entry.pid === mainPid),
  );
  const result = { status: "owned", mains: owned, processes: [], renderers: [], reason: "" };
  if (!owned.length)
    return { ...result, status: "missing", reason: "No owned browser main process" };
  if (platform === "darwin") {
    for (const main of owned) {
      if (
        !(main.responsible > 0) ||
        (main.responsible !== main.pid &&
          mains.some((other) => other.pid !== main.pid && other.responsible === main.responsible))
      )
        return {
          ...result,
          status: "ambiguous",
          reason: `Ambiguous browser ownership: main PID ${main.pid}, responsible PID ${main.responsible}`,
        };
    }
  }
  result.processes = candidates.filter((entry) =>
    owned.some((main) =>
      platform === "darwin"
        ? entry.pid === main.pid || entry.responsible === main.responsible
        : descends(entry.pid, main.pid),
    ),
  );
  result.renderers = result.processes.filter((entry) =>
    isRendererCommand(entry.executable, engine, executable),
  );
  if (requireRenderer !== false && !result.renderers.length)
    return {
      ...result,
      status: "missing",
      processes: [],
      reason: `No owned ${engine} renderer exists; refusing process attribution`,
    };
  return result;
}

export function ownedBrowserProcesses(options) {
  const processes = processSnapshot();
  if (process.platform === "darwin") {
    const pids = processes
      .filter((entry) => entry.executable.includes(browserBuild(options.executable)))
      .map((entry) => entry.pid);
    const responsible = JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          "import ctypes,json,sys; f=ctypes.CDLL(None).responsibility_get_pid_responsible_for_pid; f.argtypes=[ctypes.c_int]; f.restype=ctypes.c_int; print(json.dumps({p:f(p) for p in json.load(sys.stdin)}))",
        ],
        { input: JSON.stringify(pids), encoding: "utf8" },
      ),
    );
    for (const entry of processes) entry.responsible = responsible[entry.pid];
  }
  const result = attributeBrowserProcesses({
    ...options,
    processes,
    nodePid: process.pid,
    platform: process.platform,
  });
  if (result.status !== "owned") throw new Error(result.reason);
  return result;
}
