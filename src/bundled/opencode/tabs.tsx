// OpenCode's New agent choices and agent settings: which opencode agent it
// runs as, its model and thinking level, instructions, folder and conversation
// scope. Agents, models and levels are listed from `opencode acp`.
import { useEffect, useId, useRef, useState } from "react";
import { errorText } from "../../buzz-mcp/rpc";
import { AgentInstructions } from "../../features/agents/AgentInstructions";
import { AgentSaveButton } from "../../features/agents/AgentSaveButton";
import { ModelPicker } from "../../features/agents/ModelPicker";
import type {
  AgentCreateProps,
  AgentViewProps,
  Models,
} from "../../features/agents/service";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { validWorkspace } from "../codex/config";
import type { Modes } from "./models";
import { type Config, DEFAULT_CONFIG, config as readConfig } from "./runtime";

const SCOPES = [
  {
    label: "",
    options: [
      { value: "thread", label: "One conversation per thread" },
      { value: "channel", label: "One conversation per channel" },
    ],
  },
];
const WORKSPACE_DESCRIPTION =
  "The folder OpenCode works in. Use ~/ for your home folder.";
const WORKSPACE_ERROR = "Enter an absolute or ~/… workspace path.";

type Read<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; error: string };

/** `read()` as it settles, read again on `retry`. */
function useRead<T>(read: () => Promise<T>) {
  const [state, setState] = useState<Read<T>>({ status: "loading" });
  const [round, setRound] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` reads again.
  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    read().then(
      (value) => current && setState({ status: "ready", value }),
      (reason: unknown) =>
        current && setState({ status: "error", error: errorText(reason) }),
    );
    return () => {
      current = false;
    };
  }, [read, round]);
  return [state, () => setRound((value) => value + 1)] as const;
}

/** The thinking levels OpenCode lists for the model `model` runs on; it lists
 * them only for its own default model, so another one has none. */
const levelsOf = (model: string, models: Models | undefined) =>
  models?.models.find((item) => item.id === (model || models.current))
    ?.efforts ?? [];

export function createTabs({
  models,
  modes,
}: Readonly<{
  models: () => Promise<Models>;
  modes: () => Promise<Modes>;
}>) {
  /** The opencode agent turns run as: opencode's default, or one it lists. */
  function ModeField({
    value,
    disabled = false,
    onChange,
  }: Readonly<{
    value: string;
    disabled?: boolean;
    onChange(mode: string): void;
  }>) {
    const [listed] = useRead(modes);
    const offered = listed.status === "ready" ? listed.value.modes : [];
    const fallback =
      (listed.status === "ready" &&
        offered.find((mode) => mode.id === listed.value.current)?.label) ||
      (listed.status === "ready" && listed.value.current) ||
      "OpenCode default";
    return (
      <Select
        label="OpenCode agent"
        variant="preference"
        value={value}
        {...(!value ? { valueLabel: fallback } : {})}
        disabled={disabled}
        {...(listed.status === "error"
          ? { description: `Could not list OpenCode's agents: ${listed.error}` }
          : {})}
        groups={[
          {
            label: "",
            options: [
              { value: "", label: `${fallback} · Default` },
              // A saved agent OpenCode no longer lists, or not yet read.
              ...(value && !offered.some((mode) => mode.id === value)
                ? [
                    {
                      value,
                      label:
                        listed.status === "ready"
                          ? `${value} (unavailable)`
                          : value,
                    },
                  ]
                : []),
              ...offered.map((mode) => ({ value: mode.id, label: mode.label })),
            ],
          },
        ]}
        onValueChange={onChange}
      />
    );
  }

  /** The opencode agent, workspace and instructions a new agent starts with. */
  function Create({ config, onChange, disabled }: AgentCreateProps<Config>) {
    // Unnormalized, so the workspace can be cleared and retyped; the runtime
    // falls back to the default for a blank or relative path.
    const current: Config = { ...DEFAULT_CONFIG, ...config };
    const workspace = current.workspace.trim();
    return (
      <>
        <ModeField
          value={current.mode}
          disabled={disabled}
          onChange={(mode) => onChange({ ...current, mode })}
        />
        <Field
          label="Workspace"
          description={WORKSPACE_DESCRIPTION}
          {...(workspace && !validWorkspace(workspace)
            ? { error: WORKSPACE_ERROR }
            : {})}
        >
          <Input
            value={current.workspace}
            disabled={disabled}
            onValueChange={(value) =>
              onChange({ ...current, workspace: value })
            }
          />
        </Field>
        <AgentInstructions
          creation
          value={current.instructions}
          disabled={disabled}
          onChange={(instructions) => onChange({ ...current, instructions })}
        />
      </>
    );
  }

  function SettingsTab({
    agent,
    save,
    settingsHost,
    settingsSection,
    settingsContent,
  }: AgentViewProps<Config>) {
    const form = useId();
    const saved = readConfig(agent.config);
    const [draft, setDraft] = useState(saved);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const saveErrorRef = useRef<HTMLParagraphElement>(null);
    const [listing, retry] = useRead(models);
    useEffect(() => {
      if (error) saveErrorRef.current?.focus();
    }, [error]);
    const listed = listing.status === "ready" ? listing.value : undefined;
    const configChanged = JSON.stringify(draft) !== JSON.stringify(saved);
    const changed = configChanged || Boolean(settingsHost?.pendingSave);
    const submit = async () => {
      setSaving(true);
      setError("");
      try {
        const workspace = draft.workspace.trim() || DEFAULT_CONFIG.workspace;
        if (!validWorkspace(workspace)) throw new Error(WORKSPACE_ERROR);
        await save({ ...draft, workspace });
      } catch (reason) {
        setError(errorText(reason));
      } finally {
        setSaving(false);
      }
    };
    const fallback = listed?.models.find((item) => item.id === listed.current);
    const levels = levelsOf(draft.model, listed);
    const resting = draft.model
      ? undefined
      : levels.find((level) => level.id === fallback?.effort)?.label;
    const efforts = [
      { value: "", label: resting ? `${resting} · Default` : "Default" },
      // A saved level the model doesn't list, or not yet read.
      ...(draft.effort && !levels.some((level) => level.id === draft.effort)
        ? [
            {
              value: draft.effort,
              label: listed ? `${draft.effort} (unavailable)` : draft.effort,
            },
          ]
        : []),
      ...levels.map(({ id, label }) => ({ value: id, label })),
    ];
    return (
      <form
        id={form}
        className="grid gap-4 [container-type:inline-size]"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {error && (
          <p
            ref={saveErrorRef}
            tabIndex={-1}
            role="alert"
            className="buzz-field-error"
          >
            {error}
          </p>
        )}
        {settingsSection !== "runtime" && (
          <>
            <SettingsGroup>
              {settingsHost?.typeControl?.(configChanged)}
              <ModeField
                value={draft.mode}
                onChange={(mode) => setDraft({ ...draft, mode })}
              />
              <ModelPicker
                models={listed?.models ?? []}
                loading={listing.status === "loading"}
                value={draft.model}
                defaultLabel={
                  fallback
                    ? `OpenCode default (${fallback.label})`
                    : "OpenCode default"
                }
                {...(listing.status === "error"
                  ? { description: `Could not list models: ${listing.error}` }
                  : {})}
                onChange={(model) =>
                  setDraft({
                    ...draft,
                    model,
                    // A level the new model doesn't list goes back to OpenCode's.
                    effort: levelsOf(model, listed).some(
                      (level) => level.id === draft.effort,
                    )
                      ? draft.effort
                      : "",
                  })
                }
              />
              <Select
                label="Thinking"
                variant="preference"
                value={draft.effort}
                groups={[{ label: "", options: efforts }]}
                onValueChange={(effort) => setDraft({ ...draft, effort })}
              />
            </SettingsGroup>
            {listing.status === "error" && (
              <div>
                <Button onClick={retry}>Try again</Button>
              </div>
            )}
            <AgentInstructions
              value={draft.instructions}
              disabled={false}
              onChange={(instructions) => setDraft({ ...draft, instructions })}
            />
          </>
        )}
        {settingsSection !== "identity" && (
          <>
            <Field label="Workspace" description={WORKSPACE_DESCRIPTION}>
              <Input
                value={draft.workspace}
                onValueChange={(workspace) => setDraft({ ...draft, workspace })}
              />
            </Field>
            <Select
              label="Conversations"
              variant="preference"
              value={draft.scope}
              groups={SCOPES}
              onValueChange={(value) =>
                setDraft({
                  ...draft,
                  scope: value === "channel" ? "channel" : "thread",
                })
              }
            />
          </>
        )}
        <AgentSaveButton
          form={form}
          saving={saving}
          disabled={!changed}
          dirty={changed}
        />
        {settingsSection !== "identity" && settingsContent}
      </form>
    );
  }

  return { Create, SettingsTab };
}
