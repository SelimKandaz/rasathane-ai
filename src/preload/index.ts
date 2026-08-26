import { contextBridge, ipcRenderer } from "electron";

import type { RasathaneAPI, RasathaneSettings, RasathaneTaskMode } from "../shared/types";

const api: RasathaneAPI = {
  getAppStatus: () => ipcRenderer.invoke("getAppStatus"),
  getSettings: () => ipcRenderer.invoke("getSettings"),
  setSettings: (settings: Partial<RasathaneSettings>) =>
    ipcRenderer.invoke("setSettings", settings),
  listModels: () => ipcRenderer.invoke("listModels"),
  selectModel: (id: string) => ipcRenderer.invoke("selectModel", id),
  selectTextModel: (id: string) => ipcRenderer.invoke("selectTextModel", id),
  selectVisionModel: (id: string) => ipcRenderer.invoke("selectVisionModel", id),
  getConversations: () => ipcRenderer.invoke("getConversations"),
  sendMessage: (conversationId: string, content: string, taskMode?: RasathaneTaskMode) =>
    ipcRenderer.invoke("sendMessage", conversationId, content, taskMode),
  observeAsk: (conversationId: string, question: string) =>
    ipcRenderer.invoke("observeAsk", conversationId, question),
  observeScreen: () => ipcRenderer.invoke("observeScreen"),
  clearObservation: () => ipcRenderer.invoke("clearObservation"),
  getLocalSttStatus: () => ipcRenderer.invoke("getLocalSttStatus"),
  transcribeVoiceComment: (audioWavBase64: string) =>
    ipcRenderer.invoke("transcribeVoiceComment", audioWavBase64),
  getMemorySnapshot: () => ipcRenderer.invoke("getMemorySnapshot"),
  clearMemory: () => ipcRenderer.invoke("clearMemory"),
  summarizeSession: (conversationId: string) =>
    ipcRenderer.invoke("summarizeSession", conversationId),
  reloadProjectContext: () => ipcRenderer.invoke("reloadProjectContext")
};

contextBridge.exposeInMainWorld("rasathane", api);
