import { app, BrowserWindow, ipcMain } from "electron";
import fs from "fs";
import path from "path";

import { createMainWindow } from "./window";
import { MemoryDatabase } from "../services/memory/database";
import { loadDefaultProjectContext } from "../services/memory/projectContext";
import {
  chatWithModel,
  listLocalModels
} from "../services/ollama/client";
import { capturePrimaryScreen, type CapturedObservation } from "../services/screen/capture";
import { DEFAULT_MODEL_ROLES } from "../services/settings/defaults";
import { getLocalSttStatus, transcribeVoiceComment } from "../services/stt/adapter";
import {
  RASATHANE_SYSTEM_PROMPT,
  buildScreenSummaryBlock
} from "../shared/rasathanePrompt";
import type {
  AppStatus,
  ChatMessage,
  MemoryItem,
  MemorySnapshot,
  ModelRoleConfig,
  ModelInfo,
  Observation,
  ObserveAskResult,
  RasathaneSettings,
  RasathaneTaskMode,
  SendMessageResult,
  SessionSummary,
  VoiceTranscriptionResult
} from "../shared/types";

const memoryDatabase = new MemoryDatabase();
const PRIMARY_OBSERVE_ASK_MODEL = "qwen3.5:9b";
const BUNDLED_STT_EXECUTABLE = "C:\\Users\\selim\\Desktop\\rasathane-ai\\tools\\whisper.cpp\\Release\\whisper-cli.exe";
const BUNDLED_STT_MODEL = "C:\\Users\\selim\\Desktop\\rasathane-ai\\tools\\whisper.cpp\\models\\ggml-small.bin";

let mainWindow: BrowserWindow | null = null;
let pendingObservation: CapturedObservation | null = null;
let selectedModelId = "";
let projectRoot = "C:\\Users\\selim\\Desktop\\rasathane-ai";

function nextId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveProjectRoot(): string {
  if (process.env.RASATHANE_PROJECT_ROOT && fs.existsSync(process.env.RASATHANE_PROJECT_ROOT)) {
    return process.env.RASATHANE_PROJECT_ROOT;
  }

  if (fs.existsSync(projectRoot)) {
    return projectRoot;
  }

  return process.cwd();
}

function assertLocalOllamaBaseUrl(baseUrl: string): void {
  const parsed = new URL(baseUrl);
  const allowedHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (!allowedHosts.has(parsed.hostname)) {
    throw new Error("Rasathane V1 uses local Ollama only. Set the endpoint to localhost or 127.0.0.1.");
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error("Ollama endpoint must use http:// or https://.");
  }
}

function isInstalled(models: ModelInfo[], modelId: string): boolean {
  return Boolean(modelId) && models.some((model) => model.id === modelId);
}

function firstInstalled(models: ModelInfo[], candidates: string[]): string {
  return candidates.find((candidate) => isInstalled(models, candidate)) ?? "";
}

function isRemovedFromRasathane(modelId: string): boolean {
  return /^moondream(?::|$)/i.test(modelId);
}

function assertModelSelectable(modelId: string): void {
  if (isRemovedFromRasathane(modelId)) {
    throw new Error("That removed vision model is no longer available in Rasathane. Use qwen3.5:9b.");
  }
}

function normalizeRoleModels(settings: RasathaneSettings, models: ModelInfo[]): ModelRoleConfig {
  const configured = {
    ...DEFAULT_MODEL_ROLES,
    ...(settings.roleModels ?? {})
  };

  return {
    associateProfessor:
      firstInstalled(models, [
        configured.associateProfessor,
        "rasathane-associate-professor:latest",
        "phi4-reasoning:plus",
        "qwen3.6:27b",
        "gpt-oss:20b"
      ]) || configured.associateProfessor,
    planner: firstInstalled(models, [configured.planner, "gpt-oss:20b", "devstral-small-2:24b"]) || configured.planner,
    primaryCoder:
      firstInstalled(models, [configured.primaryCoder, "qwen3.5:9b", "devstral-small-2:24b"]) ||
      configured.primaryCoder,
    reviewer: firstInstalled(models, [configured.reviewer, "gpt-oss:20b", "phi4:14b"]) || configured.reviewer,
    debugger: firstInstalled(models, [configured.debugger, "gpt-oss:20b", "devstral-small-2:24b"]) || configured.debugger,
    seniorReasoner:
      firstInstalled(models, [configured.seniorReasoner, "qwen3.6:27b", "gpt-oss:20b"]) ||
      configured.seniorReasoner,
    rollbackCoder:
      firstInstalled(models, [configured.rollbackCoder, "devstral-small-2:24b", "devstral:latest"]) ||
      configured.rollbackCoder,
    vision:
      firstInstalled(models, [
        configured.vision,
        PRIMARY_OBSERVE_ASK_MODEL,
        "llama3.2-vision:11b",
        "qwen2.5vl:7b"
      ]) || configured.vision
  };
}

