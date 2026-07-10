# Effort-level model variants

Pick a specific Kiro reasoning effort directly from the model list, without
touching `kiro.json`. This is separate from the base model catalog in
[docs/MODELS.md](MODELS.md) — that file is unaffected by this document.

## What they are

A variant model id is a base model name with an effort suffix appended, for
example `claude-opus-4-8-xhigh`. Selecting it from the model list (in the TUI
model picker, an agent's `model` field, or a session string) sends that exact
Kiro effort level on every request for that model, no config file involved.

Under the hood, the plugin recognizes the suffix, strips it to resolve the
real wire model id, and sets `effort` on the outbound Kiro request accordingly
— the same mechanism the global `effort` key in `kiro.json` uses, just chosen
per model instead of globally.

## Available variants

Only these four base models have variant ids. Every level below is
probe-confirmed against the live Kiro API — no variant outside this table
exists.

| Base model | `low` | `medium` | `high` | `xhigh` | `max` |
| --- | --- | --- | --- | --- | --- |
| `claude-opus-4-8` | `claude-opus-4-8-low` | `claude-opus-4-8-medium` | `claude-opus-4-8-high` | `claude-opus-4-8-xhigh` | `claude-opus-4-8-max` |
| `claude-opus-4-7` | `claude-opus-4-7-low` | `claude-opus-4-7-medium` | `claude-opus-4-7-high` | `claude-opus-4-7-xhigh` | `claude-opus-4-7-max` |
| `claude-sonnet-5` | `claude-sonnet-5-low` | `claude-sonnet-5-medium` | `claude-sonnet-5-high` | `claude-sonnet-5-xhigh` | `claude-sonnet-5-max` |
| `claude-sonnet-4-6` | `claude-sonnet-4-6-low` | `claude-sonnet-4-6-medium` | `claude-sonnet-4-6-high` | — | `claude-sonnet-4-6-max` |

**`claude-sonnet-4-6` has no `xhigh` variant.** The Kiro API rejects an
`xhigh`-effort request on this model outright, so that variant id was
deliberately left out of the catalog. If you need `xhigh`-level reasoning on
Sonnet, use `claude-sonnet-5-xhigh` or one of the Opus variants instead.

## How to use them

Reference a variant id anywhere you'd normally reference a model:

```
kiro-auth/claude-opus-4-8-xhigh
```

- In `opencode` TUI, pick it from the model picker like any other model.
- In an agent config, set `"model": "kiro-auth/claude-sonnet-5-high"`.
- In `provider.kiro-auth.models`, add the variant id as its own entry if you
  want to pin or rename it (see [docs/MODELS.md](MODELS.md) for the JSON
  shape non-variant entries use — variants follow the same shape, just with
  the effort baked into the id).

No `kiro.json` changes are required to use a variant. The effort comes from
the id itself.

## Variant vs. non-variant: which one do I want?

Both stay available side by side; picking one doesn't remove the other.

- **Variant model id** (`claude-opus-4-8-xhigh`, etc.): explicit, per-request
  effort. Whatever effort is baked into the id is what gets sent, every time,
  regardless of what's in `kiro.json`. Use this when you want a specific
  agent, session, or one-off request pinned to a known reasoning depth.
- **Non-variant base model** (`claude-opus-4-8`, `claude-sonnet-4-6`, etc.):
  uses the global `effort` key in `kiro.json` if set, or falls back to
  automatic budget-based mapping / `medium`, as described in
  [Reasoning effort](CONFIGURATION.md#reasoning-effort). Use this when one
  global effort setting (or the default) is good enough across every model
  and agent.

In short: reach for a variant id when you need a *specific* level *right
now*; leave a model as its base (non-variant) id when the global default is
fine.

## Why variants exist

OpenCode's native thinking-level selector (`Ctrl+T`, or `--variant` on the
CLI, which sets `reasoningEffort` on the request) does **not** reach plugins
registered through `@ai-sdk/openai-compatible` — which is how this plugin
registers the `kiro-auth` provider. We verified this live, four separate
times: capturing the actual inbound request body with different `--variant`
levels selected produced byte-identical payloads with no `reasoningEffort`,
`reasoning`, or `thinkingConfig` field anywhere. OpenCode's orchestration
layer consumes the variant selection upstream and never forwards it to a
custom `fetch` on an openai-compatible provider.

This is a known upstream limitation in OpenCode itself, not something this
plugin can fix from the plugin side. It's tracked in these upstream issues:

- [anomalyco/opencode#26495](https://github.com/anomalyco/opencode/issues/26495)
- [anomalyco/opencode#25026](https://github.com/anomalyco/opencode/issues/25026)
- [anomalyco/opencode#5674](https://github.com/anomalyco/opencode/issues/5674)

What *does* reach the plugin is `body.model` — the model id itself is
forwarded intact on every request. So instead of relying on the broken
`reasoningEffort` passthrough, effort-level variants encode the desired
effort directly in the model id and let the plugin read it back out on the
server side. This mirrors how `kiro-cli`/Kiro IDE let you choose a thinking
level by picking a model, rather than through a separate effort control.

Variant ids are a workaround for this specific upstream gap. If OpenCode
starts forwarding `reasoningEffort` to openai-compatible providers, the
global `effort` key and per-agent variant selection in `kiro.json` become a
viable alternative to per-model variant ids for this use case — but variant
ids will keep working either way, since they don't depend on that
passthrough at all.

## Relationship to reasoning display

Effort only controls how much a model thinks, not whether that thinking is
shown. Since 0.4.3, any reasoning-capable Kiro model (Opus 4.x, Sonnet 5,
etc.) streams its chain-of-thought into OpenCode's own reasoning block —
shown as "Thought: `<duration>`" above the final reply — regardless of effort
level. Picking a higher-effort variant (`xhigh`, `max`) generally produces
deeper, longer reasoning in that block; picking a lower one (`low`) generally
produces shorter reasoning, but the reasoning block itself is always present
for reasoning-capable models. See
[Reasoning display](CONFIGURATION.md#reasoning-display) for the full
behavior.
