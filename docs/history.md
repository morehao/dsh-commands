# 历史

本包源码原在 [`morehao/ai-kit`](https://github.com/morehao/ai-kit) 的 `commands-dsh/` 目录（`v0.1.0`–`v0.1.7` 由其发布），2026-10 拆分为独立仓以便独立安装与发布；npm 包名不变，已装用户无迁移成本。

旧目录提交历史见 [ai-kit/commits/main/commands-dsh](https://github.com/morehao/ai-kit/commits/main/commands-dsh)。

## 0.3.0（2026-10-25）：`/skill-init` 改为维护型委托

0.2.x 的 `/skill-init` 是本地执行命令：handler 直接 plan / 确认 / 跑 CLI，自绘 web 命令卡、完成 toast 与会话行未读点，并在每条出口发 `cordis-host-runner` 执行报告让 agent 复核。0.3 起改为维护型委托：命令注入一条 `source.kind: "user"` 消息，由 agent 调用 `skill_init` 工具；确认、后台作业、停止与结果明细都在工具/宿主原生 UI 里，`lib/client.js` 与旧 `reportOutcome()` 一并删除。无 `tools` / 无 agent 时仍回退到 `runSkillInit` / `runSkillUpdate`。
