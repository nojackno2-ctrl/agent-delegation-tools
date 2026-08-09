# Agent Delegation Tools

在 Windows 上，把一個邊界清楚的工作交給獨立 Codex CLI worker。這個倉庫同時提供可安裝的 Codex skill，以及相容舊用法的 `codex.ps1` 入口。

## 目前狀態

| 整合 | 狀態 | 說明 |
|---|---|---|
| Codex | 已提供並完成本機驗證 | `skills/agent-delegation-tools` 與 `codex.ps1` |
| Claude Code | 尚未納入此版本 | 規劃中的外部 agent 整合 |
| Antigravity | 尚未納入此版本 | 規劃中的外部 agent 整合 |

目前發布內容只保證 Codex 工作流程。README 不會把尚未提交到倉庫的外部整合描述成已完成。

## 功能

- 以非互動方式啟動一個獨立 Codex CLI worker。
- 預設使用 `workspace-write`，也能針對純分析改成 `read-only`。
- 自動尋找 Codex Desktop 安裝目錄中最新的 `codex.exe`。
- 遇到含中文等非 ASCII 字元的 Windows 專案路徑時，自動建立純 ASCII junction，避免子程序落到錯誤的工作目錄。
- 支援模型、推理強度、JSON 事件與最終回覆檔案等選項。
- 限制為一次一個外部 worker，並保留父 agent 對範圍與驗證的責任。

## 必要條件

- Windows PowerShell 5.1 或 PowerShell 7
- 已安裝 Codex Desktop／Codex CLI，且 `codex.exe` 位於 `%LOCALAPPDATA%\OpenAI\Codex\bin`
- 目標工作目錄預設為 Git 倉庫；只有刻意處理非 Git 目錄時才使用 `-SkipGitCheck`

## 安裝成 Codex skill

先複製倉庫，再把 skill 安裝到個人 Codex skill 目錄：

```powershell
git clone https://github.com/nojackno2-ctrl/agent-delegation-tools.git
Set-Location -LiteralPath '.\agent-delegation-tools'

$skillSource = Resolve-Path '.\skills\agent-delegation-tools'
$skillDestination = Join-Path $env:USERPROFILE '.codex\skills\agent-delegation-tools'

if (Test-Path -LiteralPath $skillDestination) {
    Get-ChildItem -LiteralPath $skillSource -Force |
        Copy-Item -Destination $skillDestination -Recurse -Force
} else {
    Copy-Item -LiteralPath $skillSource -Destination $skillDestination -Recurse
}
```

重新開啟一個 Codex task 後，可明確呼叫：

```text
$agent-delegation-tools 把這個有明確邊界的工作交給一個獨立 Codex CLI worker
```

這個 skill 適合以下情況：

- 使用者明確要求委派給獨立 Codex worker。
- 外部 agent 需要把一個 bounded task 交給 Codex 實作。
- Windows 非 ASCII 工作目錄會讓 Codex CLI 沙箱無法正確進入專案。

一般程式工作應直接由目前的 Codex 完成。若 Codex 原生協作工具可用，而且使用者要求子代理或平行工作，優先使用原生協作工具。

## 直接使用 `codex.ps1`

倉庫根目錄的 `codex.ps1` 是相容入口；實作位於 skill 的 `scripts` 目錄。

```powershell
# 在目前專案執行一個實作工作
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\codex.ps1 `
    '把 app/world.mjs 的 X 重構成 Y'

# 指定工作目錄
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\codex.ps1 `
    -WorkDir 'C:\path\to\project' `
    '修正 parser，執行 focused tests，且不要提交或推送'

# 純分析，不允許修改檔案
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\codex.ps1 `
    -Sandbox read-only `
    '找出 parser 失敗原因，提供檔案與行號證據，不要修改檔案'

# 只把 worker 的最終回覆寫入 UTF-8 檔案
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\codex.ps1 `
    -OutFile '.\result.txt' `
    '檢查這個專案的測試失敗'
Get-Content -LiteralPath '.\result.txt' -Encoding UTF8
```

`ExecutionPolicy Bypass` 只作用在這一次 PowerShell 程序，不會修改系統或使用者的全域 execution policy。

## 參數

| 參數 | 用途 |
|---|---|
| `-WorkDir <path>` | 指定 worker 的專案目錄；省略時使用目前目錄 |
| `-Sandbox read-only\|workspace-write\|danger-full-access` | 設定 worker 權限；預設為 `workspace-write` |
| `-Model <model>` | 覆蓋 Codex 預設模型 |
| `-Effort low\|medium\|high\|xhigh\|ultra\|max` | 覆蓋 `model_reasoning_effort` |
| `-OutFile <path>` | 只將最終回覆寫入指定檔案 |
| `-Json` | 輸出 JSON 事件流 |
| `-SkipGitCheck` | 允許刻意在非 Git 目錄執行 |
| `-NoAliasPath` | 停用非 ASCII 路徑的 junction 修正 |

## 非 ASCII 路徑處理

Codex CLI 的 Windows 沙箱可能無法把含非 ASCII 字元的路徑設為工作目錄，導致啟動後落到 `C:\`，相對路徑與 Git 操作因而失敗。

wrapper 會在 `%USERPROFILE%\codex-ws\<slug>` 建立指向真實專案的 junction，然後將純 ASCII 路徑交給 Codex。junction 指向同一批檔案，不是專案複本；若同名 junction 指向舊位置，wrapper 會在確認它確實是 junction 後重新建立。

若同名位置不是 junction，wrapper 會拒絕修改並停止，避免覆寫一般檔案或目錄。

## 安全邊界

- 父 agent 必須先檢查目標專案的 `AGENTS.md`、`AI_HANDOFF.md`、Git 狀態與現有 diff。
- 純調查使用 `read-only`；只有使用者已授權實作時才使用 `workspace-write`。
- 不要讓 worker 再遞迴委派另一個 worker。
- worker 的文字報告不是驗證證據；父 agent 必須自行檢查 diff，並執行相稱的測試。
- 除非使用者明確要求，task prompt 應禁止 commit、push、reset、rebase、刪除分支或 release。

## 專案結構

```text
.
├── codex.ps1
├── skills/
│   └── agent-delegation-tools/
│       ├── SKILL.md
│       ├── agents/openai.yaml
│       └── scripts/codex.ps1
├── AGENTS.md
└── AI_HANDOFF.md
```

`codex.ps1` 只負責轉送參數，skill 內的 `scripts/codex.ps1` 才是唯一實作來源。
