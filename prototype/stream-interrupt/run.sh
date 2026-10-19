#!/bin/sh
# 在临时 DSH_HOME 里跑一次 headless 会话，验证流中断 + 注入 + 重试。
#
#   AIFLASHAPI_API_KEY=... ./run.sh ["Say exactly: PINEAPPLE"]
#
# PROBE_MODE=buffer|forward  PROBE_CHANNEL=user|developer|instructions
# PROTO_DSH_HOME=<dir> 覆盖临时 DSH_HOME
# PROBE_TRIGGER=<word>  PROBE_MAX_RETRIES=<n>
set -e
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export PATH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin:$PATH"
# 父进程导出的 DSH_HOME 指向真实 profile，原型必须用自己的临时目录。
export DSH_HOME="${PROTO_DSH_HOME:-${TMPDIR:-/tmp}/dsh-agent-rules-proto}"
if [ ! -d "$DSH_HOME/profiles/proto" ]; then
  dsh --profile proto --from-default-profile headless --dump-config >/dev/null
fi
dsh --profile proto --patch "$here/provider.yml" --patch "$here/patch.yml" headless --json "${1:-Say exactly: PINEAPPLE}"
