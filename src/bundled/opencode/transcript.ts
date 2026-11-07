// A Buzz conversation's opencode sessions, read back with `opencode session
// export` and shown in the host's turn-transcript model. opencode keeps the
// sessions in its own storage; nothing here writes or keeps them.
import { isMessageTool } from "../../buzz-mcp/session-tools";
import { readEventBody } from "../../features/agent-harness/turn-records";
import {
  promptMessage,
  promptSections,
  STEER,
  type ToolItem,
  type Transcript,
  type TranscriptItem,
  type TranscriptTurn,
} from "../../features/agents/activity-transcript";
import type { Spawn } from "../../features/agent-harness/acp/types";

/** The latest turns shown; opencode keeps the rest. */
export const TURN_LIMIT = 50;
/** The process the manifest declares as `opencode session export`. */
export const EXPORT_PROCESS = "export";
const PREFIX = "buzz_";
/** An opencode session id: anything else is never passed to the command. */
const SESSION_ID = /^ses_[A-Za-z0-9]{1,128}$/;
const KINDS: Record<string, string> = {
  read: "read",
  write: "edit",
  edit: "edit",
  bash: "execute",
  shell: "execute",
  grep: "search",
  glob: "search",
  webfetch: "fetch",
};

type Json = Readonly<Record<string, unknown>>;
type Part = Readonly<{
  type: string;
  id?: string;
  text?: string;
  name?: string;
  state?: Readonly<{
    status?: string;
    input?: unknown;
    content?: unknown;
    error?: unknown;
  }>;
  time?: Readonly<{ created?: number; completed?: number }>;
}>;
/** A message as `opencode session export` prints it. */
export type ExportedMessage = Readonly<{
  type: string;
  id?: string;
  time?: Readonly<{ created?: number; completed?: number }>;
  /** A user, synthetic or system message's text. */
  text?: string;
  /** An assistant message's parts. */
  content?: readonly Part[];
  model?: Readonly<{ id?: string; providerID?: string }>;
  agent?: string;
  error?: Readonly<{ type?: string; message?: string }> | null;
  /** How an `idle` message says the run ended. */
  outcome?: string;
}>;
export type ExportedSession = Readonly<{
  info: Readonly<{ id: string }>;
  messages: readonly ExportedMessage[];
}>;
/** The Buzz conversation a session belongs to. */
export type Conversation = Readonly<{ channelId: string; root?: string }>;
export type OpenCodeTranscript = Transcript & { more: boolean };
/** A person's display name, if known. */
type Names = (pubkey: string) => string | undefined;

const str = (value: unknown) => (typeof value === "string" ? value : "");
const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
/** A tool result's text parts, joined. */
const texts = (content: unknown) =>
  (Array.isArray(content) ? content : [])
    .map((part) => str(object(part).text))
    .filter(Boolean)
    .join("\n");

/** A Buzz prompt, or a steer, as the turn's opening item. */
function prompt(
  id: string,
  at: number,
  raw: string,
  name?: Names,
): TranscriptItem & { type: "prompt" } {
  let sections = promptSections(raw);
  const steer = sections.find((section) => section.tag === STEER);
  // An older steer wraps a whole turn.
  if (steer && !readEventBody(steer.body))
    sections = promptSections(steer.body);
  const { text, author, authorPubkey } = promptMessage(sections, name);
  return {
    id,
    at,
    type: "prompt",
    text: text || raw,
    ...(author ? { author } : {}),
    ...(authorPubkey ? { authorPubkey } : {}),
    sections,
    steer: !!steer,
  };
}

/** One opencode session's messages, oldest first, as turns, each opened by a
 * prompt. opencode exports a session whole, so its first turn starts it. */
