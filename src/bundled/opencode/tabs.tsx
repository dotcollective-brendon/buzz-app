// OpenCode's New agent choices, agent settings and activity: which opencode
// agent it runs as, its model and thinking level, instructions, folder and
// conversation scope, and its conversations' transcripts. Agents, models and
// levels are listed from `opencode acp`; transcripts are opencode's own.
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { errorText } from "../../buzz-mcp/rpc";
import activityStyles from "../../features/agents/ActivityLayout.module.css";
import { AgentInstructions } from "../../features/agents/AgentInstructions";
import { AgentSaveButton } from "../../features/agents/AgentSaveButton";
import { ModelPicker } from "../../features/agents/ModelPicker";
import {
  ConversationName,
  OpenedConversation,
  useOpenedSession,
  useOpenTranscript,
} from "../../features/agents/OpenedConversation";
import {
  TranscriptPanel,
  whenShown,
} from "../../features/agents/TranscriptPanel";
import type {
  AgentCreateProps,
  AgentViewProps,
  Models,
} from "../../features/agents/service";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { PanelSubview } from "../../features/panels/PanelSubview";
import { isRetryableRead, retryRead } from "../../features/relay/read-retry";
import { useClockFormat } from "../../shared/clock-preference";
import { formatItemTimestamp } from "../../shared/datetime";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import type { ChannelLabel } from "../../features/channels/channel-icon";
import { validWorkspace } from "../codex/config";
import type { Modes } from "./models";
import {
  type Config,
  DEFAULT_CONFIG,
  type OpenCodeRuntime,
  config as readConfig,
} from "./runtime";
import { TURN_LIMIT } from "./transcript";

const SCOPES = [
  {
    label: "",
    options: [
      { value: "thread", label: "One conversation per thread" },
      { value: "channel", label: "One conversation per channel" },
    ],
  },
];
const CONVERSATION_LIMIT = 30;
/** A conversation the agent has opencode sessions in. */
type Row = Readonly<
  Partial<ChannelLabel> & {
    key: string;
    channelId: string;
    root?: string;
    at: number;
    /** Its opencode sessions, newest first. */
    sessions: readonly string[];
  }