function findPreferredTextModel(models: ModelInfo[], settings: RasathaneSettings): string {
  const roleModels = normalizeRoleModels(settings, models);
  const configured =
    settings.primaryTextModel || settings.defaultModel || selectedModelId || roleModels.planner;
  if (configured) {
    return configured;
  }

  return (
    models.find((model) => model.id === "gpt-oss:20b")?.id ??
    models.find((model) => !model.visionCapableHint && !/embed/i.test(model.id))?.id ??
    ""
  );
}

function findPreferredVisionModel(models: ModelInfo[], settings: RasathaneSettings): string {
  const roleModels = normalizeRoleModels(settings, models);
  if (settings.visionModel && !isRemovedFromRasathane(settings.visionModel)) {
    return settings.visionModel;
  }

  if (roleModels.vision && isInstalled(models, roleModels.vision)) {
    return roleModels.vision;
  }

  if (!settings.autoUseVisionModel) {
    return "";
  }

  return models.find((model) => model.visionCapableHint && !isRemovedFromRasathane(model.id))?.id ?? "";
}

async function getModelsSafe(settings: RasathaneSettings): Promise<{
  models: ModelInfo[];
  ollamaReachable: boolean;
  ollamaMessage: string;
}> {
  try {
    assertLocalOllamaBaseUrl(settings.ollamaBaseUrl);
    const models = await listLocalModels(settings.ollamaBaseUrl);
    return {
      models,
      ollamaReachable: true,
      ollamaMessage:
        models.length === 0
          ? "Ollama is reachable, but no local models are installed."
          : "Ollama reachable."
    };
  } catch (error) {
    return {
      models: [],
      ollamaReachable: false,
      ollamaMessage:
        error instanceof Error ? error.message : "Could not reach the local Ollama service."
    };
  }
}

async function buildAppStatus(): Promise<AppStatus> {
  const settings = memoryDatabase.getSettings();
  const { models, ollamaReachable, ollamaMessage } = await getModelsSafe(settings);
  const roleModels = normalizeRoleModels(settings, models);
  const primaryTextModel = findPreferredTextModel(models, settings);
  const visionModel = findPreferredVisionModel(models, settings);
  const selectedModel = models.find((model) => model.id === primaryTextModel) ?? null;
  const latestObservation = pendingObservation?.observation ?? memoryDatabase.getLatestObservation();

  return {
    ollamaReachable,
    ollamaMessage,
    selectedModelId: selectedModel?.id ?? primaryTextModel,
    selectedModelName: selectedModel?.name ?? primaryTextModel,
    primaryTextModel,
    visionModel,
    visionAvailable: Boolean(visionModel),
    pendingObservation: Boolean(pendingObservation),
    saveChatHistory: settings.saveChatHistory,
    saveScreenSummaries: settings.saveScreenSummaries,
    privacyMode: settings.privacyMode,
    memoryEnabled: settings.memoryEnabled,
    includeProjectContext: settings.includeProjectContext,
    roleModels,
    projectContextCount: memoryDatabase.getProjectContextItems().length,
    latestObservationSummary: latestObservation?.summary ?? null
  };
}

function seedBuiltInMemory(): void {
  const now = Date.now();
  const items: MemoryItem[] = [
    {
      id: "rasathane-purpose",
      type: "project_fact",
      title: "Rasathane purpose",
      content:
        "Rasathane AI is a local-first Windows desktop observatory that observes the screen on demand and gives guidance through local Ollama models.",
      createdAt: now,
      updatedAt: now
    },
    {
      id: "local-model-roles",
      type: "benchmark_fact",
      title: "Local model roles",
      content:
        "rasathane-associate-professor:latest is the local Associate Professor, qwen3.5:9b is the primary coder, qwen3.6:27b is senior architect/hard debugger, gpt-oss:20b and phi4:14b review, granite-code:8b is fallback, and vision summaries stay fallible.",
      createdAt: now,
      updatedAt: now
    },
    {
      id: "v1-benchmark-result",
      type: "benchmark_fact",
      title: "Rasathane V1 benchmark result",
      content:
        "Local AI helped with planning and fragments, but Codex had to fix the packaged renderer, Electron runtime issues, and final integration.",
      createdAt: now,
      updatedAt: now
    }
  ];

  for (const item of items) {
    memoryDatabase.upsertMemoryItem(item);
  }
}

