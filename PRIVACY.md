# LimitPace privacy notice

LimitPace runs entirely inside your own Claude Code installation. The author operates no server and receives no data.

- **No telemetry.** LimitPace sends nothing to its author or to any analytics service.
- **Network requests.** Only to the usage endpoints of providers you configure, for your own accounts:
  `https://api.anthropic.com/api/oauth/usage` (Claude) and `https://chatgpt.com/backend-api/wham/usage` (Codex).
  Each request carries that provider's own access token (and, for Codex, its account id when present) and nothing else from your machine.
- **Credentials.** Read locally from your own credential files or a `tokenCommand` you configure, used only for the request above,
  and never stored, logged, displayed or written anywhere by LimitPace.
- **Local data.** Usage percentages, reset times and timestamps are kept in Claude Code's local plugin storage on your machine.
  In opt-in advisor file mode, LimitPace writes a marked block with headroom percentages into your project's `AGENTS.md`/`CLAUDE.md`.
- **Commands.** Only commands you configure yourself are run (see the README).

The provider requests are governed by the respective provider's own privacy terms. Questions: open an issue at
https://github.com/fstandhartinger/limitpace/issues.
