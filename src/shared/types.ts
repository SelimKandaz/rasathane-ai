export interface RasathaneSettings {
  ollamaBaseUrl: string;
  defaultModel: string;
  primaryTextModel: string;
  visionModel: string;
  roleModels: ModelRoleConfig;
  localSttExecutablePath: string;
  localSttModelPath: string;
  localSttArguments: string;
  enableLocalTts: boolean;
  autoUseVisionModel: boolean;
  saveChatHistory: boolean;
  saveScreenSummaries: boolean;
  privacyMode: boolean;
  memoryEnabled: boolean;
  includeProjectContext: boolean;
}

export interface ModelRoleConfig {
  associateProfessor: string;
  planner: string;
  primaryCoder: string;
  reviewer: string;
  debugger: string;
  seniorReasoner: string;
  rollbackCoder: string;
  vision: string;
}

export type RasathaneTaskMode =
  | "auto"
  | "professor"
  | "guidance"
  | "coding"
  | "review"
  | "debug"
  | "senior"
  | "fallback";

export interface ModelInfo {
  id: string;
  name: string;
  size?: number;
  modifiedAt?: string;
  format?: string;
  parameterSize?: string;
  capabilities?: string[];
  visionCapableHint: boolean;
}

export type MessageRole = "system" | "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  model?: string;
  observationId?: string | null;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface Observation {
  id: string;
  createdAt: number;
  sourceName: string;
  width: number;
  height: number;
  imagePath: string | null;
  previewDataUrl: string | null;
  persisted: boolean;
  pendingForNextMessage: boolean;
  summary: string | null;
  visionModel: string | null;
  analysisStatus: "not_requested" | "analyzed" | "warning" | "failed";
  warning: string | null;
}

export interface AppStatus {
  ollamaReachable: boolean;
  ollamaMessage: string;
  selectedModelId: string;
  selectedModelName: string;
  primaryTextModel: string;
  visionModel: string;
  visionAvailable: boolean;
  pendingObservation: boolean;
  saveChatHistory: boolean;
  saveScreenSummaries: boolean;
  privacyMode: boolean;
  memoryEnabled: boolean;
  includeProjectContext: boolean;
  roleModels: ModelRoleConfig;
  projectContextCount: number;
  latestObservationSummary: string | null;
}

export interface SendMessageResult {
  assistantMessage: ChatMessage;
  observationAttached: boolean;
  screenSummaryAttached: boolean;
  memoryInjected: boolean;
  projectContextInjected: boolean;
  usedTextModel: string;
  taskMode: RasathaneTaskMode;
  usedVisionModel?: string;
  trustedReviewerModel?: string;
  trustedReviewerSummary?: string;
  visionWarning?: string;
}

export interface MemoryItem {
  id: string;
  type: "preference" | "project_fact" | "benchmark_fact" | "session_summary";
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectContextItem {
  id: string;
  sourcePath: string;
  title: string;
  summary: string;
  updatedAt: number;
}

export interface SessionSummary {
  id: string;
  conversationId: string;
  summary: string;
  createdAt: number;
}

export interface ObserveAskResult {
  observation: Observation;
  question: string;
  answer: string;
  model: string;
  reportPath: string | null;
  screenshotPath: string | null;
  retryUsed: boolean;
  saved: boolean;
  error?: string;
}

export interface LocalSttStatus {
  configured: boolean;
  available: boolean;
  executablePath: string;
  modelPath: string;
  modelAvailable: boolean;
  argumentsTemplate: string;
  tested: boolean;
  message: string;
}

export interface VoiceTranscriptionResult {
  transcript: string;
  executablePath: string;
  modelPath: string;
  elapsedMs: number;
}

export interface MemorySnapshot {
  memoryEnabled: boolean;
  privacyMode: boolean;
  conversationCount: number;
  messageCount: number;
  observationCount: number;
  memoryItemCount: number;
  projectContextCount: number;
  latestObservation: Observation | null;
  projectContextItems: ProjectContextItem[];
  memoryItems: MemoryItem[];
}

export interface RasathaneAPI {
  getAppStatus(): Promise<AppStatus>;
  getSettings(): Promise<RasathaneSettings>;
  setSettings(settings: Partial<RasathaneSettings>): Promise<RasathaneSettings>;
  listModels(): Promise<ModelInfo[]>;
  selectModel(id: string): Promise<AppStatus>;
  selectTextModel(id: string): Promise<AppStatus>;
  selectVisionModel(id: string): Promise<AppStatus>;
  getConversations(): Promise<Conversation[]>;
  sendMessage(
    conversationId: string,
    content: string,
    taskMode?: RasathaneTaskMode
  ): Promise<SendMessageResult>;
  observeAsk(conversationId: string, question: string): Promise<ObserveAskResult>;
  observeScreen(): Promise<Observation>;
  clearObservation(): Promise<AppStatus>;
  getLocalSttStatus(): Promise<LocalSttStatus>;
  transcribeVoiceComment(audioWavBase64: string): Promise<VoiceTranscriptionResult>;
  getMemorySnapshot(): Promise<MemorySnapshot>;
  clearMemory(): Promise<MemorySnapshot>;
  summarizeSession(conversationId: string): Promise<SessionSummary>;
  reloadProjectContext(): Promise<MemorySnapshot>;
}
