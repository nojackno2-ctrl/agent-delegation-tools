# Agent Delegation Tools

這是一套 Windows 多後端子代理工具：讓 Antigravity、Codex 與 Claude 分別以 Antigravity CLI、Codex CLI 與 Claude CLI 啟動一個獨立、邊界清楚的 worker。父代理可以替每個 CLI 子代理選擇模型與思考程度；若某個 CLI 的流量或配額耗盡，也能依父代理指定的順序改由其他 CLI 接續。所有主機共用同一份 skill package 與 canonical scripts，避免三份安裝副本各自漂移。

## 整合矩陣

| 主機 | 對應 CLI 子代理 | Skill 目錄 | 直接 wrapper | 分析預設 |
|---|---|---|---|---|
| Antigravity | `agy` | `%USERPROFILE%\.agents\skills` | `agy.ps1` | `plan` |
| Codex | `codex` | `%CODEX_HOME%\skills` 或 `%USERPROFILE%\.codex\skills` | `codex.ps1` | 明確傳入 `read-only` |
| Claude | `claude` | `%USERPROFILE%\.claude\skills` | `claude.ps1` | `plan` + isolated context |

`delegate.ps1` 會依工作類型選主要後端：`analysis`／`scaffolding` → AGY、`review` → Claude、`implementation` → Codex；單一任務內的配額 fallback 仍是依序執行。需要多個獨立子代理同時運作時，使用 `parallel.ps1`，它會限制最大並行數、隔離每個任務的輸出，並在全部完成後產生同步摘要。

## 安全設計

- AGY、Claude 與 dispatcher 的分析／review 預設唯讀；dispatcher 的 implementation／scaffolding 會自動使用 `workspace-write`，三個 CLI 都能直接修改目前工作區。Codex 直接 wrapper 也保留 `workspace-write` 預設，因此分析時必須明確指定 `-Sandbox read-only`。
- 所有 wrapper 都以 `AGENT_DELEGATION_DEPTH` 拒絕遞迴外部委派。
- `Model`／`Effort` 只套用到被啟動的 CLI 子代理，不會改變父代理本身。
- 跨 CLI fallback 必須由父代理明確提供候選順序；只有辨識到配額、usage limit、rate limit、insufficient credits 或 HTTP 429 才切換，普通錯誤不會被掩蓋。
- 切換到其他供應商前，父代理必須確認該任務允許傳送給該供應商。
- AGY 的 skip-permissions 不能搭配唯讀模式，Codex 的 approve-for-me 只能搭配 `workspace-write`。Codex／Claude 未登入時會回傳 exit `78` 並要求執行 `codex login`／`claude auth login`；AGY 偵測到登入錯誤時也會停止並要求互動登入，不會靜默略過。
- 父 agent 仍需自行檢查 diff、執行測試與回報真實結果；worker 的文字宣稱不是驗證。
- 平行寫入任務必須宣告互不重疊的 `writeScope`；有相依關係的工作應拆成多個批次，由父 agent 在批次之間整合與驗證。
- wrapper 不會自行 commit、push、merge、reset、rebase 或發佈。

## 必要條件

- Windows PowerShell 5.1 或 PowerShell 7
- 至少安裝欲使用的 CLI；目前支援自動尋找：
  - AGY：`%LOCALAPPDATA%\agy\bin\agy.exe` 或 PATH
  - Codex：Codex Desktop 管理的 CLI 或 PATH
  - Claude：PATH 或 `%USERPROFILE%\.local\bin\claude.exe`

CLI 的登入、訂閱額度與服務可用性仍由各 CLI 自己決定。

## 執行前讀取額度狀態

