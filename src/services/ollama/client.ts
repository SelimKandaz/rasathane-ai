import type { ChatMessage, ModelInfo } from "../../shared/types";

interface OllamaTagEntry {
  name?: string;
  model?: string;
  modified_at?: string;
  size?: number;
  capabilities?: string[];
  details?: {
    format?: string;
    parameter_size?: string;
  };
}

interface OllamaTagsResponse {
  models?: OllamaTagEntry[];
}

interface OllamaChatResponse {
  message?: {
    content?: string;
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

async function requestJson<T>(
  baseUrl: string,
  pathname: string,
  init: RequestInit
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}${pathname}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers ?? {})
      },
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama returned ${response.status}: ${body || response.statusText}`);
    }

    return (await response.json()) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (
      error instanceof Error &&
      (error.name === "AbortError" ||
        /fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(message))
    ) {
      throw new Error(`Could not reach Ollama at ${baseUrl}. Make sure Ollama is running.`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function looksVisionCapable(modelName: string, capabilities: string[] = []): boolean {
  return (
    capabilities.some((capability) => capability.toLowerCase() === "vision") ||
    /llava|bakllava|vision|multimodal|vl/i.test(modelName)
  );
}

function isHiddenFromRasathane(modelName: string): boolean {
  return /^moondream(?::|$)/i.test(modelName);
}

export async function listLocalModels(baseUrl: string): Promise<ModelInfo[]> {
  const payload = await requestJson<OllamaTagsResponse>(baseUrl, "/api/tags", {
    method: "GET"
  });

  return (payload.models ?? [])
    .map((model) => {
      const id = model.model ?? model.name ?? "unknown-model";
      return {
        id,
        name: model.name ?? id,
        size: model.size,
        modifiedAt: model.modified_at,
        format: model.details?.format,
        parameterSize: model.details?.parameter_size,
        capabilities: model.capabilities ?? [],
        visionCapableHint: looksVisionCapable(id, model.capabilities ?? [])
      };
    })
    .filter((model) => !isHiddenFromRasathane(model.id));
}

function mapMessagesForOllama(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => ({
    role: message.role,
    content: message.content
  }));
}

export async function chatWithModel(options: {
  baseUrl: string;
  model: string;
  history: ChatMessage[];
  prompt: string;
  imageBase64?: string;
  systemPrompt?: string;
  contextBlocks?: string[];
  think?: boolean;
  numPredict?: number;
  temperature?: number;
}): Promise<string> {
  const messages: Array<Record<string, unknown>> = [];

  if (options.systemPrompt?.trim()) {
    messages.push({
      role: "system",
      content: options.systemPrompt.trim()
    });
  }

  const compactContext = (options.contextBlocks ?? [])
    .map((block) => block.trim())
    .filter(Boolean)
    .join("\n\n");

  if (compactContext) {
    messages.push({
      role: "system",
      content: compactContext
    });
  }

  const currentMessage: Record<string, unknown> = {
    role: "user",
    content: options.prompt
  };

  if (options.imageBase64) {
    currentMessage.images = [options.imageBase64];
  }

  const payload = await requestJson<OllamaChatResponse>(options.baseUrl, "/api/chat", {
    method: "POST",
    body: JSON.stringify({
      model: options.model,
      messages: [...messages, ...mapMessagesForOllama(options.history), currentMessage],
      stream: false,
      ...(typeof options.think === "boolean" ? { think: options.think } : {}),
      options: {
        ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
        ...(typeof options.numPredict === "number" ? { num_predict: options.numPredict } : {})
      }
    })
  });

  const content = payload.message?.content?.trim();

  if (!content) {
    throw new Error("Ollama returned an empty reply.");
  }

  return content;
}
