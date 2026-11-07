// OpenCode agent settings: its model and thinking level from the models
// `opencode acp` offers, its instructions, folder and conversation scope.
import { useEffect, useId, useRef, useState } from "react";
import { errorText } from "../../buzz-mcp/rpc";
import { AgentInstructions } from "../../features/agents/AgentInstructions";
import { AgentSaveButton } from "../../features/agents/AgentSaveButton";
import { ModelPicker } from "../../features/agents/ModelPicker";
import type { AgentViewProps, Models } from "../../features/agents/service";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
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

type Listing =
  | { status: "loading" }
  | { status: "ready"; value: Models }
  | { status: "error"; error: string };

/** The thinking levels OpenCode lists for the model `model` runs on; it lists
 * them only for its own default model, so another one has none. */
const levelsOf = (model: string, models: Models | undefined) =>
  models?.models.find((item) => item.id === (model || models.current))
    ?.efforts ?? [];

export function createTabs({
  models,
}: Readonly<{ models: () => Promise<Models> }>) {
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
    const [listing, setListing] = useState<Listing>({ status: "loading" });
    const [round, setRound] = useState(0);
    useEffect(() => {
      if (error) saveErrorRef.current?.focus();
    }, [error]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: `round` reads again.
    useEffect(() => {
      let current = true;
      setListing({ status: "loading" });
      models().then(
        (value) => current && setListing({ status: "ready", value }),
        (reason: unknown) =>
          current && setListing({ status: "error", error: errorText(reason) }),
      );
      return () => {
        current = false;
      };
    }, [round]);
    const listed = listing.status === "ready" ? listing.value : undefined;
    const configChanged = JSON.stringify(draft) !== JSON.stringify(saved);
    const changed = configChanged || Boolean(settingsHost?.pendingSave);
    const submit = async () => {
      setSaving(true);
      setError("");
      try {
        await save({
          ...draft,
          workspace: draft.workspace.trim() || DEFAULT_CONFIG.workspace,
        });
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
                <Button onClick={() => setRound((value) => value + 1)}>
                  Try again
                </Button>
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
            <Field
              label="Workspace"
              description="The folder OpenCode works in. Use ~/ for your home folder."
            >
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

  return { SettingsTab };
}