`status.ps1` 會以唯讀方式查詢 Codex app-server 的 `account/rateLimits/read`，回傳真實的已用比例、剩餘比例與重置時間，不會啟動模型回合：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\status.ps1 -Agent all -Json
```

目前 AGY 1.1.11 與 Claude Code 2.1.220 沒有同等的可機器解析帳戶額度介面，因此會明確回傳 `unsupported`，不會用排程、歷史錯誤或猜測數值冒充剩餘流量。查詢失敗則回傳 `unavailable`，也不等於額度已耗盡。

## 本機實測基線

2026-08-10 在 Windows 上完成下列真實驗證：

| 路徑 | CLI 版本 | 證據 |
|---|---|---|
| Codex 主機 → Codex CLI child | `0.147.0-alpha.6.5` | read-only、ephemeral、exit 0、精確 final message `CODEX_WRAPPER_SMOKE_OK` |
| Antigravity wrapper → AGY child | `1.1.11` | plan mode、exit 0、精確 output file `AGY_WRAPPER_SMOKE_OK` |
| Antigravity 主機 → 已安裝 skill → AGY child | `1.1.11` | 外層 exit 0，取得 `AGY_HOST_CHILD_OK` |
| Claude wrapper → Claude CLI child | `2.1.220` | isolated plan、JSON envelope `is_error=false`、exit 0、`CLAUDE_WRAPPER_SMOKE_OK` |
| Claude 主機 → 已安裝 skill → Claude child | `2.1.220` | 外層 exit 0，取得 `CLAUDE_HOST_CHILD_OK` |
| Dispatcher → AGY child config | `1.1.11` | 父代理指定 `gemini-3.6-flash-low`／`low`，exit 0、精確 `AGY_CHILD_CONFIG_OK` |
| Dispatcher → Codex quota → Claude fallback | Codex `0.147.0-alpha.6.5`、Claude `2.1.220` | Codex banner 確認 `gpt-5.6-terra`／`low` 後真實回報 usage limit；依序切換 Claude `sonnet`／`low`，exit 0、精確 `REAL_CROSS_CLI_FALLBACK_OK` |

這些 smoke test 只使用系統暫存目錄與 sentinel prompt，沒有把儲存庫內容交給 worker，也沒有修改專案檔案；暫存目錄已在驗證後刪除。真實 fallback 使用的是當時帳號實際回報的 Codex usage limit，未刻意消耗額度來製造錯誤。版本更新或帳號狀態改變後應重新執行驗證，不把這份基線當成永久保證。

## 安裝或更新三個主機

在儲存庫根目錄執行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Target All
```

也可只同步特定主機：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Target Codex,Antigravity,Claude
```

安裝器會複製 canonical skill package，並逐檔比對 SHA-256。完成後重新開啟對應主機，讓它重新載入 skill metadata。

可用自然語言或明確 skill 呼叫，例如：

```text
$agent-delegation-tools 把這個唯讀分析交給 Antigravity CLI 子代理
$agent-delegation-tools 讓 Codex CLI 子代理修正 parser 並執行 focused tests，不要 commit 或 push
$agent-delegation-tools 請 Claude CLI 子代理獨立審查這個 API diff
```

## 直接使用 wrappers

### Antigravity CLI

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\agy.ps1 `
    -Mode plan `
    -WorkDir 'C:\path\to\project' `
    -OutFile '.\agy-result.txt' `
    '分析資料流，提供檔案證據，不要修改檔案'
```

AGY 支援 `-Model`、`-Effort`、`-AddDir`、`-OutputFormat` 與原生 `-PrintTimeout`。只有明確寫入任務才使用 `-Mode workspace-write`；`-SkipPermissions` 也只允許在寫入模式使用。

### Codex CLI

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\codex.ps1 `
    -Sandbox read-only `
    -Ephemeral `
    -WorkDir 'C:\path\to\project' `
    -OutFile '.\codex-result.txt' `
    '找出 parser 失敗原因，提供檔案證據，不要修改檔案'
```

Codex wrapper 支援 `-Model`、`-Effort`、`-AddDir`、`-Json`、`-SkipGitCheck`、`-Ephemeral`、`-TimeoutSec` 與選用的 `-ApproveForMe`。`-ApproveForMe` 僅能搭配 `workspace-write`，若目前 CLI 版本仍拒絕此組合，請移除該旗標並保留相容性錯誤證據。`-CodexPath` 或 `CODEX_CLI_PATH` 可固定特定 CLI，方便測試與診斷。