async function alignInstalledModelDefaults(): Promise<void> {
  const settings = memoryDatabase.getSettings();
  const { models, ollamaReachable } = await getModelsSafe(settings);
  if (!ollamaReachable) {
    return;
  }

  const roleModels = normalizeRoleModels(settings, models);
  if (isInstalled(models, "rasathane-associate-professor:latest")) {
    roleModels.associateProfessor = "rasathane-associate-professor:latest";
    roleModels.planner = "rasathane-associate-professor:latest";
  }
  if (isInstalled(models, "qwen3.5:9b")) {
    roleModels.primaryCoder = "qwen3.5:9b";
    roleModels.vision = "qwen3.5:9b";
  }
  if (isInstalled(models, "qwen3.6:27b")) {
    roleModels.debugger = "qwen3.6:27b";
    roleModels.seniorReasoner = "qwen3.6:27b";
  }
  if (isInstalled(models, "gpt-oss:20b")) {
    roleModels.reviewer = "gpt-oss:20b";
  }
  if (isInstalled(models, "granite-code:8b")) {
    roleModels.rollbackCoder = "granite-code:8b";
  }
  const updates: Partial<RasathaneSettings> = {
    roleModels
  };

  if (!settings.localSttExecutablePath && fs.existsSync(BUNDLED_STT_EXECUTABLE)) {
    updates.localSttExecutablePath = BUNDLED_STT_EXECUTABLE;
  }

  if (!settings.localSttModelPath && fs.existsSync(BUNDLED_STT_MODEL)) {
    updates.localSttModelPath = BUNDLED_STT_MODEL;
  }

  if (!settings.primaryTextModel && isInstalled(models, roleModels.planner)) {
    updates.primaryTextModel = roleModels.planner;
    updates.defaultModel = roleModels.planner;
  }

  if (
    (!settings.visionModel || isRemovedFromRasathane(settings.visionModel)) &&
    isInstalled(models, roleModels.vision)
  ) {
    updates.visionModel = roleModels.vision;
  }

  memoryDatabase.setSettings(updates);
}

async function reloadProjectContextInternal(): Promise<void> {
  const items = await loadDefaultProjectContext(projectRoot);
  memoryDatabase.replaceProjectContextItems(items);
}

function buildContextBlocks(
  settings: RasathaneSettings,
  conversationId: string,
  screenSummary: string | null
): {
  blocks: string[];
  memoryInjected: boolean;
  projectContextInjected: boolean;
  screenSummaryAttached: boolean;
} {
  const blocks: string[] = [];
  const memoryItems = settings.memoryEnabled ? memoryDatabase.getMemoryItems().slice(0, 8) : [];
  const projectItems = settings.includeProjectContext
    ? memoryDatabase.getProjectContextItems().slice(0, 4)
    : [];
  const screenBlock = buildScreenSummaryBlock(screenSummary);
  const conversation = memoryDatabase.getConversation(conversationId);
  const recentMessages = conversation?.messages.slice(-6) ?? [];

  if (memoryItems.length > 0) {
    blocks.push(
      [
        "## Local Memory",
        ...memoryItems.map((item) => `- ${item.title}: ${item.content}`)
      ].join("\n")
    );
  }

  if (projectItems.length > 0) {
    blocks.push(
      [
        "## Project Context",
        ...projectItems.map((item) => `### ${item.title}\n${item.summary}`)
      ].join("\n\n")
    );
  }

  if (recentMessages.length > 0) {
    blocks.push(
      [
        "## Recent Conversation Window",
        ...recentMessages.map((message) => `${message.role}: ${message.content}`)
      ].join("\n")
    );
  }

  if (screenBlock) {
    blocks.push(screenBlock);
  }

  return {
    blocks,
    memoryInjected: memoryItems.length > 0,
    projectContextInjected: projectItems.length > 0,
    screenSummaryAttached: Boolean(screenBlock)
  };
}

function inferTaskMode(prompt: string, requestedMode: RasathaneTaskMode): RasathaneTaskMode {
  if (requestedMode !== "auto") {
    return requestedMode;
  }

  if (/\b(review|audit|security|rubric|check this|is this safe)\b/i.test(prompt)) {
    return "review";
  }

  if (/\b(professor|decide|decision|strategy|who should|direction|tradeoff|priority)\b/i.test(prompt)) {
    return "professor";
  }

  if (/\b(debug|bug|error|stack trace|blank window|crash|fails?|fix)\b/i.test(prompt)) {
    return "debug";
  }

  if (/\b(code|implement|patch|typescript|electron|react|vite|function|test)\b/i.test(prompt)) {
    return "coding";
  }

  return "guidance";
}