>;
const label = ({ channelId, name, root }: Row) =>
  `${name || channelId.slice(0, 8)} · ${root ? `thread ${root.slice(0, 8)}` : "channel"}`;
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
  runtime,
}: Readonly<{
  models: () => Promise<Models>;
  modes: () => Promise<Modes>;
  runtime: Pick<
    OpenCodeRuntime,
    "subscribe" | "sessions" | "conversations" | "channelLabel" | "transcript"
  >;
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

  /** One conversation's turns, kept current while opencode works. */
  function TranscriptView({
    agent,
    row,
    working,
  }: {
    agent: AgentViewProps<Config>["agent"];
    row: Row;
    working: boolean;
  }) {
    return (
      <TranscriptPanel
        agent={agent}
        read={(signal) => {
          let tries = 0;
          return retryRead(
            // A retry waits for a hidden window to show.
            async (signal) => {
              if (tries++) await whenShown(signal);
              return runtime.transcript(agent.key, row, working, signal);
            },
            signal,
            isRetryableRead,
          );
        }}
        readKey={`${agent.key}\u0000${row.key}\u0000${row.sessions.join()}`}
        working={working}
        reading="Reading the OpenCode session…"
        failed="Could not read the OpenCode session"
        missing={null}
        notes={(transcript) =>
          transcript.more && (
            <p className="m-0 text-body-sm text-subtle">
              Showing the latest {TURN_LIMIT} turns.
            </p>
          )
        }
      />
    );
  }

  /** The conversation the profile was opened from, and the agent's other
   * recent ones, each with its transcript from opencode's storage. */
  function ActivityTab({
    agent,
    conversation,
    initialTranscript,
    close,
  }: {
    agent: AgentViewProps<Config>["agent"];
    conversation?: AgentViewProps<Config>["conversation"];
    initialTranscript?: AgentViewProps<Config>["initialTranscript"];
    close?: AgentViewProps<Config>["close"];
  }) {
    useClockFormat();
    const live = useSyncExternalStore(
      (listener) => runtime.subscribe(listener),
      () => runtime.sessions(agent.key),
    );
    // Read again only when a session changes, which can save one.
    // biome-ignore lint/correctness/useExhaustiveDependencies: a session change can save one.
    const saved = useMemo(
      () => runtime.conversations(agent.key),
      [agent.key, live],
    );
    // Saved conversations, with a running session's id first: a first turn's
    // session is saved only once it ends.
    const rows: Row[] = saved.map(({ key, at, sessions }) => {
      const [channelId = key, root] = key.split("/");
      const running = live.find((session) => session.key === key)?.sessionId;
      return {
        key,
        channelId,
        ...(root ? { root } : {}),
        at,
        sessions: running
          ? [running, ...sessions.filter((id) => id !== running)]
          : sessions,
        ...runtime.channelLabel(agent.key, channelId),
      };
    });
    for (const session of live)
      if (session.sessionId && !rows.some((row) => row.key === session.key)) {
        const [channelId = session.key, root] = session.key.split("/");
        rows.unshift({
          key: session.key,
          channelId,
          ...(root ? { root } : {}),
          at: Date.now(),
          sessions: [session.sessionId],
          ...runtime.channelLabel(agent.key, channelId),
        });
      }
    const busy = (row: Row) =>
      live.some((session) => session.key === row.key && session.busy);
    const status = (row: Row) => (busy(row) ? "Working" : undefined);
    const { session: here } = useOpenedSession(
      rows,
      conversation,
      async () => undefined,
    );
    const { open, show, back } = useOpenTranscript(
      conversation,
      label,
      initialTranscript && { initial: here, ...initialTranscript },
      close,
    );
    const recent = rows
      .filter((row) => row.key !== here?.key)
      .slice(0, CONVERSATION_LIMIT);
    // The open transcript follows its conversation's current sessions.
    const shown = open && (rows.find((row) => row.key === open.key) ?? open);
    return (
      <div className={activityStyles.activity}>
        {conversation && (
          <OpenedConversation
            conversation={conversation}
            harness="OpenCode"
            session={here}
            status={here && status(here)}
            onView={() => here && show(here)}
          />
        )}
        <section className={activityStyles.section}>
          <InlineHeader title="Recent conversations" />
          {recent.length ? (
            <SettingsGroup layout="form">
              <ul className={activityStyles.list}>
                {recent.map((row) => (
                  <li key={row.key} className={activityStyles.entry}>
                    <div className={activityStyles.row}>
                      <span className={activityStyles.copy}>
                        <ConversationName
                          session={row}
                          title={label(row)}
                          className="text-label-sm"
                        />
                        <span className="block text-body-sm text-subtle">
                          {[
                            row.root
                              ? `Thread ${row.root.slice(0, 8)}`
                              : "Channel",
                            status(row),
                            formatItemTimestamp(row.at / 1000, {
                              withTime: true,
                            }),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                      <Button
                        type="button"
                        variant="subtle"
                        size="sm"
                        aria-label={`View transcript: ${label(row)}`}
                        onClick={() => show(row)}
                      >
                        View transcript
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </SettingsGroup>
          ) : (
            <p className="m-0 text-body-sm text-subtle">
              None. A conversation starts when the agent is mentioned.
            </p>
          )}
        </section>
        {shown && (
          <PanelSubview
            title={label(shown)}
            backLabel="Back to profile"
            onBack={back}
          >
            <TranscriptView
              key={shown.key}
              agent={agent}
              row={shown}
              working={busy(shown)}
            />
          </PanelSubview>
        )}
      </div>
    );
  }

  return { ActivityTab, Create, SettingsTab };
}
