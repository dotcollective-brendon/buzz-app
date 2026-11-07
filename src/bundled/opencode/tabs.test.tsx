// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent, Models } from "../../features/agents/service";
import type { Modes } from "./models";
import { type Config, DEFAULT_CONFIG } from "./runtime";
import { createTabs } from "./tabs";

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
  const { SettingsTab } = createTabs({ models: async () => MODELS, modes });
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
  const { SettingsTab } = createTabs({ models, modes });
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
  const { SettingsTab } = createTabs({ models: async () => MODELS, modes });
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
  const { Create } = createTabs({ models: async () => MODELS, modes });
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