function chooseModelForTask(
  taskMode: RasathaneTaskMode,
  models: ModelInfo[],
  settings: RasathaneSettings
): string {
  const roleModels = normalizeRoleModels(settings, models);
  const fallback = findPreferredTextModel(models, settings);

  switch (taskMode) {
    case "professor":
      return isInstalled(models, roleModels.associateProfessor) ? roleModels.associateProfessor : fallback;
    case "coding":
      return isInstalled(models, roleModels.primaryCoder) ? roleModels.primaryCoder : fallback;
    case "review":
      return isInstalled(models, roleModels.reviewer) ? roleModels.reviewer : fallback;
    case "debug":
      return isInstalled(models, roleModels.debugger) ? roleModels.debugger : fallback;
    case "senior":
      return isInstalled(models, roleModels.seniorReasoner) ? roleModels.seniorReasoner : fallback;
    case "fallback":
      return isInstalled(models, roleModels.rollbackCoder) ? roleModels.rollbackCoder : fallback;
    case "guidance":
    case "auto":
    default:
      return isInstalled(models, roleModels.planner) ? roleModels.planner : fallback;
  }
}

function buildTaskModeBlock(taskMode: RasathaneTaskMode, model: string): string {
  return [
    "## Rasathane Task Router",
    `Mode: ${taskMode}`,
    `Selected model: ${model}`,
    "All outputs are guidance-only. Do not claim that actions were executed.",
    taskMode === "professor"
      ? "Professor mode reports directly to Selim with decisions, tradeoffs, and exact next commands."
      : "",
    taskMode === "coding"
      ? "Coding drafts from performance-tier models require trusted review before production use."
      : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function sanitizeFilename(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 80);
}

function buildObserveAskPrompt(question: string, retry: boolean): string {
  return [
    "You are Rasathane Observe + Ask.",
    "You receive the user's current screenshot and question.",
    "Return short, practical, step-by-step guidance.",
    "Do not write a generic essay.",
    "Do not pretend to see anything that is not visible.",
    "If uncertain, say what is uncertain and ask for another screenshot or a zoomed view.",
    "If the visible app is Fusion 360, or the question is about cutting/splitting a body/object, give Fusion 360-specific UI guidance.",
    "For Fusion 360 cutting, consider tools such as Solid > Modify > Split Body, Extrude Cut, Combine Cut, Press Pull, sketch profiles, construction planes, target body, and cutting tool/body.",
    "Always include:",
    "1. What I see",
    "2. Likely active application",
    "3. Exact next steps",
    "4. What to avoid",
    "5. Uncertainty / when to send another screenshot",
    retry ? "This is a retry after an empty response. Final answer only." : "",
    "",
    "User question:",
    question
  ]
    .filter(Boolean)
    .join("\n");
}

async function writeObserveAskReport(data: {
  observation: Observation;
  question: string;
  answer: string;
  model: string;
  pngBase64: string;
  retryUsed: boolean;
  error?: string;
  saveScreenshot: boolean;
}): Promise<{ reportPath: string; screenshotPath: string | null }> {
  const reportDir = path.join(projectRoot, "reports", "observe_ask_runs");
  await fs.promises.mkdir(reportDir, { recursive: true });

  const stamp = new Date(data.observation.createdAt).toISOString().replace(/[:.]/g, "-");
  const baseName = `${stamp}_${sanitizeFilename(data.observation.id)}`;
  let screenshotPath: string | null = null;

  if (data.saveScreenshot) {
    screenshotPath = path.join(reportDir, `${baseName}.png`);
    await fs.promises.writeFile(screenshotPath, Buffer.from(data.pngBase64, "base64"));
  }

  const reportPath = path.join(reportDir, `${baseName}.md`);
  const body = [
    "# Observe + Ask Run",
    "",
    `- created_at: ${new Date(data.observation.createdAt).toISOString()}`,
    `- model: ${data.model}`,
    `- source: ${data.observation.sourceName}`,
    `- dimensions: ${data.observation.width}x${data.observation.height}`,
    `- retry_used: ${data.retryUsed}`,
    `- screenshot_path: ${screenshotPath ?? "not saved"}`,
    `- status: ${data.error ? "failed" : "answered"}`,
    data.error ? `- error: ${data.error}` : "",
    "",
    "## Question",
    "",
    data.question,
    "",
    "## Answer",
    "",
    data.answer
  ]
    .filter((line) => line !== "")
    .join("\n");

  await fs.promises.writeFile(reportPath, body, "utf8");
  return { reportPath, screenshotPath };
}

async function generateObserveAskAnswer(options: {
  baseUrl: string;
  model: string;
  question: string;
  pngBase64: string;
  forceEmptyFirstAttempt?: boolean;
}): Promise<{ answer: string; retryUsed: boolean }> {
  let retryUsed = false;

  try {
    if (options.forceEmptyFirstAttempt) {
      throw new Error("Ollama returned an empty reply.");
    }

    const answer = await chatWithModel({
      baseUrl: options.baseUrl,
      model: options.model,
      history: [],
      prompt: buildObserveAskPrompt(options.question, false),
      imageBase64: options.pngBase64,
      systemPrompt: RASATHANE_SYSTEM_PROMPT,
      think: false,
      temperature: 0.1,
      numPredict: 700
    });

    return { answer, retryUsed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/empty reply|empty response|returned an empty/i.test(message)) {
      throw error;
    }
  }

  retryUsed = true;
  const answer = await chatWithModel({
    baseUrl: options.baseUrl,
    model: options.model,
    history: [],
    prompt: buildObserveAskPrompt(options.question, true),
    imageBase64: options.pngBase64,
    systemPrompt: RASATHANE_SYSTEM_PROMPT,
    think: false,
    temperature: 0,
    numPredict: 900
  });

  return { answer, retryUsed };
}

async function performObserveAsk(
  conversationId: string,
  question: string,
  options: { forceEmptyFirstAttempt?: boolean } = {}
): Promise<ObserveAskResult> {
  const prompt = question.trim();
  if (!prompt) {
    throw new Error("Enter a question before using Observe + Ask.");
  }

  const settings = memoryDatabase.getSettings();
  const { models } = await getModelsSafe(settings);
  const model = PRIMARY_OBSERVE_ASK_MODEL;
  if (!isInstalled(models, model)) {
    throw new Error(`${model} is required for Observe + Ask, but it is not installed or not visible to Rasathane.`);
  }

  const captured = await capturePrimaryScreen(app.getPath("userData"), false);
  captured.observation.visionModel = model;

  let answer = "";
  let retryUsed = false;
  let error: string | undefined;

  try {
    const response = await generateObserveAskAnswer({
      baseUrl: settings.ollamaBaseUrl,
      model,
      question: prompt,
      pngBase64: captured.pngBase64,
      forceEmptyFirstAttempt: options.forceEmptyFirstAttempt
    });
    answer = response.answer;
    retryUsed = response.retryUsed;
    captured.observation.summary = answer;
    captured.observation.analysisStatus = "analyzed";
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Observe + Ask failed.";
    answer = [
      "Observe + Ask failed.",
      error,
      "No fallback model was used. Retry, zoom the screen, or select another model manually later."
    ].join("\n");
    captured.observation.summary = answer;
    captured.observation.analysisStatus = "failed";
    captured.observation.warning = error;
  }

  const report = await writeObserveAskReport({
    observation: captured.observation,
    question: prompt,
    answer,
    model,
    pngBase64: captured.pngBase64,
    retryUsed,
    error,
    saveScreenshot: !settings.privacyMode
  });

  captured.observation.imagePath = report.screenshotPath;
  captured.observation.persisted = Boolean(report.screenshotPath);
  captured.observation.pendingForNextMessage = false;

  if (!settings.privacyMode && settings.saveScreenSummaries) {
    memoryDatabase.recordObservation(captured.observation);
  }

  const now = Date.now();
  const userMessage: ChatMessage = {
    id: nextId("msg"),
    role: "user",
    content: `[Observe + Ask]\n${prompt}`,
    createdAt: now,
    model,
    observationId: captured.observation.id
  };
  const assistantMessage: ChatMessage = {
    id: nextId("msg"),
    role: "assistant",
    content: answer,
    createdAt: Date.now(),
    model,
    observationId: captured.observation.id
  };

  memoryDatabase.appendMessage(conversationId, userMessage, settings.saveChatHistory && !settings.privacyMode);
  memoryDatabase.appendMessage(
    conversationId,
    assistantMessage,
    settings.saveChatHistory && !settings.privacyMode
  );

  return {
    observation: captured.observation,
    question: prompt,
    answer,
    model,
    reportPath: report.reportPath,
    screenshotPath: report.screenshotPath,
    retryUsed,
    saved: Boolean(report.reportPath),
    error
  };
}

async function initializeApplication(): Promise<void> {
  app.setName("Rasathane AI");
  projectRoot = resolveProjectRoot();
  await memoryDatabase.init(app.getPath("userData"));
  seedBuiltInMemory();
  await alignInstalledModelDefaults();
  await reloadProjectContextInternal();

  const smokeTest = process.env.RASATHANE_SMOKE_TEST === "1";
  const observeSmokeTest = process.env.RASATHANE_OBSERVE_SMOKE_TEST === "1";
  const observeAskSmokeTest = process.env.RASATHANE_OBSERVE_ASK_SMOKE_TEST === "1";
  const observeAskEmptyGuardTest = process.env.RASATHANE_OBSERVE_ASK_EMPTY_GUARD_TEST === "1";

  if (smokeTest || observeSmokeTest || observeAskSmokeTest || observeAskEmptyGuardTest) {
    setTimeout(() => {
      console.log("SMOKE_TEST_FORCE_EXIT");
      for (const window of BrowserWindow.getAllWindows()) {
        window.destroy();
      }
      app.exit(0);
    }, observeSmokeTest || observeAskSmokeTest || observeAskEmptyGuardTest ? 90000 : 8000);
  }

  mainWindow = await createMainWindow();

  if (smokeTest) {
    const renderedText = await mainWindow.webContents.executeJavaScript(
      "document.body.innerText",
      true
    );
    const hasExpectedUi = String(renderedText).includes("Rasathane AI");
    console.log(`SMOKE_TEST_RENDERED_TEXT=${hasExpectedUi ? "PASS" : "FAIL"}`);
    if (!hasExpectedUi) {
      console.error(String(renderedText).slice(0, 500));
      app.exit(1);
    }
  }

  if (observeSmokeTest) {
    try {
      const settings = memoryDatabase.getSettings();
      const { models } = await getModelsSafe(settings);
      const visionModel = findPreferredVisionModel(models, settings);
      const captured = await capturePrimaryScreen(app.getPath("userData"), false);
      console.log(
        `OBSERVE_SMOKE_CAPTURE=PASS width=${captured.observation.width} height=${captured.observation.height}`
      );

      if (!visionModel) {
        console.error("OBSERVE_SMOKE_VISION=FAIL no vision model selected");
        app.exit(1);
        return;
      }

      const summary = await chatWithModel({
        baseUrl: settings.ollamaBaseUrl,
        model: visionModel,
        history: [],
        prompt:
          "Briefly summarize this screenshot for an Electron app observe-screen smoke test. Mention visible app/window types and do not invent actions.",
        imageBase64: captured.pngBase64
      });
      console.log(`OBSERVE_SMOKE_VISION=PASS model=${visionModel}`);
      console.log(`OBSERVE_SMOKE_SUMMARY=${summary.slice(0, 300).replace(/\s+/g, " ")}`);
      app.exit(0);
    } catch (error) {
      console.error(
        `OBSERVE_SMOKE_VISION=FAIL ${
          error instanceof Error ? error.message : "Unknown observe smoke failure"
        }`
      );
      app.exit(1);
    }
  }

  if (observeAskSmokeTest || observeAskEmptyGuardTest) {
    try {
      const result = await performObserveAsk(
        "observe-ask-smoke",
        process.env.RASATHANE_OBSERVE_ASK_PROMPT ||
          "I need to cut this body/object in Fusion 360. What should I do?",
        { forceEmptyFirstAttempt: observeAskEmptyGuardTest }
      );
      console.log(`OBSERVE_ASK_CAPTURE=PASS width=${result.observation.width} height=${result.observation.height}`);
      console.log(`OBSERVE_ASK_MODEL=${result.model}`);
      console.log(`OBSERVE_ASK_RETRY_USED=${result.retryUsed ? "true" : "false"}`);
      console.log(`OBSERVE_ASK_REPORT=${result.reportPath ?? ""}`);
      console.log(`OBSERVE_ASK_ANSWER=${result.answer.slice(0, 300).replace(/\s+/g, " ")}`);
      if (result.error) {
        console.error(`OBSERVE_ASK_ERROR=${result.error}`);
        app.exit(1);
        return;
      }
      app.exit(0);
    } catch (error) {
      console.error(
        `OBSERVE_ASK_ERROR=${error instanceof Error ? error.message : "Unknown Observe + Ask failure"}`
      );
      app.exit(1);
    }
  }
}

app.whenReady().then(async () => {
  await initializeApplication();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = await createMainWindow();
  }
});

