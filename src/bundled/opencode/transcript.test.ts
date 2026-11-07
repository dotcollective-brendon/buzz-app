import { expect, it, vi } from "vitest";
import type { HostProcessOptions } from "../../features/host/service";
import {
  EXPORT_PROCESS,
  type ExportedSession,
  exportSession,
  openCodeTurns,
  readTranscript,
  TURN_LIMIT,
} from "./transcript";

const PLACE = { channelId: "c".repeat(36), root: "r".repeat(64) };

// The shapes `opencode session export` prints, trimmed.
const SESSION: ExportedSession = {
  info: { id: "ses_one" },
  messages: [
    {
      type: "synthetic",
      id: "msg_0",
      time: { created: 900 },
      text: "Instructions from: AGENTS.md",
    },
    { type: "user", id: "msg_1", time: { created: 1000 }, text: "hello" },
    {
      type: "assistant",
      id: "msg_2",
      time: { created: 1100, completed: 1500 },
      agent: "build",
      model: { id: "claude-opus", providerID: "quotio" },
      error: null,
      content: [
        { type: "reasoning", text: "" },
        { type: "reasoning", text: "Looking at the repo." },
        { type: "text", text: "On it." },
        {
          type: "tool",
          id: "toolu_1",
          name: "shell",
          state: {
            status: "completed",
            input: { command: "git status" },
            content: [{ type: "text", text: "clean" }],
          },
          time: { created: 1200, completed: 1300 },
        },
        {
          type: "tool",
          id: "toolu_2",
          name: "read",
          state: {
            status: "error",
            input: { filePath: "/w/a.ts" },
            content: null,
            error: { type: "tool.failed", message: "no such file" },
          },
          time: { created: 1300, completed: 1350 },
        },
        {
          type: "tool",
          id: "toolu_3",
          name: "buzz_send",
          state: {
            status: "completed",
            input: { text: "Done: it's clean." },
            content: [{ type: "text", text: "Sent." }],
          },
          time: { created: 1400, completed: 1450 },
        },
      ],
    },
    {
      type: "idle",
      id: "msg_3",
      time: { created: 1500 },
      outcome: "succeeded",
    },
    { type: "user", id: "msg_4", time: { created: 2000 }, text: "plan it" },
    {
      type: "agent-switched",
      id: "msg_5",
      time: { created: 2001 },
      agent: "plan",
    },
    {
      type: "assistant",
      id: "msg_6",
      time: { created: 2100 },
      agent: "plan",
      model: { id: "claude-opus", providerID: "quotio" },
      error: { type: "aborted", message: "Aborted" },
      content: [{ type: "text", text: "First," }],
    },
    { type: "idle", id: "msg_7", time: { created: 2200 }, outcome: "aborted" },
  ],
};

it("turns an opencode session into turns opened by its prompts", () => {
  const turns = openCodeTurns(SESSION, PLACE, false);
  expect(turns).toHaveLength(2);
  const [first, second] = turns;
  expect(first).toMatchObject({
    turnId: "msg_1",
    channelId: PLACE.channelId,
    threadRootId: PLACE.root,
    sessionId: "ses_one",
    newSession: true,
    partial: false,
    config: ["build", "quotio/claude-opus"],
    startedAt: 1000,
    endedAt: 1500,
  });
  expect(
    first?.items.map((item) =>
      item.type === "tool"
        ? [item.type, item.title, item.kind, item.status, item.output]
        : [
            item.type,
            "text" in item ? item.text : "",
            "posted" in item && item.posted,
          ],
    ),
  ).toEqual([
    ["prompt", "hello", false],
    ["thought", "Looking at the repo.", false],
    ["message", "On it.", false],
    ["tool", "git status", "execute", "completed", "clean"],
    ["tool", "read", "read", "failed", "no such file"],
    ["message", "Done: it's clean.", true],
  ]);
  const read = first?.items[4];
  expect(read?.type === "tool" && read.paths).toEqual(["/w/a.ts"]);
  expect(second).toMatchObject({
    newSession: false,
    stopReason: "stopped",
    config: ["plan", "quotio/claude-opus"],
  });
  expect(second?.items.map((item) => item.type)).toEqual([
    "prompt",
    "status",
    "message",
  ]);
  expect(second?.items[1]).toMatchObject({
    text: "Switched to the plan agent",
  });
  // A running session's last turn has not ended.
  expect(openCodeTurns(SESSION, PLACE, true).at(-1)?.endedAt).toBeUndefined();
});

