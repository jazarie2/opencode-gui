import { contextBridge, ipcRenderer } from "electron"

export interface ElectronAPI {
  selectFolder: () => Promise<string | null>
  createInstance: (
    id: string,
    folder: string,
    binaryPath?: string,
    environmentVariables?: Record<string, string>,
  ) => Promise<{ id: string; port: number; pid: number; binaryPath: string }>
  stopInstance: (pid: number) => Promise<void>
  onInstanceStarted: (callback: (data: { id: string; port: number; pid: number; binaryPath: string }) => void) => void
  onInstanceError: (callback: (data: { id: string; error: string }) => void) => void
  onInstanceStopped: (callback: (data: { id: string }) => void) => void
  onInstanceLog: (
    callback: (data: {
      id: string
      entry: { timestamp: number; level: "info" | "error" | "warn" | "debug"; message: string }
    }) => void,
  ) => void
  onNewInstance: (callback: () => void) => void
  scanDirectory: (workspaceFolder: string) => Promise<string[]>
  // OpenCode binary operations
  selectOpenCodeBinary: () => Promise<string | null>
  validateOpenCodeBinary: (path: string) => Promise<{ valid: boolean; version?: string; error?: string }>
  downloadOpenCode: () => Promise<{ success: boolean; path?: string; error?: string }>
  onDownloadProgress: (callback: (progress: number) => void) => () => void
  onDownloadLog: (callback: (message: string) => void) => () => void
  // Storage operations
  getConfigPath: () => Promise<string>
  getInstancesDir: () => Promise<string>
  readConfigFile: () => Promise<string>
  writeConfigFile: (content: string) => Promise<void>
  readInstanceFile: (instanceId: string) => Promise<string>
  writeInstanceFile: (instanceId: string, content: string) => Promise<void>
  deleteInstanceFile: (instanceId: string) => Promise<void>
  onConfigChanged: (callback: () => void) => () => void
}

const electronAPI: ElectronAPI = {
  selectFolder: () => ipcRenderer.invoke("dialog:selectFolder"),
  createInstance: (id: string, folder: string, binaryPath?: string, environmentVariables?: Record<string, string>) =>
    ipcRenderer.invoke("instance:create", id, folder, binaryPath, environmentVariables),
  stopInstance: (pid: number) => ipcRenderer.invoke("instance:stop", pid),
  onInstanceStarted: (callback) => {
    ipcRenderer.on("instance:started", (_, data) => callback(data))
  },
  onInstanceError: (callback) => {
    ipcRenderer.on("instance:error", (_, data) => callback(data))
  },
  onInstanceStopped: (callback) => {
    ipcRenderer.on("instance:stopped", (_, data) => callback(data))
  },
  onInstanceLog: (callback) => {
    ipcRenderer.on("instance:log", (_, data) => callback(data))
  },
  onNewInstance: (callback) => {
    ipcRenderer.on("menu:newInstance", () => callback())
  },
  scanDirectory: (workspaceFolder: string) => ipcRenderer.invoke("fs:scanDirectory", workspaceFolder),
  // OpenCode binary operations
  selectOpenCodeBinary: () => ipcRenderer.invoke("dialog:selectOpenCodeBinary"),
  validateOpenCodeBinary: (path: string) => ipcRenderer.invoke("opencode:validateBinary", path),
  downloadOpenCode: () => ipcRenderer.invoke("opencode:download"),
  onDownloadProgress: (callback: (progress: number) => void) => {
    ipcRenderer.on("opencode:download-progress", (_, progress) => callback(progress))
    return () => ipcRenderer.removeAllListeners("opencode:download-progress")
  },
  onDownloadLog: (callback: (message: string) => void) => {
    ipcRenderer.on("opencode:download-log", (_, message) => callback(message))
    return () => ipcRenderer.removeAllListeners("opencode:download-log")
  },
  // Storage operations
  getConfigPath: () => ipcRenderer.invoke("storage:getConfigPath"),
  getInstancesDir: () => ipcRenderer.invoke("storage:getInstancesDir"),
  readConfigFile: () => ipcRenderer.invoke("storage:readConfigFile"),
  writeConfigFile: (content: string) => ipcRenderer.invoke("storage:writeConfigFile", content),
  readInstanceFile: (filename: string) => ipcRenderer.invoke("storage:readInstanceFile", filename),
  writeInstanceFile: (filename: string, content: string) =>
    ipcRenderer.invoke("storage:writeInstanceFile", filename, content),
  deleteInstanceFile: (filename: string) => ipcRenderer.invoke("storage:deleteInstanceFile", filename),
  onConfigChanged: (callback: () => void) => {
    ipcRenderer.on("storage:configChanged", () => callback())
    return () => ipcRenderer.removeAllListeners("storage:configChanged")
  },
}

contextBridge.exposeInMainWorld("electronAPI", electronAPI)

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