app.on("before-quit", () => {
  memoryDatabase.close();
});

ipcMain.handle("getAppStatus", async (): Promise<AppStatus> => {
  return buildAppStatus();
});

ipcMain.handle("getSettings", async (): Promise<RasathaneSettings> => {
  return memoryDatabase.getSettings();
});

ipcMain.handle(
  "setSettings",
  async (_event, partial: Partial<RasathaneSettings>): Promise<RasathaneSettings> => {
    if (partial.ollamaBaseUrl) {
      assertLocalOllamaBaseUrl(partial.ollamaBaseUrl);
    }
    if (partial.primaryTextModel) {
      assertModelSelectable(partial.primaryTextModel);
      selectedModelId = partial.primaryTextModel;
    }
    if (partial.defaultModel) {
      assertModelSelectable(partial.defaultModel);
    }
    if (partial.visionModel) {
      assertModelSelectable(partial.visionModel);
    }
    if (partial.roleModels) {
      for (const modelId of Object.values(partial.roleModels)) {
        if (modelId) {
          assertModelSelectable(modelId);
        }
      }
    }

    const nextSettings = memoryDatabase.setSettings(partial);
    return nextSettings;
  }
);

ipcMain.handle("listModels", async (): Promise<ModelInfo[]> => {
  const settings = memoryDatabase.getSettings();
  assertLocalOllamaBaseUrl(settings.ollamaBaseUrl);
  return listLocalModels(settings.ollamaBaseUrl);
});

