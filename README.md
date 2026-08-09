# Harness

Set `HARNESS_SHOW_STATUS=1` to show status and token-usage transcript rows.

Configure providers and models from the TUI:

```text
/login [provider]
/model [provider]
/model <provider> <model> [base-url]
```

Credentials are stored in `~/.config/harness/auth.json` (or `$XDG_CONFIG_HOME/harness/auth.json`).
The selected model is stored in `~/.config/harness/settings.json`; if a project has `.harness/settings.json`, its model overrides and receives changes instead.
