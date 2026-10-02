# Changelog

## 0.1.1 — 2026-10-02

- Use directory-compatible user configuration fields and validate layout, advisor
  and refresh interval values at runtime.
- Disclose each hook's reads, requests, configured commands and opt-in writes.
- Cover runtime option normalization in both test runners and make the existing
  profile-swap unit test compatible with the local Node runner.
- Add a listing icon and a privacy notice (PRIVACY.md, `privacyPolicyUrl`).
- Retain the types manifest field required by strict mod state validation.

## 0.1.0 — 2026-10-01 (development)

- Detailed Session/Week bars and a compact multi-account usage band.
- Read-only Claude/Codex measurement, configurable JSON and argv providers,
  per-source caches, expired-token hints and 429 preservation.
- `/limitpace` pane, new-session account switcher, refresh and text commands.
- Opt-in provider-neutral prompt/tool and instruction-file advisor.
- Demo mode, configuration examples, tests and real terminal demo captures.
- Strict marketplace/plugin validation, 32 official tests and 26 local tests
  pass; live terminal demos and a real multi-account setup were checked.
