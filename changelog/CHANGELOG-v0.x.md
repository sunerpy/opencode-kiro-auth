# Changelog

## [0.13.5](https://github.com/sunerpy/opencode-kiro-auth/compare/v0.13.4...v0.13.5) (2026-07-24)


### Bug Fixes

* **timeout:** separate SDK response wait from stream inactivity ([#55](https://github.com/sunerpy/opencode-kiro-auth/issues/55)) ([f8de13d](https://github.com/sunerpy/opencode-kiro-auth/commit/f8de13dff086a333533f25f54fd45f631f75c831))

## [0.13.4](https://github.com/sunerpy/opencode-kiro-auth/compare/v0.13.3...v0.13.4) (2026-07-24)


### Bug Fixes

* **streaming:** pause timeout during downstream backpressure ([#53](https://github.com/sunerpy/opencode-kiro-auth/issues/53)) ([474d7a4](https://github.com/sunerpy/opencode-kiro-auth/commit/474d7a49f4309b33a2a29a697d6913cd12c45872))

## [0.13.3](https://github.com/sunerpy/opencode-kiro-auth/compare/v0.13.2...v0.13.3) (2026-07-24)


### Bug Fixes

* **streaming:** 将请求超时改为上游无活动超时 ([#51](https://github.com/sunerpy/opencode-kiro-auth/issues/51)) ([9cf9d58](https://github.com/sunerpy/opencode-kiro-auth/commit/9cf9d589aed6a8784410e4e35ceaef1a199b7d41))

## [0.13.2](https://github.com/sunerpy/opencode-kiro-auth/compare/v0.13.1...v0.13.2) (2026-07-24)


### Bug Fixes

* **streaming:** 修复 SDK 事件流迭代错误的输出前透明重试 ([#48](https://github.com/sunerpy/opencode-kiro-auth/issues/48)) ([94d8199](https://github.com/sunerpy/opencode-kiro-auth/commit/94d8199bdcdf234d3b12dbafce986ee16863d25a))

## [0.13.1](https://github.com/sunerpy/opencode-kiro-auth/compare/v0.13.0...v0.13.1) (2026-07-17)


### Bug Fixes

* **models:** 统一模型上下文窗口来源以避免超长输入 400 ([#46](https://github.com/sunerpy/opencode-kiro-auth/issues/46)) ([7b9f7ee](https://github.com/sunerpy/opencode-kiro-auth/commit/7b9f7ee8125b3a7c8695e53ee2382bdbe281b563))

## [0.13.0](https://github.com/sunerpy/opencode-kiro-auth/compare/v0.12.0...v0.13.0) (2026-07-16)


### Features

* **models:** 支持 GPT 5.6 思考等级变体与图片输入 ([#44](https://github.com/sunerpy/opencode-kiro-auth/issues/44)) ([35dea03](https://github.com/sunerpy/opencode-kiro-auth/commit/35dea03fa898256d7c31be93b1d435e2fbd6e2c2))

## [0.12.0](https://github.com/sunerpy/opencode-kiro-auth/compare/v0.11.0...v0.12.0) (2026-07-16)


### Features

* **models:** add OpenAI GPT 5.6 Sol/Terra/Luna ([#42](https://github.com/sunerpy/opencode-kiro-auth/issues/42)) ([c0a3982](https://github.com/sunerpy/opencode-kiro-auth/commit/c0a3982d3baff08fc1738743f0011f80e5636945))

## [0.11.0](https://github.com/sunerpy/opencode-kiro-auth/compare/v0.10.0...v0.11.0) (2026-07-16)


### Features

* **account:** cross-process account distribution + per-request spread ([#40](https://github.com/sunerpy/opencode-kiro-auth/issues/40)) ([59e3cf4](https://github.com/sunerpy/opencode-kiro-auth/commit/59e3cf44e1448aded78121a73f2beacdbc900b50))

## [0.10.0](https://github.com/sunerpy/opencode-kiro-auth/compare/v0.9.0...v0.10.0) (2026-07-14)


### Features

* **storage:** 将配置日志与锁整理到 kiro-auth-plugin 子目录 ([#38](https://github.com/sunerpy/opencode-kiro-auth/issues/38)) ([88003de](https://github.com/sunerpy/opencode-kiro-auth/commit/88003de27da5a80d4cb0ad8d1801ab430a0b5502))

## [0.9.0](https://github.com/sunerpy/opencode-kiro-auth/compare/v0.8.0...v0.9.0) (2026-07-13)


### Features

* **account:** 账号进入付费超额时默认停用并支持开关 ([#36](https://github.com/sunerpy/opencode-kiro-auth/issues/36)) ([fc38b8f](https://github.com/sunerpy/opencode-kiro-auth/commit/fc38b8fe7c04302427714858136bc2691b717f77))

## [0.8.0](https://github.com/sunerpy/opencode-kiro-auth/compare/v0.7.0...v0.8.0) (2026-07-12)


### Features

* **config:** 启动时自动补齐新增默认配置字段 ([#34](https://github.com/sunerpy/opencode-kiro-auth/issues/34)) ([f24e9ea](https://github.com/sunerpy/opencode-kiro-auth/commit/f24e9eaa21df08482114f835801ffd826b877069))

## [0.7.0](https://github.com/sunerpy/opencode-kiro-auth/compare/v0.6.2...v0.7.0) (2026-07-12)


### Features

* **auth:** fix account resurrection + token race, add keep-alive and reauth toast ([#32](https://github.com/sunerpy/opencode-kiro-auth/issues/32)) ([f0a722a](https://github.com/sunerpy/opencode-kiro-auth/commit/f0a722ab81e58a30a8465f9db801d5439dcb15c3))

## [0.6.2](https://github.com/sunerpy/opencode-kiro-auth/compare/v0.6.1...v0.6.2) (2026-07-11)


### Miscellaneous Chores

* release 0.6.2 ([#30](https://github.com/sunerpy/opencode-kiro-auth/issues/30)) ([5a69506](https://github.com/sunerpy/opencode-kiro-auth/commit/5a695060c6e28356a6c3efc9c6dfc6be242d96fa))

## [0.6.1](https://github.com/sunerpy/opencode-kiro-auth/compare/v0.6.0...v0.6.1) (2026-07-11)


### Bug Fixes

* **sync:** eliminate ghost placeholder accounts at source (delete+tombstone on real-email sync incl reuse path) ([#27](https://github.com/sunerpy/opencode-kiro-auth/issues/27)) ([7f9008e](https://github.com/sunerpy/opencode-kiro-auth/commit/7f9008e875d2931100dbb4e100af7b1e52c6ad73))

## [0.6.0](https://github.com/sunerpy/opencode-kiro-auth/compare/v0.5.2...v0.6.0) (2026-07-11)


### Features

* **accounts:** quota-aware avoidance (reserve threshold + drain + single-account bypass) ([#25](https://github.com/sunerpy/opencode-kiro-auth/issues/25)) ([aff04f8](https://github.com/sunerpy/opencode-kiro-auth/commit/aff04f8538cc34e7b64bf38b12c530134b140075))

## [0.5.2](https://github.com/sunerpy/opencode-kiro-auth/compare/v0.5.1...v0.5.2) (2026-07-11)


### Bug Fixes

* **streaming:** rescue text-dialect tool calls (&lt;invoke&gt;/DSML) + suppress leak into content ([#23](https://github.com/sunerpy/opencode-kiro-auth/issues/23)) ([63baa15](https://github.com/sunerpy/opencode-kiro-auth/commit/63baa15ba7d6a0f07d2ce428ef577a3fd88cc54a))

## [0.5.1](https://github.com/sunerpy/opencode-kiro-auth/compare/v0.5.0...v0.5.1) (2026-07-11)


### Bug Fixes

* **streaming:** use 0-based tool-call ordinal for tool_calls index (fixes silent tool-call abort) ([#21](https://github.com/sunerpy/opencode-kiro-auth/issues/21)) ([573d7ac](https://github.com/sunerpy/opencode-kiro-auth/commit/573d7ac3f6ce20da8e4fc4fb1e6b0a2def3ee0df))

## [0.5.0](https://github.com/sunerpy/opencode-kiro-auth/compare/v0.4.3...v0.5.0) (2026-07-10)


### Features

* **models:** add effort-level model variants for opus 4.8/4.7 + sonnet 5/4.6 ([#19](https://github.com/sunerpy/opencode-kiro-auth/issues/19)) ([c44a6cd](https://github.com/sunerpy/opencode-kiro-auth/commit/c44a6cdd6702c2fbe28896cb38b74edbb5a9a0b0))

## [0.4.3](https://github.com/sunerpy/opencode-kiro-auth/compare/v0.4.2...v0.4.3) (2026-07-10)


### Bug Fixes

* **streaming:** render Kiro reasoningContentEvent as separate reasoning block ([#17](https://github.com/sunerpy/opencode-kiro-auth/issues/17)) ([6d28d0f](https://github.com/sunerpy/opencode-kiro-auth/commit/6d28d0f6c07f86e022f33b5cc49605069c2a6350))

## [0.4.2](https://github.com/sunerpy/opencode-kiro-auth/compare/v0.4.1...v0.4.2) (2026-07-10)


### Miscellaneous Chores

* re-verify OIDC publishing after sigstore fix ([#15](https://github.com/sunerpy/opencode-kiro-auth/issues/15)) ([0a2c14c](https://github.com/sunerpy/opencode-kiro-auth/commit/0a2c14cdbe50b3e46c64849af9dfb7357a196739))

## [0.4.1](https://github.com/sunerpy/opencode-kiro-auth/compare/v0.4.0...v0.4.1) (2026-07-10)


### Miscellaneous Chores

* verify OIDC trusted publishing ([#12](https://github.com/sunerpy/opencode-kiro-auth/issues/12)) ([7184e2e](https://github.com/sunerpy/opencode-kiro-auth/commit/7184e2e37e2a2444ae99669e9493fa0a23207ddf))

## [0.4.0](https://github.com/sunerpy/opencode-kiro-auth/compare/v0.3.0...v0.4.0) (2026-07-10)


### Features

* **accounts:** persist account removal so kiro-cli auto-sync cannot revive removed accounts ([#9](https://github.com/sunerpy/opencode-kiro-auth/issues/9)) ([a434f85](https://github.com/sunerpy/opencode-kiro-auth/commit/a434f8548c8695014b06cccbe03f78e204059e32))

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
