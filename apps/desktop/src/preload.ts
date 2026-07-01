import { contextBridge } from "electron";

// Minimal, secure bridge exposed to the renderer as `window.loose`.
// Placeholder for future native capabilities (notifications, file dialogs, etc.).
const looseApi = {
  platform: process.platform,
} as const;

contextBridge.exposeInMainWorld("loose", looseApi);

export type LooseApi = typeof looseApi;
