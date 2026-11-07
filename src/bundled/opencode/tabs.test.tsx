// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent, Models } from "../../features/agents/service";
import type { Modes } from "./models";
import { type Config, DEFAULT_CONFIG } from "./runtime";
import { createTabs } from "./tabs";
import { openCodeTurns } from "./transcript";

beforeEach(() => {
  // jsdom has no layout observers; the model picker sizes itself with one.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// OpenCode lists thinking levels only for its own default model.
const MODELS: Models = {
  current: "omlx/qwen",
  models: [
    {
      id: "omlx/qwen",
      label: "Qwen",
      efforts: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
      effort: "low",
    },
    { id: "openrouter/sonnet", label: "Sonnet", efforts: [] },
  ],
};

const MODES: Modes = {
  current: "build",
  modes: [
    { id: "build", label: "Build" },
    { id: "plan", label: "Plan" },
  ],
};
const modes = async () => MODES;

/** Two saved conversations; the thread's session is running. */
function fakeRuntime() {
  const labels = new Map([["chan", { name: "general" }]]);
  // As the runtime's, the same snapshot until a session changes.
  const live = [{ key: "chan/root", busy: true, sessionId: "ses_live" }];
  return {
    subscribe: () => () => {},
    sessions: () => live,
    conversations: () => [
      { key: "chan/root", at: 2_000, sessions: ["ses_old"] },
      { key: "other", at: 1_000, sessions: ["ses_other"] },
    ],
    channelLabel: (_agent: string, channelId: string) => labels.get(channelId),
    transcript: vi.fn(
      async (
        _agent: string,
        row: { channelId: string; root?: string; sessions: readonly string[] },
      ) => ({
        more: false,
        turns: openCodeTurns(
          {
            info: { id: row.sessions[0] ?? "" },
            messages: [
              {
                type: "user",
                id: "u",
                time: { created: 1 },
                text: `Hello from ${row.sessions[0]}`,
              },
              {
                type: "assistant",
                id: "a",
                time: { created: 2 },
                content: [{ type: "text", text: "Hi there" }],
              },
            ],
          },
          row,
          false,
        ),
      }),
    ),
  };
}
const runtime = fakeRuntime();

const AGENT = {
  key: "c".repeat(64),
  pubkey: "c".repeat(64),
  name: "oc",
  type: "buzz.opencode/opencode",
  owner: "a".repeat(64),
  config: { ...DEFAULT_CONFIG, instructions: "Track UAT." },
} as Agent<Config>;

async function choose(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

it("shows OpenCode's agent, model, thinking level and instructions in Identity, and its folder in Settings", async () => {
  const { SettingsTab } = createTabs({
    models: async () => MODELS,
    modes,
    runtime,
  });
  const save = vi.fn(async () => {});
  const { rerender } = render(
    <SettingsTab agent={AGENT} save={save} settingsSection="identity" />,
  );
  const thinking = screen.getByRole("combobox", { name: "Thinking" });
  await waitFor(() => expect(thinking).toHaveTextContent("Low · Default"));
  expect(screen.getByLabelText("Instructions")).toHaveValue("Track UAT.");
  expect(screen.queryByRole("textbox", { name: "Workspace" })).toBeNull();

  const agent = screen.getByRole("combobox", { name: "OpenCode agent" });
  await waitFor(() => expect(agent).toHaveTextContent("Build"));
  await choose("OpenCode agent", "Plan");
  await choose("Thinking", "High");
  // OpenCode lists no levels for another model, so the pick goes back to its.
  await choose("Model", "Sonnet");
  expect(thinking).toHaveTextContent("Default");
  await choose("Model", "Qwen");
  await choose("Thinking", "High");

  rerender(<SettingsTab agent={AGENT} save={save} settingsSection="runtime" />);
  expect(screen.queryByRole("combobox", { name: "Thinking" })).toBeNull();
  await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith({
    ...AGENT.config,
    mode: "plan",
    model: "omlx/qwen",
    effort: "high",
  });
});

it("says when OpenCode's models could not be listed, and lists them again", async () => {
  const models = vi
    .fn<() => Promise<Models>>()
    .mockRejectedValueOnce(new Error("opencode is not installed"))
    .mockResolvedValue(MODELS);
  const { SettingsTab } = createTabs({ models, modes, runtime });
  render(
    <SettingsTab agent={AGENT} save={vi.fn()} settingsSection="identity" />,
  );
  expect(
    await screen.findByText(/Could not list models: opencode is not installed/),
  ).toBeVisible();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Thinking" }),
    ).toHaveTextContent("Low · Default"),
  );
  expect(models).toHaveBeenCalledTimes(2);
});

it("refuses to save a relative workspace", async () => {
  const { SettingsTab } = createTabs({
    models: async () => MODELS,
    modes,
    runtime,
  });
  const save = vi.fn(async () => {});
  render(<SettingsTab agent={AGENT} save={save} settingsSection="runtime" />);
  const user = userEvent.setup();
  const workspace = screen.getByRole("textbox", { name: "Workspace" });
  await user.clear(workspace);
  await user.type(workspace, "repo");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Enter an absolute or ~/… workspace path.",
  );
  expect(save).not.toHaveBeenCalled();
});

it("starts a new agent on the chosen OpenCode agent and workspace", async () => {
  const { Create } = createTabs({ models: async () => MODELS, modes, runtime });
  const onChange = vi.fn();
  const { rerender } = render(
    <Create config={DEFAULT_CONFIG} onChange={onChange} disabled={false} />,
  );
  await choose("OpenCode agent", "Plan");
  expect(onChange).toHaveBeenLastCalledWith({
    ...DEFAULT_CONFIG,
    mode: "plan",
  });
  rerender(
    <Create
      config={{ ...DEFAULT_CONFIG, workspace: "repo" }}
      onChange={onChange}
      disabled={false}
    />,
  );
  expect(
    screen.getByText("Enter an absolute or ~/… workspace path."),
  ).toBeVisible();
});

it("lists the agent's conversations in Activity, and shows a session's transcript", async () => {
  const runtime = fakeRuntime();
  const { ActivityTab } = createTabs({
    models: async () => MODELS,
    modes,
    runtime,
  });
  render(
    <ActivityTab
      agent={AGENT}
      conversation={{ channelId: "chan", rootId: "root" }}
    />,
  );
  const user = userEvent.setup();
  const here = await screen.findByRole("region", { name: "This thread" });
  expect(here).toHaveTextContent("general");
  expect(here).toHaveTextContent("Working");
  expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual(
    [expect.stringMatching(/^otherChannel · /)],
  );

  await user.click(
    within(here).getByRole("button", { name: /^View transcript/ }),
  );
  // The running session comes first, before the saved one.
  expect(
    await screen.findByText("Hello from ses_live", {
      selector: "summary span",
    }),
  ).toBeVisible();
  expect(runtime.transcript).toHaveBeenLastCalledWith(
    AGENT.key,
    expect.objectContaining({ sessions: ["ses_live", "ses_old"] }),
    true,
    expect.any(AbortSignal),
  );
  await user.click(screen.getByRole("button", { name: "Back to profile" }));
  await user.click(
    within(screen.getByRole("listitem")).getByRole("button", {
      name: "View transcript: other · channel",
    }),
  );
  expect(
    await screen.findByText("Hello from ses_other", {
      selector: "summary span",
    }),
  ).toBeVisible();

  runtime.transcript.mockRejectedValueOnce(new Error("opencode stopped"));
  await user.click(screen.getByRole("button", { name: "Refresh transcript" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not read the OpenCode session: opencode stopped",
  );
});