ipcMain.handle("selectModel", async (_event, modelId: string): Promise<AppStatus> => {
  assertModelSelectable(modelId);
  selectedModelId = modelId;
  memoryDatabase.setSettings({ defaultModel: modelId, primaryTextModel: modelId });
  return buildAppStatus();
});

ipcMain.handle("selectTextModel", async (_event, modelId: string): Promise<AppStatus> => {
  assertModelSelectable(modelId);
  selectedModelId = modelId;
  memoryDatabase.setSettings({ primaryTextModel: modelId, defaultModel: modelId });
  return buildAppStatus();
});

ipcMain.handle("selectVisionModel", async (_event, modelId: string): Promise<AppStatus> => {
  if (modelId) {
    assertModelSelectable(modelId);
  }
  memoryDatabase.setSettings({ visionModel: modelId });
  return buildAppStatus();
});

ipcMain.handle("getConversations", async () => {
  return memoryDatabase.getConversations();
});

ipcMain.handle("getLocalSttStatus", async () => {
  return getLocalSttStatus(memoryDatabase.getSettings());
});

ipcMain.handle(
  "transcribeVoiceComment",
  async (_event, audioWavBase64: string): Promise<VoiceTranscriptionResult> => {
    return transcribeVoiceComment(memoryDatabase.getSettings(), audioWavBase64, app.getPath("userData"));
  }
);

