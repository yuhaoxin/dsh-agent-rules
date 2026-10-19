# dsh-agent-rules

把 [oh-my-pi](https://github.com/can1357/oh-my-pi) 的 `.agent/rules` / `.agents/rules` 规则自动注入能力移植到 DeepSeek Harness。

## 计划中的能力

- 用户级 `~/.agent/rules`、`~/.agents/rules`，以及项目级同名目录（从当前目录向上找到含 `.git` 的目录）。
- 规则分桶：`alwaysApply: true` 的正文进系统提示词；带 `description` 的规则进规则清单；带 `condition` / `astCondition` / `question` 的规则走 TTSR。
- TTSR：工具调用命中时拦截或附提醒；文本与思考流命中时中断、注入规则、重试。

## 状态

规划中，尚无可用版本。安装与用法在首个版本发布后补充。

## 许可

MIT
