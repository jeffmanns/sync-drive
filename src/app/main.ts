import { watch } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { exclusionsFileBeside } from "../engine/index.ts";
import { MacFileCopier } from "../macos/file-copier.ts";
import { MacItemCounter } from "../macos/item-counter.ts";
import { MacRemounter } from "../macos/remounter.ts";
import { MacVolumes } from "../macos/volume-identity.ts";
import { Flow } from "./flow.ts";
import { updateLogFolderBeside } from "./update-log.ts";
import { throttleProgress } from "./throttle.ts";
import { CHANNELS, type Action } from "./view.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCREENS = join(HERE, "renderer", "index.html");

/** Where the Pairing is stored. The smoke test points it elsewhere. */
const PAIRING_FILE =
  process.env.SYNC_DRIVE_PAIRING_FILE ?? join(homedir(), "Library", "Application Support", "sync-drive", "pairing.json");

/** Where the Exclusions are stored: beside the Pairing. */
const EXCLUSIONS_FILE = exclusionsFileBeside(PAIRING_FILE);

/** How often, at most, progress is sent to the screens: often enough to look smooth, rarely enough to stay cheap. */
const PROGRESS_EVERY_MS = 100;

/** Where macOS mounts drives. A change here is a drive connecting or disconnecting. */
const VOLUMES = "/Volumes";

const flow = new Flow({
  volumes: new MacVolumes(),
  pairingFile: PAIRING_FILE,
  exclusionsFile: EXCLUSIONS_FILE,
  updateLogFolder: updateLogFolderBeside(PAIRING_FILE),
  copier: new MacFileCopier(),
  remounter: new MacRemounter(),
  itemCounter: new MacItemCounter(),
});

app.on("web-contents-created", (_event, contents) => {
  // The app shows only its own screens: no new windows, and no navigating away.
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
});

app.on("window-all-closed", () => app.quit());

let quitHeldForUpdate = false;
app.on("before-quit", (event) => {
  // Quitting during an Update must not leave the Primary read-only: stop the Update, and remount it normally, first.
  if (quitHeldForUpdate) return;
  quitHeldForUpdate = true;
  event.preventDefault();
  void flow.quit().finally(() => app.quit());
});

app.whenReady().then(start, (error: unknown) => {
  dialog.showErrorBox("sync-drive could not start", String(error));
  app.quit();
});

/** Opens the flow and its window. Not awaited at the top level, so the module finishes loading before Electron is ready. */
async function start(): Promise<void> {
  await flow.open();
  const window = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    title: "sync-drive",
    webPreferences: {
      preload: join(HERE, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  ipcMain.handle(CHANNELS.state, (event) => {
    assertFromScreens(event);
    return flow.state;
  });
  ipcMain.handle(CHANNELS.action, async (event, action: Action) => {
    assertFromScreens(event);
    await perform(action, window);
  });
  flow.onChange(
    throttleProgress((state) => {
      if (!window.isDestroyed()) window.webContents.send(CHANNELS.state, state);
    }, PROGRESS_EVERY_MS),
  );
  watchDrives();
  await window.loadFile(SCREENS);
}

/** Carries out what a screen asked for. */
async function perform(action: Action, window: BrowserWindow): Promise<void> {
  switch (action.type) {
    case "choose":
      return chooseDrive(action.role, window);
    case "pair":
      return flow.pair();
    case "beginRepair":
      return flow.beginRepair();
    case "confirmReplace":
      return flow.confirmReplace(action.confirmed === true);
    case "cancelRepair":
      return flow.cancelRepair();
    case "compare":
      return flow.compare();
    case "addExclusion":
      return flow.addExclusion(String(action.typed));
    case "removeExclusion":
      return flow.removeExclusion(String(action.pattern));
    case "chooseOnlyFolder":
      return chooseOnlyFolder(window);
    case "wholeDrive":
      return flow.wholeDrive();
    case "deepVerify":
      return flow.deepVerify(action.on === true);
    case "overrideSafetyStop":
      return flow.overrideSafetyStop(String(action.typed));
    case "approveCopies":
      return flow.approveCopies(action.approved === true);
    case "approveMoves":
      return flow.approveMoves(action.approved === true);
    case "chooseForMismatch":
      return flow.chooseForMismatch(String(action.path), action.choice);
    case "approveDeletions":
      return flow.approveDeletions(action.approved === true);
    case "next":
      return flow.next();
    case "back":
      return flow.back();
    case "restart":
      return flow.restart();
    case "apply":
      return flow.apply();
  }
}

/** Asks for the top level of the drive for `role`, starting in /Volumes. */
async function chooseDrive(role: "primary" | "replica", window: BrowserWindow): Promise<void> {
  if (role !== "primary" && role !== "replica") return;
  const chosen = await dialog.showOpenDialog(window, {
    title: role === "primary" ? "Choose the Primary" : "Choose the Replica",
    message: `Choose the top level of the ${role === "primary" ? "Primary" : "Replica"} drive.`,
    defaultPath: VOLUMES,
    properties: ["openDirectory"],
  });
  const path = chosen.filePaths[0];
  if (!chosen.canceled && path !== undefined) flow.choose(role, path);
}

/** Asks for the folder on the Primary to limit the run to, starting at the top of the Primary. */
async function chooseOnlyFolder(window: BrowserWindow): Promise<void> {
  const top = await flow.primaryTop();
  const chosen = await dialog.showOpenDialog(window, {
    title: "Choose a folder on the Primary",
    message: "Choose the folder on the Primary to compare and update. Nothing outside it is touched.",
    defaultPath: top ?? VOLUMES,
    properties: ["openDirectory"],
  });
  const path = chosen.filePaths[0];
  if (!chosen.canceled && path !== undefined) await flow.limitTo(path);
}

/** Tells the flow whenever a drive connects or disconnects, so a stale comparison is discarded. */
function watchDrives(): void {
  let pending: NodeJS.Timeout | undefined;
  const watcher = watch(VOLUMES, () => {
    // Mounting changes /Volumes in bursts; check once it settles.
    clearTimeout(pending);
    pending = setTimeout(() => void flow.drivesChanged(), 500);
  });
  app.on("will-quit", () => watcher.close());
}

/** Rejects IPC from anything but the app's own screens. */
function assertFromScreens(event: IpcMainInvokeEvent): void {
  if (event.senderFrame?.url !== pathToFileURL(SCREENS).href) {
    throw new Error("sync-drive only answers its own screens");
  }
}
