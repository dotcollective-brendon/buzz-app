// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent, Models } from "../../features/agents/service";
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

it("shows OpenCode's model, thinking level and instructions in Identity, and its folder in Settings", async () => {
  const { SettingsTab } = createTabs({ models: async () => MODELS });
  const save = vi.fn(async () => {});
  const { rerender } = render(
    <SettingsTab agent={AGENT} save={save} settingsSection="identity" />,
  );
  const thinking = screen.getByRole("combobox", { name: "Thinking" });
  await waitFor(() => expect(thinking).toHaveTextContent("Low · Default"));
  expect(screen.getByLabelText("Instructions")).toHaveValue("Track UAT.");
  expect(screen.queryByRole("textbox", { name: "Workspace" })).toBeNull();

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
    model: "omlx/qwen",
    effort: "high",
  });
});

it("says when OpenCode's models could not be listed, and lists them again", async () => {
  const models = vi
    .fn<() => Promise<Models>>()
    .mockRejectedValueOnce(new Error("opencode is not installed"))
    .mockResolvedValue(MODELS);
  const { SettingsTab } = createTabs({ models });
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