### Claude CLI

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\claude.ps1 `
    -Mode plan `
    -Context isolated `
    -WorkDir 'C:\path\to\project' `
    -OutFile '.\claude-result.txt' `
    '獨立審查 API 邊界情況，提供檔案證據，不要修改檔案'
```

Claude wrapper 以 UTF-8 stdin 傳送 prompt，避免 Windows 引號、換行與非 ASCII 字元被重新切割；預設關閉 prompt suggestions 並使用 `--no-session-persistence`，另支援 `-AllowedTools`、`-DisallowedTools`、`-AddDir`、`-RawFile` 與硬限制 `-TimeoutSec`。只有確定稍後要續接同一 session 才使用 `-PersistSession`。

### 統一 dispatcher

```powershell
# 唯讀 review，自動選 Claude
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\delegate.ps1 `
    -TaskType review `
    -WorkDir 'C:\path\to\project' `
    '審查目前 diff，不要修改檔案'

# 已授權的 implementation，自動選 Codex
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\delegate.ps1 `
    -TaskType implementation `
    -Sandbox workspace-write `
    -WorkDir 'C:\path\to\project' `
    '修正 parser、執行 focused tests，不要 commit 或 push'

# 父代理替每個 CLI 子代理指定模型／思考程度；Codex 配額耗盡才依序改用 Claude、AGY
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\delegate.ps1 `
    -Agent codex `
    -FallbackAgent claude,agy `
    -CodexModel '<codex-model>' -CodexEffort xhigh `
    -ClaudeModel '<claude-model>' -ClaudeEffort high `
    -AgyModel '<agy-model>' -AgyEffort high `
    -Sandbox workspace-write `
    -WorkDir 'C:\path\to\project' `
    -OutFile '.\delegation-result.txt' `
    '完成目前實作並執行 focused tests，不要 commit 或 push'
```

`-FallbackAgent` 是父代理選定的有序候選清單；未提供時仍只執行主要子代理。`-AgyModel/-AgyEffort`、`-CodexModel/-CodexEffort`、`-ClaudeModel/-ClaudeEffort` 分別控制三個 CLI child。為了相容舊呼叫，`-Model/-Effort` 仍可控制主要 child，但不會把某家供應商的模型名稱誤傳給 fallback。

模型與思考程度的選擇優先序如下：

1. 使用者明確指定的 provider-specific 值最高，例如 `-CodexModel` 與 `-CodexEffort`。
2. 使用者針對主要 child 指定的相容參數 `-Model/-Effort` 次之。
3. 未指定的欄位由父代理依任務複雜度與 provider 支援能力自動選擇；父代理會把選擇寫入同一組參數。若父代理刻意採用該 CLI 的預設值，就省略對應參數。

Dispatcher 不內建容易過期的模型清單，因此「自動選擇」由掌握當前任務與 provider 能力的父代理完成；`-Agent auto` 則負責依 `TaskType` 自動挑選主要 CLI。所有設定只影響子代理，不會改變父代理本身的模型或思考程度。

Dispatcher 省略 `-Sandbox` 時，implementation／scaffolding 自動為 `workspace-write`，analysis／review 自動為 `read-only`；三個 CLI 透過同一個 dispatcher 介面取得一致行為。`-TimeoutSec` 對每個候選 worker 套用硬性執行上限；逾時回傳 exit `124`、保留已捕捉輸出，而且不會自動切換到另一個可能同時修改共享 worktree 的 provider。先檢查 diff 與未追蹤檔案，再決定是否重試。已明確授權的無頭 AGY 寫入可加 `-Sandbox workspace-write -AgySkipPermissions`；唯讀工作會拒絕這個組合。

發生可辨識的配額耗盡時，下一個 child 會收到原始任務、目前 worktree 狀態，以及有長度上限且標成「不可信進度筆記」的前一個輸出。普通非零錯誤會原樣停止；所有候選都耗盡時 dispatcher 回傳 exit code `75`。

