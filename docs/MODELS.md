# Model catalog & thinking effort

Full provider model list for `kiro-auth`, plus how OpenCode thinking budgets map
onto Kiro's native effort levels. See the root [README](../README.md#models) for
the short version.

## Full model list

Paste this into the `provider.kiro-auth.models` block of your `opencode.json` or
`opencode.jsonc` to expose every model this plugin supports (Claude Sonnet/Opus/
Haiku variants plus the open-weight models Kiro proxies):

```json
{
  "plugin": ["@sunerpy/opencode-kiro-auth"],
  "provider": {
    "kiro-auth": {
      "models": {
        "claude-sonnet-4-5": {
          "name": "Claude Sonnet 4.5",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "claude-sonnet-4-5-thinking": {
          "name": "Claude Sonnet 4.5 Thinking",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
            "medium": { "thinkingConfig": { "thinkingBudget": 16384 } },
            "high": { "thinkingConfig": { "thinkingBudget": 24576 } },
            "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
          }
        },
        "claude-sonnet-4-6": {
          "name": "Claude Sonnet 4.6",
          "limit": { "context": 1000000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "claude-sonnet-4-6-thinking": {
          "name": "Claude Sonnet 4.6 Thinking",
          "limit": { "context": 1000000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
            "medium": { "thinkingConfig": { "thinkingBudget": 16384 } },
            "high": { "thinkingConfig": { "thinkingBudget": 24576 } },
            "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
          }
        },
        "claude-sonnet-5": {
          "name": "Claude Sonnet 5",
          "limit": { "context": 1000000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "claude-sonnet-5-thinking": {
          "name": "Claude Sonnet 5 Thinking",
          "limit": { "context": 1000000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
            "medium": { "thinkingConfig": { "thinkingBudget": 16384 } },
            "high": { "thinkingConfig": { "thinkingBudget": 24576 } },
            "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
          }
        },
        "claude-haiku-4-5": {
          "name": "Claude Haiku 4.5",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image"], "output": ["text"] }
        },
        "claude-opus-4-5": {
          "name": "Claude Opus 4.5",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "claude-opus-4-5-thinking": {
          "name": "Claude Opus 4.5 Thinking",
          "limit": { "context": 200000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
            "medium": { "thinkingConfig": { "thinkingBudget": 16384 } },
            "high": { "thinkingConfig": { "thinkingBudget": 24576 } },
            "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
          }
        },
        "claude-opus-4-6": {
          "name": "Claude Opus 4.6",
          "limit": { "context": 1000000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "claude-opus-4-6-thinking": {
          "name": "Claude Opus 4.6 Thinking",
          "limit": { "context": 1000000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
            "medium": { "thinkingConfig": { "thinkingBudget": 16384 } },
            "high": { "thinkingConfig": { "thinkingBudget": 24576 } },
            "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
          }
        },
        "claude-opus-4-6-1m": {
          "name": "Claude Opus 4.6 (1M Context)",
          "limit": { "context": 1000000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "claude-opus-4-6-1m-thinking": {
          "name": "Claude Opus 4.6 (1M Context) Thinking",
          "limit": { "context": 1000000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
            "medium": { "thinkingConfig": { "thinkingBudget": 16384 } },
            "high": { "thinkingConfig": { "thinkingBudget": 24576 } },
            "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
          }
        },
        "claude-opus-4-7": {
          "name": "Claude Opus 4.7",
          "limit": { "context": 1000000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "claude-opus-4-7-thinking": {
          "name": "Claude Opus 4.7 Thinking",
          "limit": { "context": 1000000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
            "medium": { "thinkingConfig": { "thinkingBudget": 16384 } },
            "high": { "thinkingConfig": { "thinkingBudget": 24576 } },
            "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
          }
        },
        "claude-sonnet-4-5-1m": {
          "name": "Claude Sonnet 4.5 (1M Context)",
          "limit": { "context": 1000000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "claude-sonnet-4-6-1m": {
          "name": "Claude Sonnet 4.6 (1M Context)",
          "limit": { "context": 1000000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] }
        },
        "claude-sonnet-4-6-1m-thinking": {
          "name": "Claude Sonnet 4.6 (1M Context) Thinking",
          "limit": { "context": 1000000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
            "medium": { "thinkingConfig": { "thinkingBudget": 16384 } },
            "high": { "thinkingConfig": { "thinkingBudget": 24576 } },
            "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
          }
        },
        "auto": { "name": "Auto (1.0x)" },
        "claude-sonnet-4": {
          "name": "Claude Sonnet 4.0 (1.3x)",
          "limit": { "context": 200000, "output": 64000 }
        },
        "deepseek-3.2": {
          "name": "DeepSeek 3.2 (0.25x)",
          "limit": { "context": 128000, "output": 64000 }
        },
        "glm-5": { "name": "GLM-5 (0.5x)", "limit": { "context": 200000, "output": 64000 } },
        "minimax-m2.5": {
          "name": "MiniMax 2.5 (0.25x)",
          "limit": { "context": 200000, "output": 64000 }
        },
        "minimax-m2.1": {
          "name": "MiniMax 2.1 (0.15x)",
          "limit": { "context": 200000, "output": 64000 }
        },
        "qwen3-coder-next": {
          "name": "Qwen3 Coder Next (0.05x)",
          "limit": { "context": 256000, "output": 64000 }
        }
      }
    }
  }
}
```

## Thinking effort configuration

Configure Kiro effort per model in your OpenCode provider model definitions by
setting `thinkingConfig.thinkingBudget` on each model variant. The plugin
automatically maps those budgets to Kiro's native `effort` field for supported
Claude models, so you don't need to hardcode a global `effort` value in
`~/.config/opencode/kiro.json`.

```json
{
  "provider": {
    "kiro-auth": {
      "models": {
        "claude-opus-4-7-thinking": {
          "name": "Claude Opus 4.7 Thinking",
          "limit": { "context": 1000000, "output": 64000 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "low": { "thinkingConfig": { "thinkingBudget": 8192 } },
            "medium": { "thinkingConfig": { "thinkingBudget": 16384 } },
            "high": { "thinkingConfig": { "thinkingBudget": 24576 } },
            "max": { "thinkingConfig": { "thinkingBudget": 32768 } }
          }
        }
      }
    }
  }
}
```

Budget mapping:

| OpenCode budget | Kiro effort |
| ---------------- | ----------- |
| `<= 10000`        | `low`       |
| `<= 20000`        | `medium`    |
| `<= 28000`        | `high`      |
| `> 28000`         | `max`       |

Use `~/.config/opencode/kiro.json` for plugin-wide behavior such as auth sync,
account selection, retry limits, and `auto_effort_mapping`. A top-level `effort`
setting is a global override for all supported models, not a per-model setting.
See [docs/CONFIGURATION.md](CONFIGURATION.md) for the full option reference.
