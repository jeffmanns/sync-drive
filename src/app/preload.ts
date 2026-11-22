/**
 * Gives the screens `window.syncDrive`, and nothing else from Electron or Node. Bundled to
 * CommonJS by esbuild, as Electron's sandboxed preload scripts must be.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { CHANNELS, type Action, type FlowState, type SyncDriveBridge } from "./view.ts";

const bridge: SyncDriveBridge = {
  state: () => ipcRenderer.invoke(CHANNELS.state) as Promise<FlowState>,
  send: async (action: Action) => {
    await ipcRenderer.invoke(CHANNELS.action, action);
  },
  onState: (listener) => {
    const relay = (_event: IpcRendererEvent, state: FlowState) => listener(state);
    ipcRenderer.on(CHANNELS.state, relay);
    return () => void ipcRenderer.off(CHANNELS.state, relay);
  },
};

contextBridge.exposeInMainWorld("syncDrive", bridge);