ipcMain.handle(
  "observeAsk",
  async (_event, conversationId: string, question: string): Promise<ObserveAskResult> => {
    return performObserveAsk(conversationId, question);
  }
);

ipcMain.handle("observeScreen", async (): Promise<Observation> => {
  const settings = memoryDatabase.getSettings();
  const { models } = await getModelsSafe(settings);
  const visionModel = findPreferredVisionModel(models, settings);
  pendingObservation = await capturePrimaryScreen(app.getPath("userData"), !settings.privacyMode);

  if (!visionModel) {
    pendingObservation.observation.analysisStatus = "warning";
    pendingObservation.observation.warning =
      "Your selected model is text-only. Install/select a local vision model to analyze screenshots.";
  } else {
    try {
      const summary = await chatWithModel({
        baseUrl: settings.ollamaBaseUrl,
        model: visionModel,
        history: [],
        prompt:
          "Describe this desktop screenshot for a guidance assistant. Focus on visible apps, UI elements, error messages, buttons, and what the user appears to be doing. Be concise and factual.",
        imageBase64: pendingObservation.pngBase64
      });
      pendingObservation.observation.summary = summary;
      pendingObservation.observation.visionModel = visionModel;
      pendingObservation.observation.analysisStatus = "analyzed";
    } catch (error) {
      pendingObservation.observation.visionModel = visionModel;
      pendingObservation.observation.analysisStatus = "failed";
      pendingObservation.observation.warning =
        error instanceof Error ? error.message : "Vision analysis failed.";
    }
  }

  if (!settings.privacyMode && settings.saveScreenSummaries) {
    memoryDatabase.recordObservation(pendingObservation.observation);
  }

  return pendingObservation.observation;
});

ipcMain.handle("clearObservation", async (): Promise<AppStatus> => {
  pendingObservation = null;
  return buildAppStatus();
});

