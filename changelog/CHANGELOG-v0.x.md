# Changelog

## [0.3.0](https://github.com/sunerpy/opencode-kiro-auth/compare/v0.2.2...v0.3.0) (2026-07-09)


### Features

* **effort:** add enable_log_effort_debug flag + document per-agent effort limitation ([#7](https://github.com/sunerpy/opencode-kiro-auth/issues/7)) ([774adf8](https://github.com/sunerpy/opencode-kiro-auth/commit/774adf85de0d1804e71afd47afdbd2a352a41daf))

## [0.2.2](https://github.com/sunerpy/opencode-kiro-auth/compare/v0.2.1...v0.2.2) (2026-07-09)


### Bug Fixes

* **auth:** account removal shows success (keyed on remaining account) instead of 'Failed to authorize' ([#5](https://github.com/sunerpy/opencode-kiro-auth/issues/5)) ([622d2ef](https://github.com/sunerpy/opencode-kiro-auth/commit/622d2ef024af55085b236cdb900b92aa6be4bee5))

## [0.2.1](https://github.com/sunerpy/opencode-kiro-auth/compare/v0.2.0...v0.2.1) (2026-07-09)


### Bug Fixes

* **auth:** remove-account no longer prompts for API key (self-drawn TTY menu, drop type:api) ([#2](https://github.com/sunerpy/opencode-kiro-auth/issues/2)) ([bf67356](https://github.com/sunerpy/opencode-kiro-auth/commit/bf673564ca34b2611368484445da80b199e805ce))

## [0.2.0](https://github.com/sunerpy/opencode-kiro-auth/compare/v0.1.0...v0.2.0) (2026-07-09)


### Features

* **auth:** show accounts+usage in auth labels and add account-removal method ([f800509](https://github.com/sunerpy/opencode-kiro-auth/commit/f80050914b48c112e2f0b136a9de9cd41ae876cb))
* **auth:** verb-first Add account / Remove account labels for clearer login picker ([6dcb0dc](https://github.com/sunerpy/opencode-kiro-auth/commit/6dcb0dca863483811000ab2c189a88521a1963db))
* **models:** add Sonnet 5 (claude-sonnet-5, probe-confirmed HTTP 200) ([04b096d](https://github.com/sunerpy/opencode-kiro-auth/commit/04b096d13b8e305d28fba818aa3f343f85a1a2c4))


### Bug Fixes

* **auth:** proactive refresh + one-shot 403 retry for idle stale token ([#82](https://github.com/sunerpy/opencode-kiro-auth/issues/82)) ([ff56efe](https://github.com/sunerpy/opencode-kiro-auth/commit/ff56efee70c8773e9891efc9039be56c26780198))
* **provider:** rename provider id kiro -&gt; kiro-auth to resolve models.dev collision ([#91](https://github.com/sunerpy/opencode-kiro-auth/issues/91)) ([c6459cb](https://github.com/sunerpy/opencode-kiro-auth/commit/c6459cb1d302d72c6ed62a6c1e5680d668ee88f3))

## Changelog (v0.x)

All notable changes to `@sunerpy/opencode-kiro-auth` in the `0.x` release line
are documented here. This file is maintained automatically by
[release-please](https://github.com/googleapis/release-please) from
Conventional Commits — do not hand-edit it.