export function openCodeTurns(
  session: ExportedSession,
  conversation: Conversation,
  working: boolean,
  name?: Names,
): TranscriptTurn[] {
  const sessionId = session.info.id;
  const turns: TranscriptTurn[] = [];
  const tools = new Map<string, ToolItem>();
  let last = 0;
  const turn = (id: string, at: number, partial: boolean) => {
    const current = turns.at(-1);
    if (current) current.endedAt = Math.max(last, current.startedAt);
    const next: TranscriptTurn = {
      turnId: id,
      channelId: conversation.channelId,
      threadRootId: conversation.root ?? null,
      triggeringEventIds: [],
      sessionId,
      newSession: !turns.length && !partial,
      config: [],
      startedAt: at,
      partial,
      items: [],
    };
    turns.push(next);
    return next;
  };
  session.messages.forEach((message, position) => {
    const id = message.id || `${sessionId}:${position}`;
    const at = message.time?.created ?? last;
    if (message.type === "user") {
      const item = prompt(id, at, str(message.text), name);
      const current = item.steer ? turns.at(-1) : undefined;
      (current ?? turn(id, at, false)).items.push(item);
      last = at;
      return;
    }
    // What opencode loaded or noted for itself, not part of the conversation.
    if (message.type === "synthetic" || message.type === "system") return;
    const current = turns.at(-1) ?? turn(id, at, true);
    last = Math.max(last, message.time?.completed ?? at);
    if (message.type === "agent-switched") {
      if (message.agent)
        current.items.push({
          id,
          at,
          type: "status",
          text: `Switched to the ${message.agent} agent`,
        });
      return;
    }
    if (message.type === "idle") {
      if (message.outcome && message.outcome !== "succeeded")
        current.stopReason =
          message.outcome === "aborted" ? "stopped" : message.outcome;
      return;
    }
    if (message.type !== "assistant") return;
    const model = [message.model?.providerID, message.model?.id]
      .filter(Boolean)
      .join("/");
    for (const value of [message.agent, model])
      if (value && !current.config.includes(value)) current.config.push(value);
    if (message.error?.type === "aborted") current.stopReason = "stopped";
    else if (message.error)
      current.error = message.error.message || "The model did not answer";
    (message.content ?? []).forEach((part, index) => {
      const key = `${id}:${index}`;
      const partAt = part.time?.created ?? at;
      if (part.type === "text" && part.text?.trim())
        current.items.push({
          id: key,
          at: partAt,
          type: "message",
          text: part.text,
        });
      else if (part.type === "reasoning" && part.text?.trim())
        current.items.push({
          id: key,
          at: partAt,
          type: "thought",
          text: part.text,
        });
      else if (part.type === "tool") {
        const tool = str(part.name);
        const input = object(part.state?.input);
        const status = part.state?.status;
        const failed = status === "error";
        const failure =
          str(object(part.state?.error).message) || str(part.state?.error);
        if (
          tool.startsWith(PREFIX) &&
          isMessageTool(tool.slice(PREFIX.length)) &&
          str(input.text).trim()
        ) {
          current.items.push({
            id: key,
            at: partAt,
            type: "message",
            text: str(input.text),
            ...(status === "completed" ? { posted: true } : {}),
          });
          if (failed)
            current.items.push({
              id: `${key}:failed`,
              at: part.time?.completed ?? partAt,
              type: "status",
              text: `The message above was not posted: ${failure || "the tool failed"}`,
            });
          return;
        }
        const path = str(input.filePath) || str(input.path);
        const item: ToolItem = {
          id: key,
          at: partAt,
          type: "tool",
          toolCallId: str(part.id) || key,
          // Buzz tools as Claude's transcript names them: buzz.read.
          title:
            str(input.command) ||
            (tool.startsWith(PREFIX)
              ? `buzz.${tool.slice(PREFIX.length)}`
              : tool),
          kind: KINDS[tool] ?? "other",
          status:
            status === "completed"
              ? "completed"
              : failed
                ? "failed"
                : "in_progress",
          input: JSON.stringify(input, null, 2),
          output: texts(part.state?.content) || failure,
          diffs: [],
          paths: path ? [path] : [],
          ...(part.time?.completed ? { completedAt: part.time.completed } : {}),
          truncated: false,
        };
        // A call made again under the same id replaces the earlier one.
        const earlier = tools.get(item.toolCallId);
        if (earlier) Object.assign(earlier, item);
        else {
          tools.set(item.toolCallId, item);
          current.items.push(item);
        }
      }
    });
  });
  const current = turns.at(-1);
  if (current && !working) current.endedAt = Math.max(last, current.startedAt);
  return turns;
}

/** `opencode session export <id>`'s JSON, or a rejection saying why not. */
export async function exportSession(
  spawn: Spawn,
  id: string,
  signal: AbortSignal,
): Promise<ExportedSession> {
  if (!SESSION_ID.test(id)) throw new Error(`Not an opencode session: ${id}`);
  signal.throwIfAborted();
  let text = "";
  let errors = "";
  const process = await spawn(EXPORT_PROCESS, {
    args: [id],
    cwd: "~",
    onStdout: (data) => {
      text += data;
    },
    onStderr: (data) => {
      errors += data;
    },
  });
  const stop = () => void process.kill();
  signal.addEventListener("abort", stop, { once: true });
  let code: number | null;
  try {
    code = await process.exited;
  } finally {
    signal.removeEventListener("abort", stop);
  }
  signal.throwIfAborted();
  if (code !== 0)
    throw new Error(
      `Couldn’t read the opencode session: ${(errors || text).trim() || `exit ${code}`}`,
    );
  const value = object(JSON.parse(text));
  const info = object(value.info);
  if (str(info.id) !== id || !Array.isArray(value.messages))
    throw new Error("opencode printed an unexpected session export");
  return value as unknown as ExportedSession;
}

/** The conversation's latest turns: its sessions, newest first as they are
 * saved, read until there are more than enough. */
export async function readTranscript(
  spawn: Spawn,
  sessions: readonly string[],
  conversation: Conversation,
  working: boolean,
  signal: AbortSignal,
  name?: Names,
): Promise<OpenCodeTranscript> {
  const read: TranscriptTurn[][] = [];
  let count = 0;
  let index = 0;
  for (; index < sessions.length && count <= TURN_LIMIT; index++) {
    const id = sessions[index];
    if (!id) continue;
    const turns = openCodeTurns(
      await exportSession(spawn, id, signal),
      conversation,
      // Only the newest session can still be running.
      working && index === 0,
      name,
    );
    read.unshift(turns);
    count += turns.length;
  }
  const all = read.flat();
  return {
    turns: all.slice(-TURN_LIMIT),
    more: all.length > TURN_LIMIT || index < sessions.length,
  };
}
