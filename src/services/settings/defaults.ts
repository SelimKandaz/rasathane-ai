import type { ModelRoleConfig, RasathaneSettings } from "../../shared/types";

export const DEFAULT_MODEL_ROLES: ModelRoleConfig = {
  associateProfessor: "rasathane-associate-professor:latest",
  planner: "rasathane-associate-professor:latest",
  primaryCoder: "qwen3.5:9b",
  reviewer: "gpt-oss:20b",
  debugger: "qwen3.6:27b",
  seniorReasoner: "qwen3.6:27b",
  rollbackCoder: "granite-code:8b",
  vision: "qwen3.5:9b"
};

export const DEFAULT_SETTINGS: RasathaneSettings = {
  ollamaBaseUrl: "http://localhost:11434",
  defaultModel: "",
  primaryTextModel: "",
  visionModel: "",
  roleModels: DEFAULT_MODEL_ROLES,
  localSttExecutablePath: "",
  localSttModelPath: "",
  localSttArguments: "-m \"{model}\" -f \"{audio}\" -nt -l auto",
  enableLocalTts: true,
  autoUseVisionModel: true,
  saveChatHistory: true,
  saveScreenSummaries: true,
  privacyMode: false,
  memoryEnabled: true,
  includeProjectContext: true
};
