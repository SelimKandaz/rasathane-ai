import fs from "fs";
import { promises as fsPromises } from "fs";
import path from "path";
import initSqlJs, { type SqlJsDatabase } from "sql.js";

import type {
  ChatMessage,
  Conversation,
  MemoryItem,
  MemorySnapshot,
  Observation,
  ProjectContextItem,
  SessionSummary,
  RasathaneSettings
} from "../../shared/types";
import { DEFAULT_SETTINGS } from "../settings/defaults";

function titleFromMessage(content: string): string {
  const normalized = content.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "New Session";
  }

  return normalized.slice(0, 48);
}

function resolveWasmPath(): string {
  if (process.mainModule?.filename?.includes("app.asar")) {
    return path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "sql.js",
      "dist",
      "sql-wasm.wasm"
    );
  }

  return path.join(process.cwd(), "node_modules", "sql.js", "dist", "sql-wasm.wasm");
}

export class MemoryDatabase {
  private database: SqlJsDatabase | null = null;
  private databasePath = "";
  private readonly conversations = new Map<string, Conversation>();

  async init(userDataPath: string): Promise<void> {
    const storageDir = path.join(userDataPath, "rasathane");
    await fsPromises.mkdir(storageDir, { recursive: true });

    this.databasePath = path.join(storageDir, "rasathane.sqlite");
    const SQL = await initSqlJs({
      locateFile: () => resolveWasmPath()
    });
    const existingBytes = fs.existsSync(this.databasePath)
      ? fs.readFileSync(this.databasePath)
      : undefined;

    this.database = existingBytes ? new SQL.Database(existingBytes) : new SQL.Database();
    this.database.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        model TEXT,
        observation_id TEXT
      );

      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        source_name TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        image_path TEXT,
        persisted INTEGER NOT NULL,
        summary TEXT,
        vision_model TEXT,
        analysis_status TEXT,
        warning TEXT
      );

      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_context_items (
        id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_summaries (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    this.ensureObservationColumns();

    this.hydrateConversations();
  }

  close(): void {
    this.database?.close();
    this.database = null;
  }

  getSettings(): RasathaneSettings {
    const rows = this.queryRows<{ key: string; value: string }>(
      "SELECT key, value FROM settings"
    );
    const storedSettings: Partial<RasathaneSettings> = {};

    for (const row of rows) {
      storedSettings[row.key as keyof RasathaneSettings] = JSON.parse(row.value);
    }

    return {
      ...DEFAULT_SETTINGS,
      ...storedSettings
    };
  }

  setSettings(partial: Partial<RasathaneSettings>): RasathaneSettings {
    const nextSettings = {
      ...this.getSettings(),
      ...partial
    };

    for (const [key, value] of Object.entries(nextSettings)) {
      this.run(`
        INSERT INTO settings (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `, [key, JSON.stringify(value)]);
    }

    this.persistDatabase();
    return nextSettings;
  }

  getConversation(conversationId: string): Conversation | undefined {
    return this.conversations.get(conversationId);
  }

  getConversations(): Conversation[] {
    return Array.from(this.conversations.values()).sort((left, right) => right.updatedAt - left.updatedAt);
  }

  appendMessage(
    conversationId: string,
    message: ChatMessage,
    persistToDatabase: boolean
  ): Conversation {
    const existing = this.conversations.get(conversationId);
    const conversation =
      existing ??
      {
        id: conversationId,
        title: titleFromMessage(message.content),
        createdAt: message.createdAt,
        updatedAt: message.createdAt,
        messages: []
      };

    conversation.messages.push(message);
    conversation.updatedAt = message.createdAt;
    if (!existing && message.role === "user") {
      conversation.title = titleFromMessage(message.content);
    }

    this.conversations.set(conversationId, conversation);

    if (persistToDatabase) {
      this.run(
        `
          INSERT INTO conversations (id, title, created_at, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            updated_at = excluded.updated_at
        `,
        [conversation.id, conversation.title, conversation.createdAt, conversation.updatedAt]
      );

      this.run(
        `
          INSERT OR REPLACE INTO messages (
            id,
            conversation_id,
            role,
            content,
            created_at,
            model,
            observation_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          message.id,
          conversationId,
          message.role,
          message.content,
          message.createdAt,
          message.model ?? null,
          message.observationId ?? null
        ]
      );
      this.persistDatabase();
    }

    return conversation;
  }

  recordObservation(observation: Observation): void {
    this.run(
      `
        INSERT OR REPLACE INTO observations (
          id,
          created_at,
          source_name,
          width,
          height,
          image_path,
          persisted,
          summary,
          vision_model,
          analysis_status,
          warning
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        observation.id,
        observation.createdAt,
        observation.sourceName,
        observation.width,
        observation.height,
        observation.imagePath,
        observation.persisted ? 1 : 0,
        observation.summary,
        observation.visionModel,
        observation.analysisStatus,
        observation.warning
      ]
    );

    this.persistDatabase();
  }

  getLatestObservation(): Observation | null {
    const rows = this.queryRows<{
      id: string;
      created_at: number;
      source_name: string;
      width: number;
      height: number;
      image_path: string | null;
      persisted: number;
      summary: string | null;
      vision_model: string | null;
      analysis_status: "not_requested" | "analyzed" | "warning" | "failed" | null;
      warning: string | null;
    }>(`
      SELECT id, created_at, source_name, width, height, image_path, persisted,
             summary, vision_model, analysis_status, warning
      FROM observations
      ORDER BY created_at DESC
      LIMIT 1
    `);

    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      createdAt: row.created_at,
      sourceName: row.source_name,
      width: row.width,
      height: row.height,
      imagePath: row.image_path,
      previewDataUrl: null,
      persisted: Boolean(row.persisted),
      pendingForNextMessage: false,
      summary: row.summary,
      visionModel: row.vision_model,
      analysisStatus: row.analysis_status ?? "not_requested",
      warning: row.warning
    };
  }

  replaceProjectContextItems(items: ProjectContextItem[]): void {
    this.run("DELETE FROM project_context_items");

    for (const item of items) {
      this.run(
        `
          INSERT INTO project_context_items (id, source_path, title, summary, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `,
        [item.id, item.sourcePath, item.title, item.summary, item.updatedAt]
      );
    }

    this.persistDatabase();
  }

  getProjectContextItems(): ProjectContextItem[] {
    return this.queryRows<{
      id: string;
      source_path: string;
      title: string;
      summary: string;
      updated_at: number;
    }>("SELECT id, source_path, title, summary, updated_at FROM project_context_items ORDER BY title").map(
      (row) => ({
        id: row.id,
        sourcePath: row.source_path,
        title: row.title,
        summary: row.summary,
        updatedAt: row.updated_at
      })
    );
  }

  upsertMemoryItem(item: MemoryItem): void {
    this.run(
      `
        INSERT INTO memory_items (id, type, title, content, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          type = excluded.type,
          title = excluded.title,
          content = excluded.content,
          updated_at = excluded.updated_at
      `,
      [item.id, item.type, item.title, item.content, item.createdAt, item.updatedAt]
    );
    this.persistDatabase();
  }

  getMemoryItems(): MemoryItem[] {
    return this.queryRows<{
      id: string;
      type: "preference" | "project_fact" | "benchmark_fact" | "session_summary";
      title: string;
      content: string;
      created_at: number;
      updated_at: number;
    }>("SELECT id, type, title, content, created_at, updated_at FROM memory_items ORDER BY updated_at DESC LIMIT 20").map(
      (row) => ({
        id: row.id,
        type: row.type,
        title: row.title,
        content: row.content,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      })
    );
  }

  saveSessionSummary(summary: SessionSummary): void {
    this.run(
      `
        INSERT INTO session_summaries (id, conversation_id, summary, created_at)
        VALUES (?, ?, ?, ?)
      `,
      [summary.id, summary.conversationId, summary.summary, summary.createdAt]
    );
    this.upsertMemoryItem({
      id: `memory-${summary.id}`,
      type: "session_summary",
      title: `Session ${summary.conversationId}`,
      content: summary.summary,
      createdAt: summary.createdAt,
      updatedAt: summary.createdAt
    });
    this.persistDatabase();
  }

  clearMemory(): void {
    this.run("DELETE FROM memory_items");
    this.run("DELETE FROM session_summaries");
    this.run("DELETE FROM project_context_items");
    this.run("DELETE FROM observations");
    this.persistDatabase();
  }

  getMemorySnapshot(settings: RasathaneSettings): MemorySnapshot {
    const count = (table: string): number => {
      const rows = this.queryRows<{ count_value: number }>(`SELECT COUNT(*) as count_value FROM ${table}`);
      return Number(rows[0]?.count_value ?? 0);
    };

    return {
      memoryEnabled: settings.memoryEnabled,
      privacyMode: settings.privacyMode,
      conversationCount: count("conversations"),
      messageCount: count("messages"),
      observationCount: count("observations"),
      memoryItemCount: count("memory_items"),
      projectContextCount: count("project_context_items"),
      latestObservation: this.getLatestObservation(),
      projectContextItems: this.getProjectContextItems(),
      memoryItems: this.getMemoryItems()
    };
  }

  private hydrateConversations(): void {
    const conversations = this.queryRows<{
      id: string;
      title: string;
      created_at: number;
      updated_at: number;
    }>(`
      SELECT id, title, created_at, updated_at
      FROM conversations
      ORDER BY updated_at DESC
    `);

    const messages = this.queryRows<{
      id: string;
      conversation_id: string;
      role: "system" | "user" | "assistant";
      content: string;
      created_at: number;
      model: string | null;
      observation_id: string | null;
    }>(`
      SELECT id, conversation_id, role, content, created_at, model, observation_id
      FROM messages
      ORDER BY created_at ASC
    `);

    for (const row of conversations) {
      this.conversations.set(row.id, {
        id: row.id,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        messages: []
      });
    }

    for (const row of messages) {
      const conversation = this.conversations.get(row.conversation_id);
      if (!conversation) {
        continue;
      }

      conversation.messages.push({
        id: row.id,
        role: row.role,
        content: row.content,
        createdAt: row.created_at,
        model: row.model ?? undefined,
        observationId: row.observation_id
      });
    }
  }

  private queryRows<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    if (!this.database) {
      return [];
    }

    const statement = this.database.prepare(sql);
    statement.bind(params);

    const rows: T[] = [];
    while (statement.step()) {
      rows.push(statement.getAsObject() as T);
    }

    statement.free();
    return rows;
  }

  private run(sql: string, params: unknown[] = []): void {
    if (!this.database) {
      return;
    }

    this.database.run(sql, params);
  }

  private persistDatabase(): void {
    if (!this.database || !this.databasePath) {
      return;
    }

    const bytes = this.database.export();
    fs.writeFileSync(this.databasePath, Buffer.from(bytes));
  }

  private ensureObservationColumns(): void {
    for (const statement of [
      "ALTER TABLE observations ADD COLUMN summary TEXT",
      "ALTER TABLE observations ADD COLUMN vision_model TEXT",
      "ALTER TABLE observations ADD COLUMN analysis_status TEXT",
      "ALTER TABLE observations ADD COLUMN warning TEXT"
    ]) {
      try {
        this.run(statement);
      } catch {
        // Existing V1 databases may already have the column after a previous V1.1 run.
      }
    }
  }
}
