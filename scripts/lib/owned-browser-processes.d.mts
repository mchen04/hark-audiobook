export type RenderEngine = "webkit" | "chromium";
export type BrowserProcess = {
  pid: number;
  parent: number;
  rssKiB: number;
  executable: string;
  responsible?: number;
};
export type OwnershipOptions = {
  engine: RenderEngine;
  executable: string;
  mainPid?: number;
  requireRenderer?: boolean;
};
export type Ownership = {
  status: string;
  mains: BrowserProcess[];
  processes: BrowserProcess[];
  renderers: BrowserProcess[];
  reason: string;
};
export function isRendererCommand(
  command: string,
  engine: RenderEngine,
  executable: string,
): boolean;
export function processSnapshot(): BrowserProcess[];
export function attributeBrowserProcesses(
  options: OwnershipOptions & {
    processes: BrowserProcess[];
    nodePid: number;
    platform: string;
  },
): Ownership;
export function ownedBrowserProcesses(options: OwnershipOptions): Ownership;