it("says when a send failed, and reports a model error", () => {
  const [turn] = openCodeTurns(
    {
      info: { id: "ses_two" },
      messages: [
        { type: "user", id: "u", time: { created: 1 }, text: "hi" },
        {
          type: "assistant",
          id: "a",
          time: { created: 2 },
          error: { type: "api", message: "Rate limited" },
          content: [
            {
              type: "tool",
              id: "t",
              name: "buzz_send",
              state: {
                status: "error",
                input: { text: "hey" },
                error: { message: "relay refused" },
              },
            },
          ],
        },
      ],
    },
    PLACE,
    false,
  );
  expect(turn?.error).toBe("Rate limited");
  expect(turn?.items.slice(1)).toMatchObject([
    { type: "message", text: "hey" },
    {
      type: "status",
      text: "The message above was not posted: relay refused",
    },
  ]);
  expect(turn?.items[1]).not.toHaveProperty("posted");
});

/** A host whose `export` process prints `sessions[id]`, or fails. */
function host(sessions: Record<string, ExportedSession>) {
  const runs: { id: string; options: HostProcessOptions }[] = [];
  const spawn = vi.fn(async (id: string, options: HostProcessOptions = {}) => {
    runs.push({ id, options });
    const session = sessions[options.args?.[0] ?? ""];
    queueMicrotask(() => {
      if (session) options.onStdout?.(JSON.stringify(session, null, 2));
      else options.onStderr?.(`Session not found: ${options.args?.[0]}\n`);
    });
    return {
      write: async () => {},
      end: async () => {},
      kill: async () => {},
      exited: new Promise<number | null>((resolve) =>
        setTimeout(() => resolve(session ? 0 : 1)),
      ),
    };
  });
  return { spawn, runs };
}

it("exports a session with the declared process, and refuses other ids", async () => {
  const { spawn, runs } = host({ ses_one: SESSION });
  const signal = new AbortController().signal;
  await expect(exportSession(spawn, "ses_one", signal)).resolves.toEqual(
    SESSION,
  );
  expect(runs).toMatchObject([
    { id: EXPORT_PROCESS, options: { args: ["ses_one"], cwd: "~" } },
  ]);
  await expect(exportSession(spawn, "--server=x", signal)).rejects.toThrow(
    "Not an opencode session",
  );
  await expect(exportSession(spawn, "ses_gone", signal)).rejects.toThrow(
    "Couldn’t read the opencode session: Session not found: ses_gone",
  );
  expect(runs).toHaveLength(2);
});

it("reads a conversation's sessions newest first until there are enough turns", async () => {
  const many = (id: string, count: number): ExportedSession => ({
    info: { id },
    messages: Array.from({ length: count }, (_, index) => ({
      type: "user",
      id: `${id}:${index}`,
      time: { created: index },
      text: `turn ${index}`,
    })),
  });
  const { spawn, runs } = host({
    ses_new: many("ses_new", 3),
    ses_mid: many("ses_mid", TURN_LIMIT),
    ses_old: many("ses_old", 5),
  });
  const read = await readTranscript(
    spawn,
    ["ses_new", "ses_mid", "ses_old"],
    PLACE,
    false,
    new AbortController().signal,
  );
  // The oldest session isn't needed: the two newer ones already overflow.
  expect(runs.map((run) => run.options.args)).toEqual([
    ["ses_new"],
    ["ses_mid"],
  ]);
  expect(read.more).toBe(true);
  expect(read.turns).toHaveLength(TURN_LIMIT);
  expect(read.turns.at(-1)?.turnId).toBe("ses_new:2");
  expect(read.turns.at(0)?.sessionId).toBe("ses_mid");
  expect(read.turns.find((turn) => turn.turnId === "ses_new:0")).toMatchObject({
    newSession: true,
  });
});
