import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import type {
  AppStatus,
  Conversation,
  LocalSttStatus,
  MemorySnapshot,
  ModelInfo,
  Observation,
  RasathaneAPI,
  RasathaneSettings,
  RasathaneTaskMode
} from "../shared/types";

declare global {
  interface Window {
    rasathane: RasathaneAPI;
  }
}

const DEFAULT_SETTINGS: RasathaneSettings = {
  ollamaBaseUrl: "http://localhost:11434",
  defaultModel: "",
  primaryTextModel: "",
  visionModel: "",
  roleModels: {
    associateProfessor: "rasathane-associate-professor:latest",
    planner: "rasathane-associate-professor:latest",
    primaryCoder: "qwen3.5:9b",
    reviewer: "gpt-oss:20b",
    debugger: "qwen3.6:27b",
    seniorReasoner: "qwen3.6:27b",
    rollbackCoder: "granite-code:8b",
    vision: "qwen3.5:9b"
  },
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

function statusLabel(status: AppStatus | null): string {
  if (!status) {
    return "Booting observatory";
  }
  if (!status.ollamaReachable) {
    return "Ollama offline";
  }
  if (!status.primaryTextModel) {
    return "Select a text brain";
  }
  return `Text brain: ${status.primaryTextModel}`;
}

const TASK_MODES: Array<{ id: RasathaneTaskMode; label: string; hint: string }> = [
  { id: "auto", label: "Auto router", hint: "Infer route from request" },
  { id: "professor", label: "Professor", hint: "Direct decision/report to Selim" },
  { id: "guidance", label: "Guidance", hint: "Planner and next steps" },
  { id: "coding", label: "Coding draft", hint: "Qwen draft plus trusted review" },
  { id: "review", label: "Review", hint: "Trusted safety/runtime review" },
  { id: "debug", label: "Debug", hint: "Failure analysis and repair path" },
  { id: "senior", label: "Senior", hint: "Slow hard-problem route" },
  { id: "fallback", label: "Rollback", hint: "Trusted fallback coder" }
];

function formatCapabilities(model: ModelInfo): string {
  if (model.capabilities?.length) {
    return model.capabilities.join(", ");
  }

  return model.visionCapableHint ? "vision" : "completion";
}

function hideRemovedVisionModelName(value: string | null | undefined): string {
  if (!value) {
    return "";
  }

  return value.replace(/moondream(?::latest)?/gi, "removed legacy vision model");
}

function mergeAudioChunks(chunks: Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

function downsampleTo16k(samples: Float32Array, sourceRate: number): Float32Array {
  const targetRate = 16000;
  if (sourceRate === targetRate) {
    return samples;
  }

  const ratio = sourceRate / targetRate;
  const newLength = Math.round(samples.length / ratio);
  const result = new Float32Array(newLength);

  for (let index = 0; index < newLength; index++) {
    const start = Math.floor(index * ratio);
    const end = Math.min(Math.floor((index + 1) * ratio), samples.length);
    let sum = 0;
    let count = 0;

    for (let sampleIndex = start; sampleIndex < end; sampleIndex++) {
      sum += samples[sampleIndex];
      count++;
    }

    result[index] = count > 0 ? sum / count : 0;
  }

  return result;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return window.btoa(binary);
}

function encodeWavBase64(samples: Float32Array, sourceRate: number): string {
  const mono = downsampleTo16k(samples, sourceRate);
  const sampleRate = 16000;
  const buffer = new ArrayBuffer(44 + mono.length * 2);
  const view = new DataView(buffer);

  function writeString(offset: number, value: string): void {
    for (let index = 0; index < value.length; index++) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + mono.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, mono.length * 2, true);

  let offset = 44;
  for (const sample of mono) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return arrayBufferToBase64(buffer);
}

export default function App(): JSX.Element {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [settings, setSettings] = useState<RasathaneSettings>(DEFAULT_SETTINGS);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [memory, setMemory] = useState<MemorySnapshot | null>(null);
  const [activeConversationId, setActiveConversationId] = useState(() => `session-${Date.now()}`);
  const [inputValue, setInputValue] = useState("");
  const [latestObservation, setLatestObservation] = useState<Observation | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [infoMessage, setInfoMessage] = useState("");
  const [sttStatus, setSttStatus] = useState<LocalSttStatus | null>(null);
  const [ttsMessage, setTtsMessage] = useState("");
  const [taskMode, setTaskMode] = useState<RasathaneTaskMode>("auto");
  const [busyState, setBusyState] = useState<
    "idle" | "loading" | "sending" | "observing" | "observeAsk"
  >("loading");
  const [voiceRecording, setVoiceRecording] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Float32Array[]>([]);

  const textModels = useMemo(
    () =>
      models.filter(
        (model) =>
          !/embed/i.test(model.id) &&
          !model.capabilities?.some((capability) => capability.toLowerCase() === "embedding")
      ),
    [models]
  );
  const visionModels = useMemo(() => models.filter((model) => model.visionCapableHint), [models]);
  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId) ?? null,
    [activeConversationId, conversations]
  );

  async function refreshData(): Promise<void> {
    setErrorMessage("");
    try {
      const [nextStatus, nextSettings, nextModels, nextConversations, nextMemory, nextSttStatus] =
        await Promise.all([
          window.rasathane.getAppStatus(),
          window.rasathane.getSettings(),
          window.rasathane.listModels(),
          window.rasathane.getConversations(),
          window.rasathane.getMemorySnapshot(),
          window.rasathane.getLocalSttStatus()
        ]);

      setStatus(nextStatus);
      setSettings(nextSettings);
      setModels(nextModels);
      setConversations(nextConversations);
      setMemory(nextMemory);
      setSttStatus(nextSttStatus);
      setLatestObservation(nextMemory.latestObservation ?? null);

      if (nextConversations.length > 0) {
        setActiveConversationId((current) =>
          nextConversations.some((conversation) => conversation.id === current)
            ? current
            : nextConversations[0].id
        );
      }

      setInfoMessage(nextStatus.ollamaMessage);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load Rasathane state.");
    }
  }

  useEffect(() => {
    refreshData().finally(() => setBusyState("idle"));
  }, []);

  async function handleSelectTextModel(modelId: string): Promise<void> {
    try {
      const nextStatus = await window.rasathane.selectTextModel(modelId);
      setStatus(nextStatus);
      setSettings((current) => ({ ...current, primaryTextModel: modelId, defaultModel: modelId }));
      setInfoMessage(`Text brain set to ${modelId}.`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not select text model.");
    }
  }

  async function handleSelectVisionModel(modelId: string): Promise<void> {
    try {
      const nextStatus = await window.rasathane.selectVisionModel(modelId);
      setStatus(nextStatus);
      setSettings((current) => ({ ...current, visionModel: modelId }));
      setInfoMessage(modelId ? `Vision eyes set to ${modelId}.` : "Vision model cleared.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not select vision model.");
    }
  }

  async function handleSaveSettings(): Promise<void> {
    try {
      const saved = await window.rasathane.setSettings(settings);
      setSettings(saved);
      await refreshData();
      setInfoMessage("Settings saved locally.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not save settings.");
    }
  }

  async function handleObserveScreen(): Promise<void> {
    setBusyState("observing");
    setErrorMessage("");
    try {
      const observation = await window.rasathane.observeScreen();
      setLatestObservation(observation);
      await refreshData();
      if (observation.summary) {
        setInfoMessage(`Screen analyzed by ${observation.visionModel}. Summary is queued.`);
      } else {
        setInfoMessage(observation.warning ?? "Screen captured without vision summary.");
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Screen observation failed.");
    } finally {
      setBusyState("idle");
    }
  }

  async function handleSendMessage(): Promise<void> {
    const content = inputValue.trim();
    if (!content) {
      return;
    }

    setBusyState("sending");
    setErrorMessage("");
    try {
      const result = await window.rasathane.sendMessage(activeConversationId, content, taskMode);
      setInputValue("");
      await refreshData();
      setInfoMessage(
        [
          `route: ${result.taskMode}`,
          `Used text brain: ${result.usedTextModel}`,
          result.usedVisionModel ? `vision: ${result.usedVisionModel}` : "",
          result.trustedReviewerModel ? `reviewed by: ${result.trustedReviewerModel}` : "",
          result.screenSummaryAttached ? "screen summary attached" : "",
          result.memoryInjected ? "memory injected" : "",
          result.projectContextInjected ? "project context injected" : ""
        ]
          .filter(Boolean)
          .join(" | ")
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Message send failed.");
    } finally {
      setBusyState("idle");
    }
  }

  async function handleObserveAsk(): Promise<void> {
    const content = inputValue.trim();
    if (!content) {
      setErrorMessage("Enter a question before using Observe + Ask.");
      return;
    }

    setBusyState("observeAsk");
    setErrorMessage("");
    try {
      const result = await window.rasathane.observeAsk(activeConversationId, content);
      setLatestObservation(result.observation);
      setInputValue("");
      await refreshData();
      setInfoMessage(
        [
          `Observe + Ask used ${result.model}`,
          result.retryUsed ? "empty-response retry used" : "",
          result.reportPath ? `report saved: ${result.reportPath}` : "",
          result.screenshotPath ? "screenshot saved" : "screenshot not saved"
        ]
          .filter(Boolean)
          .join(" | ")
      );
      if (result.error) {
        setErrorMessage(result.error);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Observe + Ask failed.");
    } finally {
      setBusyState("idle");
    }
  }

  async function handleStartVoiceRecording(): Promise<void> {
    setErrorMessage("");
    setInfoMessage("");

    if (!sttStatus?.available) {
      setErrorMessage(sttStatus?.message ?? "Local STT is not available yet.");
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorMessage("Microphone capture is not available in this Electron runtime.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true
        }
      });
      const AudioContextCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) {
        throw new Error("AudioContext is not available in this Electron runtime.");
      }

      const audioContext = new AudioContextCtor();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);

      audioChunksRef.current = [];
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        audioChunksRef.current.push(new Float32Array(input));
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      audioContextRef.current = audioContext;
      audioProcessorRef.current = processor;
      audioSourceRef.current = source;
      audioStreamRef.current = stream;
      setVoiceRecording(true);
      setInfoMessage("Recording voice comment locally. Click Stop Voice Comment when done.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not start microphone recording.");
    }
  }

  async function handleStopVoiceRecording(): Promise<void> {
    const audioContext = audioContextRef.current;
    const processor = audioProcessorRef.current;
    const source = audioSourceRef.current;
    const stream = audioStreamRef.current;
    const chunks = audioChunksRef.current;

    setVoiceRecording(false);
    processor?.disconnect();
    source?.disconnect();
    stream?.getTracks().forEach((track) => track.stop());

    audioProcessorRef.current = null;
    audioSourceRef.current = null;
    audioStreamRef.current = null;
    audioChunksRef.current = [];

    const sourceRate = audioContext?.sampleRate ?? 48000;
    await audioContext?.close();
    audioContextRef.current = null;

    if (chunks.length === 0) {
      setErrorMessage("No microphone audio was recorded.");
      return;
    }

    try {
      const wavBase64 = encodeWavBase64(mergeAudioChunks(chunks), sourceRate);
      const result = await window.rasathane.transcribeVoiceComment(wavBase64);
      setInputValue((current) => {
        const prefix = current.trim() ? `${current.trim()}\n` : "";
        return `${prefix}${result.transcript}`;
      });
      setInfoMessage(`Voice comment transcribed locally in ${Math.round(result.elapsedMs / 1000)}s.`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Voice transcription failed.");
    }
  }

  function handleReadLastAnswer(): void {
    setTtsMessage("");
    if (!settings.enableLocalTts) {
      setTtsMessage("Read aloud is disabled in settings.");
      return;
    }

    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
      setTtsMessage("Local read aloud is not available in this Electron runtime.");
      return;
    }

    const latestAssistantMessage = [...(activeConversation?.messages ?? [])]
      .reverse()
      .find((message) => message.role === "assistant");

    if (!latestAssistantMessage?.content) {
      setTtsMessage("No assistant answer to read aloud yet.");
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(latestAssistantMessage.content.slice(0, 4000));
    utterance.rate = 0.96;
    window.speechSynthesis.speak(utterance);
    setTtsMessage("Reading latest answer aloud with local OS/Chromium speech synthesis.");
  }

  async function handleClearObservation(): Promise<void> {
    await window.rasathane.clearObservation();
    setLatestObservation(null);
    await refreshData();
  }

  async function handleReloadProjectContext(): Promise<void> {
    const nextMemory = await window.rasathane.reloadProjectContext();
    setMemory(nextMemory);
    setInfoMessage(`Project context loaded: ${nextMemory.projectContextCount} docs.`);
  }

  async function handleClearMemory(): Promise<void> {
    const nextMemory = await window.rasathane.clearMemory();
    setMemory(nextMemory);
    setInfoMessage("Local memory reset to default Rasathane facts.");
  }

  async function handleSummarizeSession(): Promise<void> {
    const summary = await window.rasathane.summarizeSession(activeConversationId);
    await refreshData();
    setInfoMessage(`Session summary saved: ${summary.summary.slice(0, 120)}`);
  }

  return (
    <div style={styles.shell}>
      <section style={styles.stage}>
        <div style={styles.headerBand}>
          <div>
            <div style={styles.eyebrow}>Observatory</div>
            <h1 style={styles.title}>Rasathane AI</h1>
            <p style={styles.subtitle}>
              Local text brain plus local vision eyes for screen-aware desktop guidance.
            </p>
          </div>
          <div style={styles.signalCard}>
            <div style={styles.signalLabel}>Signal</div>
            <div style={styles.signalValue}>{statusLabel(status)}</div>
            <div style={styles.signalHint}>
              Vision: {hideRemovedVisionModelName(status?.visionModel) || "not selected"} | Memory:{" "}
              {status?.memoryEnabled ? "on" : "off"} | Privacy:{" "}
              {status?.privacyMode ? "on" : "off"}
            </div>
          </div>
        </div>

        <div style={styles.stageGrid}>
          <article style={styles.panel}>
            <div style={styles.panelEyebrow}>Local Brain</div>
            <h2 style={styles.panelTitle}>Model Roles</h2>
            <label style={styles.label}>
              Text brain
              <select
                style={styles.select}
                value={status?.primaryTextModel || settings.primaryTextModel || settings.defaultModel}
                onChange={(event) => void handleSelectTextModel(event.target.value)}
              >
                <option value="">Select text model</option>
                {textModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            </label>

            <label style={styles.label}>
              Vision eyes
              <select
                style={styles.select}
                value={status?.visionModel || settings.visionModel}
                onChange={(event) => void handleSelectVisionModel(event.target.value)}
              >
                <option value="">No vision model</option>
                {visionModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            </label>

            <div style={styles.roleMap}>
              <div style={styles.roleItem}>
                <span>Associate Professor</span>
                <strong>
                  {status?.roleModels.associateProfessor || settings.roleModels.associateProfessor}
                </strong>
              </div>
              <div style={styles.roleItem}>
                <span>Planner</span>
                <strong>{status?.roleModels.planner || settings.roleModels.planner}</strong>
              </div>
              <div style={styles.roleItem}>
                <span>Coder</span>
                <strong>{status?.roleModels.primaryCoder || settings.roleModels.primaryCoder}</strong>
              </div>
              <div style={styles.roleItem}>
                <span>Reviewer</span>
                <strong>{status?.roleModels.reviewer || settings.roleModels.reviewer}</strong>
              </div>
              <div style={styles.roleItem}>
                <span>Debug</span>
                <strong>{status?.roleModels.debugger || settings.roleModels.debugger}</strong>
              </div>
              <div style={styles.roleItem}>
                <span>Senior</span>
                <strong>{status?.roleModels.seniorReasoner || settings.roleModels.seniorReasoner}</strong>
              </div>
              <div style={styles.roleItem}>
                <span>Rollback</span>
                <strong>{status?.roleModels.rollbackCoder || settings.roleModels.rollbackCoder}</strong>
              </div>
              <div style={styles.roleItem}>
                <span>Vision</span>
                <strong>{status?.roleModels.vision || settings.roleModels.vision}</strong>
              </div>
            </div>

            <div style={styles.modelList}>
              {models.map((model) => (
                <div key={model.id} style={styles.modelRow}>
                  <div>
                    <div style={styles.modelName}>{model.name}</div>
                    <div style={styles.modelMeta}>
                      {model.parameterSize || "unknown size"} | {model.format || "unknown format"} |{" "}
                      {formatCapabilities(model)}
                    </div>
                  </div>
                  <div style={styles.modelBadge}>
                    {model.visionCapableHint ? "Vision" : /embed/i.test(model.id) ? "Embedding" : "Text"}
                  </div>
                </div>
              ))}
            </div>
          </article>

          <article style={styles.panel}>
            <div style={styles.panelHeader}>
              <div>
                <div style={styles.panelEyebrow}>Screen Observation</div>
                <h2 style={styles.panelTitle}>Observe and Analyze</h2>
              </div>
              <button
                style={styles.primaryButton}
                disabled={busyState === "observing"}
                onClick={() => void handleObserveScreen()}
              >
                {busyState === "observing" ? "Analyzing..." : "Observe Screen"}
              </button>
            </div>

            {latestObservation ? (
              <div style={styles.observationLayout}>
                {latestObservation.previewDataUrl ? (
                  <img alt="Observation preview" src={latestObservation.previewDataUrl} style={styles.preview} />
                ) : null}
                <div style={styles.observationMeta}>
                  <div>Time: {new Date(latestObservation.createdAt).toLocaleString()}</div>
                  <div>Source: {latestObservation.sourceName}</div>
                  <div>Vision model: {hideRemovedVisionModelName(latestObservation.visionModel) || "none"}</div>
                  <div>Status: {latestObservation.analysisStatus}</div>
                  <div>Screenshot persisted: {latestObservation.persisted ? "yes" : "no"}</div>
                  {latestObservation.warning ? <div>Warning: {latestObservation.warning}</div> : null}
                </div>
                {latestObservation.summary ? (
                  <div style={styles.summaryBox}>{hideRemovedVisionModelName(latestObservation.summary)}</div>
                ) : (
                  <div style={styles.emptyState}>No screen summary yet.</div>
                )}
                <button style={styles.secondaryButton} onClick={() => void handleClearObservation()}>
                  Clear Observation
                </button>
              </div>
            ) : (
              <div style={styles.emptyState}>
                Click Observe Screen to capture a screenshot. If a vision model is selected, Rasathane
                summarizes it before the text brain responds.
              </div>
            )}
          </article>

          <article style={styles.panel}>
            <div style={styles.panelEyebrow}>Memory</div>
            <h2 style={styles.panelTitle}>Local Memory</h2>
            <div style={styles.kvGrid}>
              <div>Conversations: {memory?.conversationCount ?? 0}</div>
              <div>Messages: {memory?.messageCount ?? 0}</div>
              <div>Observations: {memory?.observationCount ?? 0}</div>
              <div>Memory items: {memory?.memoryItemCount ?? 0}</div>
            </div>
            <div style={styles.buttonRow}>
              <button style={styles.secondaryButton} onClick={() => void handleSummarizeSession()}>
                Summarize Session
              </button>
              <button style={styles.secondaryButton} onClick={() => void handleClearMemory()}>
                Clear Memory
              </button>
            </div>
            <div style={styles.memoryList}>
              {(memory?.memoryItems ?? []).slice(0, 4).map((item) => (
                <div key={item.id} style={styles.memoryItem}>
                  <strong>{item.title}</strong>
                  <span>{item.content}</span>
                </div>
              ))}
            </div>
          </article>

          <article style={styles.panel}>
            <div style={styles.panelEyebrow}>Project Context</div>
            <h2 style={styles.panelTitle}>Rasathane Context</h2>
            <div style={styles.emptyState}>
              Loaded docs: {memory?.projectContextCount ?? status?.projectContextCount ?? 0}
            </div>
            <button style={styles.secondaryButton} onClick={() => void handleReloadProjectContext()}>
              Reload Context
            </button>
            <div style={styles.memoryList}>
              {(memory?.projectContextItems ?? []).map((item) => (
                <div key={item.id} style={styles.memoryItem}>
                  <strong>{item.title}</strong>
                  <span>{item.summary.slice(0, 220)}</span>
                </div>
              ))}
            </div>
          </article>
        </div>
      </section>

      <aside style={styles.assistantRail}>
        <div style={styles.assistantHeader}>
          <div>
            <div style={styles.panelEyebrow}>Guidance Panel</div>
            <h2 style={styles.panelTitle}>Session Console</h2>
          </div>
          <div style={styles.sessionBadge}>Session {activeConversationId.slice(-6)}</div>
        </div>

        <div style={styles.routerPanel}>
          <label style={styles.label}>
            Task router
            <select
              style={styles.select}
              value={taskMode}
              onChange={(event) => setTaskMode(event.target.value as RasathaneTaskMode)}
            >
              {TASK_MODES.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.label} - {mode.hint}
                </option>
              ))}
            </select>
          </label>
          <div style={styles.routerHint}>
            Observe + Ask captures the current screen and sends screenshot plus question to qwen3.5:9b.
          </div>
        </div>

        <div style={styles.messagePane}>
          {activeConversation?.messages.length ? (
            activeConversation.messages.map((message) => (
              <div
                key={message.id}
                style={{
                  ...styles.messageBubble,
                  ...(message.role === "user" ? styles.userBubble : styles.assistantBubble)
                }}
              >
                <div style={styles.messageRole}>{message.role === "user" ? "You" : "Rasathane"}</div>
                <div>{hideRemovedVisionModelName(message.content)}</div>
              </div>
            ))
          ) : (
            <div style={styles.emptyState}>
              Ask for guidance. If the question depends on the screen, click Observe Screen first.
            </div>
          )}
        </div>

        <div style={styles.inputRow}>
          <div style={styles.observeAskHeader}>
            <div>
              <div style={styles.panelEyebrow}>Observe + Ask</div>
              <div style={styles.routerHint}>
                Primary path for app guidance: type the question, capture the screen, get step-by-step help.
              </div>
            </div>
          </div>
          <div style={styles.voiceRow}>
            <button
              style={voiceRecording ? styles.recordingButton : styles.secondaryButton}
              disabled={!sttStatus?.available}
              onClick={() =>
                voiceRecording
                  ? void handleStopVoiceRecording()
                  : void handleStartVoiceRecording()
              }
            >
              {voiceRecording ? "Stop Voice Comment" : "Record Voice Comment"}
            </button>
            <span style={styles.routerHint}>
              {sttStatus?.available
                ? "Local whisper.cpp STT is ready. Transcript is inserted into the text box."
                : sttStatus?.message ?? "Checking local STT status."}
            </span>
          </div>
          <textarea
            style={styles.textarea}
            value={inputValue}
            placeholder="Example: I need to cut this body/object in Fusion 360. What should I do?"
            onChange={(event) => setInputValue(event.target.value)}
          />
          <div style={styles.buttonRow}>
            <button
              style={styles.primaryButton}
              disabled={busyState === "observeAsk"}
              onClick={() => void handleObserveAsk()}
            >
              {busyState === "observeAsk" ? "Observing..." : "Observe + Ask"}
            </button>
            <button
              style={styles.secondaryButton}
              disabled={busyState === "sending"}
              onClick={() => void handleSendMessage()}
            >
              {busyState === "sending" ? "Thinking..." : "Send Text Only"}
            </button>
            <button style={styles.secondaryButton} onClick={handleReadLastAnswer}>
              Read Answer Aloud
            </button>
          </div>
        </div>

        <div style={styles.settingsPanel}>
          <div style={styles.panelEyebrow}>Settings</div>
          <label style={styles.label}>
            Ollama base URL
            <input
              style={styles.input}
              value={settings.ollamaBaseUrl}
              onChange={(event) =>
                setSettings((current) => ({ ...current, ollamaBaseUrl: event.target.value }))
              }
            />
          </label>
          <label style={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={settings.autoUseVisionModel}
              onChange={(event) =>
                setSettings((current) => ({ ...current, autoUseVisionModel: event.target.checked }))
              }
            />
            Auto-use installed vision model
          </label>
          <label style={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={settings.memoryEnabled}
              onChange={(event) =>
                setSettings((current) => ({ ...current, memoryEnabled: event.target.checked }))
              }
            />
            Inject local memory
          </label>
          <label style={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={settings.includeProjectContext}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  includeProjectContext: event.target.checked
                }))
              }
            />
            Inject project context
          </label>
          <label style={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={settings.saveChatHistory}
              onChange={(event) =>
                setSettings((current) => ({ ...current, saveChatHistory: event.target.checked }))
              }
            />
            Save chat history
          </label>
          <label style={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={settings.saveScreenSummaries}
              onChange={(event) =>
                setSettings((current) => ({ ...current, saveScreenSummaries: event.target.checked }))
              }
            />
            Save screen summaries
          </label>
          <label style={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={settings.privacyMode}
              onChange={(event) =>
                setSettings((current) => ({ ...current, privacyMode: event.target.checked }))
              }
            />
            Privacy mode prevents screenshot/history persistence
          </label>
          <label style={styles.label}>
            Local STT executable path
            <input
              style={styles.input}
              value={settings.localSttExecutablePath}
              placeholder="Optional: C:\\path\\to\\whisper-cli.exe"
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  localSttExecutablePath: event.target.value
                }))
              }
            />
          </label>
          <label style={styles.label}>
            Local STT model path
            <input
              style={styles.input}
              value={settings.localSttModelPath}
              placeholder="Optional: C:\\path\\to\\ggml-small.bin"
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  localSttModelPath: event.target.value
                }))
              }
            />
          </label>
          <label style={styles.label}>
            Local STT arguments template
            <input
              style={styles.input}
              value={settings.localSttArguments}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  localSttArguments: event.target.value
                }))
              }
            />
          </label>
          <label style={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={settings.enableLocalTts}
              onChange={(event) =>
                setSettings((current) => ({ ...current, enableLocalTts: event.target.checked }))
              }
            />
            Enable local read-aloud button
          </label>
          <button style={styles.secondaryButton} onClick={() => void handleSaveSettings()}>
            Save Settings
          </button>
          <div style={styles.infoBox}>
            Voice input: {sttStatus?.message ?? "Checking local STT status."}
          </div>
        </div>

        {infoMessage ? <div style={styles.infoBox}>{infoMessage}</div> : null}
        {ttsMessage ? <div style={styles.infoBox}>{ttsMessage}</div> : null}
        {errorMessage ? <div style={styles.errorBox}>{errorMessage}</div> : null}
      </aside>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  shell: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) 430px",
    minHeight: "100vh",
    background: "#06101d",
    color: "#e2ebff"
  },
  stage: {
    padding: "24px"
  },
  headerBand: {
    display: "flex",
    justifyContent: "space-between",
    gap: "20px",
    alignItems: "stretch",
    marginBottom: "20px"
  },
  eyebrow: {
    fontSize: "12px",
    textTransform: "uppercase",
    color: "#7bb4ff",
    marginBottom: "8px"
  },
  title: {
    margin: 0,
    fontSize: "34px",
    lineHeight: 1.1
  },
  subtitle: {
    margin: "10px 0 0",
    color: "#afc5ea"
  },
  signalCard: {
    width: "360px",
    border: "1px solid #15314d",
    borderRadius: "8px",
    padding: "16px",
    background: "#0b1728"
  },
  signalLabel: {
    fontSize: "12px",
    textTransform: "uppercase",
    color: "#7bb4ff",
    marginBottom: "10px"
  },
  signalValue: {
    fontSize: "18px",
    fontWeight: 600,
    marginBottom: "8px"
  },
  signalHint: {
    color: "#afc5ea",
    fontSize: "13px"
  },
  stageGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: "18px"
  },
  panel: {
    border: "1px solid #15314d",
    borderRadius: "8px",
    padding: "16px",
    background: "#0b1728",
    minHeight: "260px"
  },
  panelHeader: {
    display: "flex",
    justifyContent: "space-between",
    gap: "12px",
    alignItems: "center",
    marginBottom: "14px"
  },
  panelEyebrow: {
    fontSize: "12px",
    textTransform: "uppercase",
    color: "#7bb4ff",
    marginBottom: "6px"
  },
  panelTitle: {
    margin: "0 0 12px",
    fontSize: "20px"
  },
  label: {
    display: "grid",
    gap: "8px",
    fontSize: "14px",
    marginBottom: "12px"
  },
  select: {
    borderRadius: "8px",
    border: "1px solid #23415f",
    padding: "10px 12px",
    background: "#08111e",
    color: "#e2ebff"
  },
  input: {
    borderRadius: "8px",
    border: "1px solid #23415f",
    padding: "10px 12px",
    background: "#08111e",
    color: "#e2ebff"
  },
  modelList: {
    display: "grid",
    gap: "10px",
    maxHeight: "280px",
    overflowY: "auto"
  },
  modelRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: "12px",
    alignItems: "center",
    padding: "10px",
    borderRadius: "8px",
    background: "#08111e",
    border: "1px solid #18324e"
  },
  modelName: {
    fontWeight: 600
  },
  modelMeta: {
    color: "#9db5db",
    fontSize: "13px",
    marginTop: "4px"
  },
  modelBadge: {
    fontSize: "12px",
    color: "#7bb4ff"
  },
  roleMap: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: "8px",
    margin: "10px 0 14px"
  },
  roleItem: {
    display: "grid",
    gap: "4px",
    borderRadius: "8px",
    padding: "9px",
    background: "#08111e",
    border: "1px solid #18324e",
    color: "#afc5ea",
    fontSize: "12px"
  },
  emptyState: {
    color: "#9db5db",
    lineHeight: 1.5,
    padding: "10px 0"
  },
  primaryButton: {
    borderRadius: "8px",
    border: "1px solid #2a77ff",
    padding: "10px 14px",
    background: "#1f68e8",
    color: "#f8fbff",
    cursor: "pointer"
  },
  secondaryButton: {
    borderRadius: "8px",
    border: "1px solid #23415f",
    padding: "9px 12px",
    background: "#102034",
    color: "#f8fbff",
    cursor: "pointer"
  },
  recordingButton: {
    borderRadius: "8px",
    border: "1px solid #ef4444",
    padding: "9px 12px",
    background: "#7f1d1d",
    color: "#fff5f5",
    cursor: "pointer"
  },
  buttonRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "10px",
    margin: "12px 0"
  },
  voiceRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "10px",
    alignItems: "center"
  },
  observationLayout: {
    display: "grid",
    gap: "12px"
  },
  preview: {
    width: "100%",
    borderRadius: "8px",
    border: "1px solid #18324e",
    display: "block"
  },
  observationMeta: {
    display: "grid",
    gap: "5px",
    color: "#afc5ea",
    fontSize: "14px"
  },
  summaryBox: {
    borderRadius: "8px",
    padding: "12px",
    background: "#08111e",
    border: "1px solid #18324e",
    lineHeight: 1.5
  },
  kvGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: "8px",
    color: "#afc5ea",
    fontSize: "14px"
  },
  memoryList: {
    display: "grid",
    gap: "10px",
    maxHeight: "230px",
    overflowY: "auto",
    marginTop: "12px"
  },
  memoryItem: {
    display: "grid",
    gap: "4px",
    borderRadius: "8px",
    padding: "10px",
    background: "#08111e",
    border: "1px solid #18324e",
    color: "#afc5ea",
    fontSize: "13px"
  },
  assistantRail: {
    borderLeft: "1px solid #15314d",
    background: "#08111e",
    padding: "20px",
    display: "grid",
    gridTemplateRows: "auto auto minmax(0, 1fr) auto auto auto auto",
    gap: "14px"
  },
  assistantHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "12px"
  },
  sessionBadge: {
    borderRadius: "999px",
    padding: "6px 10px",
    background: "#102034",
    fontSize: "12px",
    color: "#7bb4ff"
  },
  routerPanel: {
    display: "grid",
    gap: "6px",
    padding: "12px",
    border: "1px solid #15314d",
    borderRadius: "8px",
    background: "#0b1728"
  },
  routerHint: {
    color: "#9db5db",
    fontSize: "12px",
    lineHeight: 1.4
  },
  messagePane: {
    overflowY: "auto",
    display: "grid",
    alignContent: "start",
    gap: "10px",
    paddingRight: "4px"
  },
  messageBubble: {
    borderRadius: "8px",
    padding: "12px",
    border: "1px solid #17314b",
    lineHeight: 1.5
  },
  userBubble: {
    background: "#0d2340"
  },
  assistantBubble: {
    background: "#0b1728"
  },
  messageRole: {
    fontSize: "12px",
    textTransform: "uppercase",
    color: "#7bb4ff",
    marginBottom: "6px"
  },
  inputRow: {
    display: "grid",
    gap: "10px"
  },
  observeAskHeader: {
    borderRadius: "8px",
    padding: "12px",
    background: "#0b1728",
    border: "1px solid #15314d"
  },
  textarea: {
    minHeight: "104px",
    resize: "vertical",
    borderRadius: "8px",
    border: "1px solid #23415f",
    background: "#06101d",
    color: "#e2ebff",
    padding: "12px"
  },
  settingsPanel: {
    display: "grid",
    gap: "10px",
    padding: "14px",
    border: "1px solid #15314d",
    borderRadius: "8px",
    background: "#0b1728"
  },
  checkboxRow: {
    display: "flex",
    gap: "10px",
    alignItems: "center",
    fontSize: "14px"
  },
  infoBox: {
    borderRadius: "8px",
    padding: "12px",
    background: "#0d2340",
    color: "#dbe9ff",
    fontSize: "14px",
    lineHeight: 1.5
  },
  errorBox: {
    borderRadius: "8px",
    padding: "12px",
    background: "#3a1220",
    color: "#ffd7df",
    fontSize: "14px",
    lineHeight: 1.5
  }
};
