# Issue #251：显式恢复旧会话

[English](./README.md) | [Issue #251](https://github.com/omdsh-dev/dsh-mnemon/issues/251) | [恢复流程](../../zh-CN/guides/operations.md#dsh-015-兼容与旧会话恢复)

2026-09-14 从 main `6ad99cc1890714355e1bb0e9230f3fce674bfb73` 复现，环境为 macOS arm64、Node 25.1.0、pnpm 11.19.0 和已发布 DSH 0.1.5-rc.1。仅使用合成会话日志、一次性 Profile、工作区与记忆目录。修复位于 Starter 的显式维护 CLI，不改变 Core/Source/Provider 的职责，不拦截历史加载，不修改 DSH 冻结校验器。

## 真实 WebUI 前后验证

[Runtime 夹具](../../../tests/fixtures/issue-251-legacy-v0.jsonl) 在 0.1.2 生成的合成历史上增加遗漏的旧 Runtime summary 和另一插件的 snapshot。为一次性 `scripts/serve-e2e.mjs` 环境调整 session id、工作区、preset、模型路由，再将每行编码为带校验和的 Zstandard 帧。

旧 CLI 报告修复两条消息，但实际 WebUI 打开其副本仍报 `user/message 7 source summary requires notice form`，因为 `Runtime memory snapshot` 未被移除。仓库提交 `000ecc1568899a794ecb5f8ccf6f28a90c13894e` 的 `memorySnapshotMessage()` 确认该字符串曾以 `dsh-mnemon` / `recall` 写出。

新 CLI 报告修复三条消息，原始用户请求与助手回复正常加载。通过实际 WebUI 完成新的 canary 对话，重启 Host 并冷打开后两轮均保留。选择配置好的回环响应服务路由，未调用外部模型 API。原始压缩备份 SHA-256 始终为 `415d0a9470f9eb7301bcd02333d8be428b29082fe7b0ae74e43da43336022d3e`；修复副本为 `2e69362ea5284683b933ef6b8f2e480486a723930a0fa262b657b80c63fa87e0`。

| 修复前：旧工具遗漏 Runtime summary | 修复后：续写、重启、冷打开 |
|---|---|
| ![历史 summary 校验失败](./251-before-runtime-summary.jpg) | ![两轮会话均保留](./251-after-cold-reopen.jpg) |

共享 Starter 基线还启用了三个可选 Strategy 扩展，实际状态页显示已安装 Native CLI 0.2.8。一次性真实 CLI 的创建、写入、关键词召回与删除冒烟通过。[Native 状态截图](./baseline-native-status.jpg)。这些检查不表示此补丁修改了 Native 存储。

## 契约审计与修复边界

| 形状 | 已验证行为 |
|---|---|
| 三个历史 Mnemon summary 字符串 | 仅删除匹配的 summary 成员；保留正文和其他插件 source。 |
| 兼容的 descriptor v2 | 检查严格的旧版字段集合及全部适用冻结 v3 约束后，仅将版本值由 2 改为 3。 |
| ID 或 name 为空字符串的 packed 工具 delta | 展开为原有 raw delta 事件，保留逻辑序号、时间、name 和参数。 |
| 已经为 raw 的空字符串 delta | 保持字节不变；实际已发布迁移支持此形状。 |
| null name、完成或持久工具链中的空 ID、不兼容 descriptor、不安全 packed 行 | 输出有数量上限的行号/事件/字段路径诊断，退出码 1，不发布输出。 |

已发布 `dsh-subagent@0.1.1-rc.2` 使用 descriptor v2；审计的 `0.1.2-alpha.2` 与 `0.1.2-rc.1` 已使用 v3。比较 `lib/types/descriptor.js` 和 `continuation.js` 的冷恢复代码可见，v3 增加可选 `agentReasoningEffort`；保持其缺省即可保留旧版声明的组合参数。One-shot 只允许 version/mode/provider 和可选 label；continuable 允许 label、成对 agentProvider/agentModel、persona 以及封闭 allow/deny toolFilter。不裁剪、生成或丢弃字段；不承诺不同 DSH 版本的运行时默认值相同。

旧版 `dsh-session@0.1.2-rc.1/lib/types/chunk-rows.js` 接受字符串占位值，并定义无损展开。当前物理解码器拒绝 packed 空 ID；packed 空 name 可能通过迁移却在 `expandAssistantStream` 回放时报错。实际 v0→v3 流程则通过 `AssistantStreamAccumulator` 保留 raw 空字符串 delta，因此测试同时检查完整迁移和带时间戳的 stream 回放，而不是仅调用独立 payload 校验函数。

删除 delta 会丢失时间、参数和 provenance；删除 null name 可能改变首 token 计时。生成新的持久调用 ID 无法还原 provider 回放、工具执行、hook、PTC 子调用和外部 spill 文件中的原始身份。即使本地 call/result 只有一种配对，也不能证明外部引用一致。此类形状仍需原写入方提供脱敏制品与恢复依据；本变更不声称 #251 中所有形状均可恢复。

已发布 0.1.5-rc.1 与 0.1.5-rc.2 的 v0→v1 迁移 `lib/index.js` 字节一致，SHA-256 为 `15ae26b90310d83b1b90a5e7cad9e2f34282fddaba2f19f2fd2232382065603d`。完整执行环境使用 rc.1。注册表未找到已发布的 `dsh@0.1.2-rc.2`；报告中的 source build 仍需其提交号才能确定。

## 回归与复现

[修复测试](../../../tests/legacy-session-repair.spec.ts)覆盖已发布 JSONL 持久层、v3 发布、冷打开与精确的带时间 stream 回放、严格 descriptor 条件、所有支持形状组合修复、其他插件保留、普通/压缩幂等、独占输出、诊断与拒绝、重复字段、损坏帧、不安全坐标及展开大小上限。[组合夹具](../../../tests/fixtures/issue-251-repairable-v0.jsonl)包含全部支持的修复。[机器可读验证记录](./verification.json)。

最终测试中，root 1,028 项与独立插件 323 项通过，七项 opt-in 测试跳过；修复专项有 66 项。`pnpm verify` 通过；最终补齐旧版诊断路径后，再次通过类型检查、全部 root 测试与包校验。确定性构建、文档、公开入口、publint/attw 和真实 Headless 激活均通过。维护命令使包的实测展开大小为 1,288,712 字节，上限调整为 1,292,000 字节；Host 和 Client bundle 代码保持原状。独立复审另检查了 144 组 descriptor 与 125 组使用 BigInt 对照的 packed 坐标边界。

```sh
pnpm install --frozen-lockfile
pnpm exec vitest run tests/legacy-session-repair.spec.ts tests/lifecycle.spec.ts
pnpm run verify
node bin/repair-legacy-session.mjs --input tests/fixtures/issue-251-repairable-v0.jsonl
MNEMON_CLI_PATH=/absolute/path/to/mnemon pnpm e2e:serve --strategy-extensions
```

上面的 WebUI 截图覆盖 Runtime summary 恢复；descriptor 和 packed stream 由真实已发布加载器与 stream 回放测试验证。未测试 Windows source build、外部真实 Provider 或生产会话。