### 多子代理平行批次

先建立 UTF-8 JSON 任務檔。每個任務可使用 `delegate.ps1` 的路由、模型、effort、fallback 與 timeout 欄位；寫入任務另須宣告非重疊的 `writeScope`：

```json
[
  {
    "name": "api-tests",
    "prompt": "只修改並測試 API parser，不要 commit 或 push",
    "agent": "codex",
    "taskType": "implementation",
    "sandbox": "workspace-write",
    "writeScope": ["src/api", "tests/api"]
  },
  {
    "name": "docs",
    "prompt": "只更新操作文件，不要 commit 或 push",
    "agent": "claude",
    "taskType": "implementation",
    "sandbox": "workspace-write",
    "writeScope": ["docs"]
  }
]
```

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\parallel.ps1 `
    -TaskFile '.\tasks.json' `
    -ResultsDir "$env:TEMP\agent-delegation-results" `
    -WorkDir 'C:\path\to\project' `
    -MaxConcurrency 2 -ChildTimeoutSec 900 -TaskTimeoutSec 1800 -Json
```

批次會等到所有子代理完成或逾時才返回，並建立 `summary.json` 與各任務獨立的 `final.txt`、`raw.txt`、`stdout.txt`、`stderr.txt`、`result.json`。整批成功為 exit `0`，任一任務逾時為 `124`，其他混合失敗為 `1`；原始子任務 exit code 仍保留在摘要中。子代理不直接互傳訊息；需要前後相依時，應採「平行分析 → 父 agent 整合 → 下一批實作／審查」的多階段方式。

## Codex 非 ASCII 路徑處理

Codex CLI 的 Windows 沙箱可能無法正確進入含中文等非 ASCII 字元的工作目錄。wrapper 會在 `%USERPROFILE%\codex-ws\<slug>-<path-hash>` 建立 collision-safe ASCII junction，讓 Codex 操作同一批真實檔案；額外 `-AddDir` 也使用相同策略。

若 alias 位置不是 junction，或現有 junction 指向不同目錄，wrapper 會拒絕覆寫或重新指向。`-NoAliasPath` 只適合已確認 CLI 能直接處理該路徑的情況。

## 驗證

所有測試都只使用臨時目錄與 fake CLI，不需外部額度：

```powershell
Get-ChildItem -LiteralPath '.\tests' -Filter '*.Tests.ps1' |
    ForEach-Object {
        powershell.exe -NoProfile -ExecutionPolicy Bypass -File $_.FullName
        if ($LASTEXITCODE -ne 0) { throw "Test failed: $($_.Name)" }
    }
```

測試涵蓋參數轉送、三個 child 各自的模型／思考設定、Codex 額度協定與 unsupported 狀態、UTF-8 無 BOM 握手、prompt/output、工作目錄、額外目錄、唯讀／寫入映射、process-tree timeout、非零 exit code、根入口、dispatcher 單一後端路由、只在配額耗盡時依序 fallback、跨 CLI 接續內容、全候選耗盡 exit `75`、逾時 exit `124`、多子代理同步障壁、並行輸出隔離、寫入範圍衝突拒絕、遞迴拒絕與三主機安裝更新。

## 專案結構

```text
.
├── agy.ps1 / codex.ps1 / claude.ps1 / delegate.ps1 / parallel.ps1 / status.ps1
├── install.ps1
├── skills/agent-delegation-tools/
│   ├── SKILL.md
│   ├── agents/openai.yaml
│   └── scripts/
│       ├── agy.ps1
│       ├── codex.ps1
│       ├── claude.ps1
│       ├── delegate.ps1
│       ├── parallel.ps1
│       └── status.ps1
├── tests/
├── AGENTS.md
└── AI_HANDOFF.md
```

根目錄六個入口只轉送參數；`skills/agent-delegation-tools/scripts` 是唯一實作來源。