ipcMain.handle(
  "sendMessage",
  async (
    _event,
    conversationId: string,
    content: string,
    requestedTaskMode: RasathaneTaskMode = "auto"
  ): Promise<SendMessageResult> => {
    const prompt = content.trim();
    if (!prompt) {
      throw new Error("Enter a message before sending it to the local model.");
    }

    const settings = memoryDatabase.getSettings();
    const { models } = await getModelsSafe(settings);
    const taskMode = inferTaskMode(prompt, requestedTaskMode);
    const textModel = chooseModelForTask(taskMode, models, settings);
    if (!textModel) {
      throw new Error("Select a local text model before starting a session.");
    }

    const observation = pendingObservation?.observation ?? null;
    const userMessage: ChatMessage = {
      id: nextId("msg"),
      role: "user",
      content: prompt,
      createdAt: Date.now(),
      model: textModel,
      observationId: observation?.id ?? null
    };

    memoryDatabase.appendMessage(
      conversationId,
      userMessage,
      settings.saveChatHistory && !settings.privacyMode
    );

    const context = buildContextBlocks(settings, conversationId, observation?.summary ?? null);
    context.blocks.push(buildTaskModeBlock(taskMode, textModel));
    const conversation = memoryDatabase.getConversation(conversationId);
    const historyBeforeReply = conversation
      ? conversation.messages
          .filter((message) => message.id !== userMessage.id)
          .slice(-8)
      : [];

    let assistantContent: string;
    let trustedReviewerModel: string | undefined;
    let trustedReviewerSummary: string | undefined;
    let visionWarning = observation?.warning ?? undefined;

    try {
      assistantContent = await chatWithModel({
        baseUrl: settings.ollamaBaseUrl,
        model: textModel,
        history: historyBeforeReply,
        prompt,
        systemPrompt: RASATHANE_SYSTEM_PROMPT,
        contextBlocks: context.blocks
      });
      if (visionWarning && !context.screenSummaryAttached) {
        assistantContent = `${visionWarning}\n\n${assistantContent}`;
      }

      const roleModels = normalizeRoleModels(settings, models);
      if (
        taskMode === "coding" &&
        roleModels.reviewer &&
        roleModels.reviewer !== textModel &&
        isInstalled(models, roleModels.reviewer)
      ) {
        trustedReviewerModel = roleModels.reviewer;
        trustedReviewerSummary = await chatWithModel({
          baseUrl: settings.ollamaBaseUrl,
          model: roleModels.reviewer,
          history: [],
          systemPrompt: RASATHANE_SYSTEM_PROMPT,
          prompt: [
            "Review this local coding draft before Selim uses it.",
            "Focus on runtime risk, fake packages, cloud/upload behavior, destructive actions, and Electron/Vite packaged-app issues.",
            "Return concise PASS/WARN/FAIL notes.",
            "",
            "USER REQUEST:",
            prompt,
            "",
            "DRAFT:",
            assistantContent
          ].join("\n")
        });
        assistantContent = [
          assistantContent,
          "",
          "---",
          `Trusted reviewer (${trustedReviewerModel})`,
          trustedReviewerSummary
        ].join("\n");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown local-model error.";
      assistantContent = visionWarning ? `${visionWarning}\n\n${message}` : message;
    }

    if (pendingObservation) {
      pendingObservation.observation.pendingForNextMessage = false;
      pendingObservation = null;
    }

    const assistantMessage: ChatMessage = {
      id: nextId("msg"),
      role: "assistant",
      content: assistantContent,
      createdAt: Date.now(),
      model: textModel,
      observationId: observation?.id ?? null
    };

    memoryDatabase.appendMessage(
      conversationId,
      assistantMessage,
      settings.saveChatHistory && !settings.privacyMode
    );

    return {
      assistantMessage,
      observationAttached: Boolean(observation),
      screenSummaryAttached: context.screenSummaryAttached,
      memoryInjected: context.memoryInjected,
      projectContextInjected: context.projectContextInjected,
      usedTextModel: textModel,
      taskMode,
      usedVisionModel: observation?.visionModel ?? undefined,
      trustedReviewerModel,
      trustedReviewerSummary,
      visionWarning
    };
  }
);

ipcMain.handle("getMemorySnapshot", async (): Promise<MemorySnapshot> => {
  return memoryDatabase.getMemorySnapshot(memoryDatabase.getSettings());
});

ipcMain.handle("clearMemory", async (): Promise<MemorySnapshot> => {
  memoryDatabase.clearMemory();
  seedBuiltInMemory();
  if (memoryDatabase.getSettings().includeProjectContext) {
    await reloadProjectContextInternal();
  }
  return memoryDatabase.getMemorySnapshot(memoryDatabase.getSettings());
});

ipcMain.handle("summarizeSession", async (_event, conversationId: string): Promise<SessionSummary> => {
  const conversation = memoryDatabase.getConversation(conversationId);
  const recent = conversation?.messages.slice(-8) ?? [];
  const summaryText =
    recent.length === 0
      ? "No session messages to summarize yet."
      : recent.map((message) => `${message.role}: ${message.content}`).join("\n").slice(0, 1800);
  const summary: SessionSummary = {
    id: nextId("summary"),
    conversationId,
    summary: summaryText,
    createdAt: Date.now()
  };
  if (!memoryDatabase.getSettings().privacyMode) {
    memoryDatabase.saveSessionSummary(summary);
  }
  return summary;
});

ipcMain.handle("reloadProjectContext", async (): Promise<MemorySnapshot> => {
  await reloadProjectContextInternal();
  return memoryDatabase.getMemorySnapshot(memoryDatabase.getSettings());
});
