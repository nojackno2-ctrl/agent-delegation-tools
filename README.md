# 子代理調度工具箱 (Agent Delegation Tools)

[![Platform](https://img.shields.io/badge/Platform-Windows%2010%20%7C%2011-blue.svg)](https://www.microsoft.com/windows)
[![Shell](https://img.shields.io/badge/PowerShell-5.1%20%7C%207%2B-blue.svg)](https://github.com/PowerShell/PowerShell)
[![Supported Agents](https://img.shields.io/badge/Supported%20Agents-Antigravity%20%7C%20Codex%20%7C%20Claude%20Code-brightgreen.svg)](#三大子代理後端與調度矩陣)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**Agent Delegation Tools** 是一套專為 Windows 環境打造的跨代理外部子代理（Subagent）調度框架與 CLI 工具庫。

讓你的主 AI Agent（無論是 **Google Antigravity**、**OpenAI Codex** 或 **Anthropic Claude Code**）能夠將複雜實作、大型架構分析、深度代碼審查等特定任務，無縫且安全地委派給獨立的外部 CLI 處理進程。

---

## 為什麼需要 Agent Delegation Tools？

在現代 AI 輔助開發中，讓單一主代理處理所有工作容易遭遇脈絡污染、Token 消耗劇增、或受限於單一模型的專長短板。然而，在 Windows 上調用外部 Agent CLI 進程時，往往會踩進許多系統級地雷：

- ⚠️ **Windows 中文/非 ASCII 路徑沙箱失效**：Codex CLI 沙箱遇到非 ASCII 路徑會默默重定向至 `C:\`，導致相對路徑與 Git 全部失效。
- ⚠️ **PowerShell 與 Stdin 阻塞卡死**：外部 CLI 進程若等待互動式 stdin 輸入，會導致父進程或自動化腳本永久懸掛。
- ⚠️ **Windows 終端編碼亂碼**：Windows 預設 CP950/ANSI 編碼常使外部 Agent 輸出的中文變為亂碼。
- ⚠️ **母進程脈絡重複載入 (Token 爆炸)**：Claude 等 Agent 預設會載入所有全域 Plugin、Skill、Hook 與 MCP，使一次委派就消耗近 50,000 Prompt Tokens。

本專案透過四支 PowerShell 封裝核心腳本與統一 Skill 適配器，徹底解決上述所有痛點。

---

## 三大子代理後端與調度矩陣

| 後端 / 工具 | 核心腳本 | 核心專長與適用情境 | 預設模型 | 額度消耗來源 |
|---|---|---|---|---|
| **Google Antigravity CLI** | [`agy.ps1`](./agy.ps1) | 超長上下文閱讀、快速 Scaffolding、架構模組分析、Plan 模式規劃 | `gemini-3.6-flash-low` (可選 Pro / Claude / GPT) | Google Antigravity |
| **OpenAI Codex CLI** | [`codex.ps1`](./codex.ps1) | 跨多檔案複雜實作、大型重構、重度編碼（內建 Windows 中文路徑 Junction 修復） | `gpt-5.6-sol` (可選 o-series) | OpenAI / ChatGPT |
| **Anthropic Claude Code** | [`claude.ps1`](./claude.ps1) | 深度邏輯審查、安全邊界掃描、架構對齊；支援工作階段接續（Resume） | `sonnet` / `opus` | Anthropic Claude |
| **統一智慧調度器** | [`delegate.ps1`](./delegate.ps1) | 依任務類型自動路由：`analysis`/`scaffolding` → AGY，`review` → Claude，`implementation` → Codex | 依任務自動選型 | 依選用後端 |

### 本機 CLI 安裝路徑動態解析

所有腳本均具備智慧定位能力，無需手動寫死路徑：
- `codex.exe`：自動搜尋 `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe` 最新版本（每次更新 hash 變更皆能自適應）。
- `agy.exe`：優先自 `%LOCALAPPDATA%\agy\bin\agy.exe` 或系統 `PATH` 動態解析。
- `claude.exe`：優先搜尋系統 `PATH`，次選 `%USERPROFILE%\.local\bin\claude.exe`；若是 npm 安裝的 `claude.cmd` 則自動切換為 `cmd.exe` 橋接啟動。

---

## 核心設計與安全機制

```
+-----------------------------------------------------------------------------+
|                             主 AI Coding Agent                              |
|                    (Antigravity / Codex / Claude Code)                      |
+-----------------------------------------------------------------------------+
                                       │
                      調派任務 (Prompt + TaskType)
                                       ▼
+-----------------------------------------------------------------------------+
|                         統一調度器 (delegate.ps1)                           |
+-----------------------------------------------------------------------------+
            │                                 │                               │
 任務: analysis / scaffolding        任務: implementation               任務: review
            │                                 │                               │
            ▼                                 ▼                               ▼
  ┌───────────────────┐             ┌───────────────────┐           ┌───────────────────┐
  │  agy.ps1 (AGY)    │             │  codex.ps1 (Codex)│           │ claude.ps1 (Claude)│
  ├───────────────────┤             ├───────────────────┤           ├───────────────────┤
  │ * 極速 Flash 模型  │             │ * 中文路徑Junction│           │ * Isolated 脈絡   │
  │ * Plan 規劃模式   │             │ * workspace-write │           │   節省 90% Tokens │
  │ * UTF-8 輸出管道  │             │ * stdin 防掛死    │           │ * Resume 多輪工作 │
  │ * Stdin $null 導向│             │ * UTF-8 OutFile   │           │ * 900s 逾時/防遞迴│
  └───────────────────┘             └───────────────────┘           └───────────────────┘
```

1. **中文 / 非 ASCII 路徑 Junction 自動修復**：
   - Codex Windows 沙箱在非 ASCII 路徑下會失常。`codex.ps1` 自動於 `%USERPROFILE%\codex-ws\<slug>` 建立純 ASCII Junction 映射，使 Git 與相對路徑運作完全正常。
2. **Claude 脈絡隔離（節省高達 90%+ Tokens）**：
   - `claude.ps1` 預設 `-Context isolated`（開啟 `--safe-mode`），不載入全域插件、MCP 與肥大提示詞。
   - **實測數據**：無隔離呼叫約消耗 **48.7k tokens**；開啟隔離後降至 **7.0k tokens**；搭配 `-Tools` 收窄工具集更僅需 **3.6k tokens**！
3. **安全 Stdin 管線與防掛死機制**：
   - `agy.ps1` 與 `codex.ps1` 將輸入重定向至 `$null`，杜絕外部 CLI 停等 stdin。
   - `claude.ps1` 將 Prompt 寫入 UTF-8 臨時檔案經由 stdin 饋入，確保引號、換行與多國語言字元絕不被 Windows 命令列解析破壞。
4. **工作階段延續與多輪對話 (Resumable Sessions)**：
   - `claude.ps1` 每次執行均會輸出 Session ID，後續任務可透過 `-Resume <session-id>` 接續同一個 worker，無需重複傳遞冗長的專案背景。
5. **逾時、額度偵測與防遞迴保護**：
   - `claude.ps1` 內建硬性計時器（預設 900 秒，逾時自動終止並回傳退出碼 `124`）。
   - 遇到 API 額度耗盡時回傳退出碼 `10`，提示呼叫端切換後端而非盲目重試。
   - 透過環境變數 `CLAUDE_DELEGATION_DEPTH` 嚴格防止子代理遞迴巢狀調用。

---

## 快速使用 (CLI 指令範例)

所有腳本位於專案根目錄與 `skills/agent-delegation-tools/scripts/` 目錄下：

### 1. 統一智慧調度器 (`delegate.ps1`)

```powershell
# 自動依任務類型選擇最佳子代理（analysis 自動導向 AGY Flash；implementation 導向 Codex）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\delegate.ps1 -TaskType analysis "分析 src/core/auth.ts 的模組依賴關係"

# 指定子代理後端與沙箱模式
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\delegate.ps1 -Agent codex -Sandbox workspace-write "實作 src/lexer.js 的錯誤恢復機制"

# 指定審查任務（自動導向 Claude Code，並保存結果至檔案）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\delegate.ps1 -TaskType review -OutFile "$env:TEMP\review.txt" "審查 PR 安全性與潛在漏洞"
```

### 2. Antigravity CLI 子代理 (`agy.ps1`)

```powershell
# 快速執行分析任務（預設 gemini-3.6-flash-low，速度極快、成本極低）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\agy.ps1 "分析當前專案模組架構"

# 使用 Plan 規劃模式（唯讀，不變更任何檔案）並輸出至檔案
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\agy.ps1 -Mode plan -OutFile "$env:TEMP\agy-plan.txt" "制定資料庫遷移與重構計畫"

# 切換高階推理模型與指定推理強度
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\agy.ps1 -Model gemini-3.1-pro-low -Effort high "審查高複雜度演算法之正確性"
```

### 3. OpenAI Codex CLI 子代理 (`codex.ps1`)

```powershell
# 執行實作任務（預設 workspace-write 沙箱，自動修復中文路徑）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\codex.ps1 "把 app/world.mjs 重構為 TypeScript 模組"

# 純分析模式（read-only，不修改檔案）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\codex.ps1 -Sandbox read-only "說明 app/scene3d.mjs 的渲染流程"

# 指定工作目錄與自訂輸出檔案
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\codex.ps1 -WorkDir "D:\Projects\MyApp" -OutFile "$env:TEMP\result.txt" "實作新功能"
```

### 4. Anthropic Claude Code 子代理 (`claude.ps1`)

```powershell
# 執行深度安全審查（預設 plan 唯讀模式 + isolated 隔離脈絡）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\claude.ps1 -OutFile "$env:TEMP\review.txt" "審查 src/api.ts 的邊界條件"

# 允許編輯並放行特定驗證指令（例如 npm test）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\claude.ps1 -Mode acceptEdits -AllowedTools 'Bash(npm test)' "修復失敗的單元測試，執行 npm test 並回報結果"

# 多輪對話接續（使用前一次執行回傳的 Session ID）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\claude.ps1 -Resume <session-id> "針對剛才提出的第 2 點建議進行實作"
```

---

## 參數速查表

| 腳本 | 核心參數 | 說明 |
|---|---|---|
| `delegate.ps1` | `-Prompt <string>` | 任務提示詞（必填） |
| | `-Agent <auto\|agy\|codex\|claude>` | 指定主要後端（預設 `auto`） |
| | `-FallbackAgent <list>` | 額度耗盡時的接手順序，需明確指定；未指定則只跑主要後端 |
| | `-TaskType <analysis\|implementation\|scaffolding\|review>` | 任務類型（自動路由依據，預設 `analysis`） |
| | `-Sandbox <read-only\|workspace-write\|danger-full-access>` | 沙箱權限模式（**預設 `read-only`**，要寫檔須明確指定） |
| | `-AgyModel` / `-CodexModel` / `-ClaudeModel` | 各後端專屬模型，覆寫共用的 `-Model` |
| | `-AgyEffort` / `-CodexEffort` / `-ClaudeEffort` | 各後端專屬推理強度，覆寫共用的 `-Effort` |
| | `-OutFile <path>` / `-WorkDir <path>` / `-AddDir <list>` | 輸出檔案路徑（UTF-8） / 工作目錄 / 追加工作目錄 |
| `agy.ps1` | `-Mode <plan\|accept-edits\|read-only\|workspace-write>` | 執行模式（**預設 `plan`** 唯讀，要寫檔須明確指定） |
| | `-Model <model-name>` | 指定模型（省略則由 AGY 自身預設決定） |
| | `-Effort <low\|medium\|high>` / `-PrintTimeout <5m>` | 推理強度 / AGY 自身的輸出逾時 |
| `codex.ps1` | `-Sandbox <read-only\|workspace-write\|danger-full-access>` | 沙箱權限（預設 `workspace-write`） |
| | `-Effort <low\|medium\|high\|xhigh\|ultra\|max>` | 推理強度設定 |
| | `-Ephemeral` / `-AddDir <list>` | 用完即棄的工作階段 / 追加可寫目錄 |
| | `-NoAliasPath` | 略過自動 Junction 建立（除錯用） |
| `claude.ps1` | `-Mode <plan\|acceptEdits\|...>` | 權限模式（預設 `plan` 唯讀模式） |
| | `-Context <isolated\|project>` | 脈絡模式（預設 `isolated`，省 90% tokens） |
| | `-Tools` / `-AllowedTools` | 工具集限制 / 白名單指令放行（例如 `'Bash(npm test)'`） |
| | `-Resume <session-id>` / `-ForkSession` | 接續現有工作階段 / 分支新工作階段 |
| | `-TimeoutSec <int>` (預設 900) | 硬性逾時秒數（逾時自動終止進程並返回 code `124`） |

---

## 讓各 AI Coding Agent 載入 Skill

整包 Skill 以 `skills/agent-delegation-tools/` 為單一真相來源；四種 Host 讀的是同一份 `SKILL.md`，不再有各自的適配器分支。

| AI Agent | 個人（全域）安裝位置 | 備註 |
|---|---|---|
| **Codex CLI** | `%CODEX_HOME%\skills\` 或 `~/.codex/skills/` | 僅讀取全域路徑 |
| **Antigravity (AGY)** | `~/.agents/skills/` | 亦讀取專案內 `.agents/skills/` |
| **Claude Code** | `~/.claude/skills/` | 亦讀取專案內 `.claude/skills/` |
| **VS Code Copilot Chat** | `%COPILOT_HOME%\skills\` 或 `~/.copilot/skills/` | 需 VS Code 1.106+；另會掃描 `~/.agents/skills/`、`~/.claude/skills/` 與專案內 `.github/skills/`、`.agents/skills/`、`.claude/skills/` |

### 一鍵安裝

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

`install.ps1` 以自身所在位置定位來源，複製後逐檔比對 SHA-256；不帶參數時只安裝到**本機已存在**的 Host 目錄，不會替沒裝的工具亂建資料夾。

```powershell
# 先看會改什麼，不寫入任何檔案
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -DryRun

# 安裝到全部四個 Host（缺的目錄會建立）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -All

# 只裝給 VS Code Copilot，並清掉舊版殘留檔案
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Target copilot -Prune
```

`-Target` 可接受 `codex` / `agents` / `claude` / `copilot`，可複選。

### VS Code Copilot Chat 額外設定

Copilot 每次執行封裝腳本都會要求核准終端機指令。若要免除，加到 VS Code 的 `settings.json`：

```json
"chat.tools.terminal.autoApprove": {
  "/agent-delegation-tools[\\\\/]scripts[\\\\/](delegate|codex|agy|claude)\\.ps1/i": {
    "approve": true,
    "matchCommandLine": true
  }
}
```

這條規則只放行**已安裝 Skill 包裡**的四支腳本。外部 CLI 有自己的沙箱、不受 VS Code 權限機制管轄，請確認你接受這個取捨再加。

### 在對話中調用

- **Claude Code**：
  ```
  Skill("agent-delegation-tools", "將這個模組重構任務委派給獨立子代理 worker 執行")
  ```
- **Antigravity**：
  ```
  請使用 agent-delegation-tools skill，將這個架構分析任務委派給獨立子代理 worker。
  ```
- **Codex CLI**：
  ```
  $agent-delegation-tools 把這個實作任務交給獨立子代理 worker 處理
  ```
- **VS Code Copilot Chat**：在聊天框輸入 `/agent-delegation-tools`，或直接描述需求讓模型自行載入。

---

## 專案結構

```
.
├── delegate.ps1                      # 統一調度器入口（轉發至 scripts/delegate.ps1）
├── agy.ps1                           # Antigravity CLI 入口（轉發至 scripts/agy.ps1）
├── codex.ps1                         # Codex CLI 入口（轉發至 scripts/codex.ps1）
├── claude.ps1                        # Claude Code 入口（轉發至 scripts/claude.ps1）
├── parallel.ps1                      # 多任務並行批次與同步摘要入口
├── status.ps1                        # 三個 CLI 的可驗證用量狀態入口
├── install.ps1                       # 一鍵安裝／同步至各 Host 的 Skill 目錄
├── validate.ps1                      # 無副作用的煙霧／一致性驗證腳本
├── AGENTS.md                         # 跨 Agent 協同作業規範
├── AI_HANDOFF.md                     # 即時專案狀態與交接記憶庫
├── README.md                         # 本專案說明文件
├── .agents/skills/                   # Antigravity / Copilot 專案級 Skill 目錄
├── .claude/skills/                   # Claude Code / Copilot 專案級 Skill 目錄
└── skills/
    └── agent-delegation-tools/       # Skill 單一真相來源（四種 Host 共用）
        ├── SKILL.md                  # Canonical 規格定義
        ├── agents/openai.yaml        # OpenAI / Codex Skill 元資料
        └── scripts/                  # 封裝腳本本體
            ├── agy.ps1
            ├── claude.ps1
            ├── codex.ps1
            ├── delegate.ps1
            ├── parallel.ps1
            └── status.ps1
```

---

## 退出碼與異常處理規範

腳本執行後會回傳明確的 Exit Code，供自動化流程判定：

| 退出碼 | 狀態含義 | 建議處理方式 |
|:---:|---|---|
| `0` | **成功完成** | 正常讀取輸出結果或 `-OutFile` 內容。 |
| `10` | **API 額度耗盡 (Quota Exceeded)** | 切換至其他可用後端（如從 Claude 切換至 AGY/Codex）或等待額度重置。**切勿**配置私人付費 API Key 盲目重試。 |
| `75` | **所有後端額度皆已耗盡** | `delegate.ps1` 依 `-FallbackAgent` 逐一嘗試後仍無可用後端。等待額度重置，切勿改用付費 API Key。 |
| `124` | **執行逾時 (Timeout)** | Worker 已被強制終止（預設 900 秒）。請將任務拆解為更小粒度後再次委派。 |
| `1` / 其他 | **執行失敗 / 錯誤** | 檢查 stderr 輸出訊息或 `-RawFile` 的詳細錯誤紀錄。 |

---

## 驗證腳本 (`validate.ps1`)

一支無副作用的煙霧／一致性驗證腳本，用來在改動任一封裝腳本或 Skill 文件後快速確認基本正確性，**絕不呼叫真正的 `claude`/`codex`/`agy` 外部模型，也不寫入任何使用者設定或全域 Skill 安裝**：

1. 以 PowerShell 語言剖析器（AST）解析所有 Git 追蹤的 `*.ps1`，確認 0 個語法錯誤。
2. 以 SHA-256 比對根目錄四支封裝腳本（`agy.ps1`／`claude.ps1`／`codex.ps1`／`delegate.ps1`）是否與 `skills\agent-delegation-tools\scripts\` 下的 canonical 副本逐位元組相同。
3. 以 SHA-256 比對 canonical `SKILL.md` 與專案內 `.agents/skills`、`.claude/skills` 副本；若本機已安裝 Codex／Antigravity／Claude Code 的全域 Skill 目錄，一併比對（未安裝則略過，不算失敗）。
4. 在**各自獨立的子行程**中（避免封裝腳本內部的 `exit` 影響到驗證腳本本身）安全地觸發：
   - 防遞迴機制（設定 `AGENT_DELEGATION_DEPTH=1`，應在解析任何外部執行檔前即被拒絕）。
   - `-Mode`/`-Sandbox` 的 `ValidateSet` 對非法值的拒絕。
   - 模式衝突防護（`codex.ps1 -ApproveForMe` 搭配 `-Sandbox read-only`、`agy.ps1 -SkipPermissions` 搭配預設 `plan`、`delegate.ps1 -Sandbox danger-full-access` 搭配 `-Agent agy`）。
   - `claude.ps1 -DryRun` 的參數映射（以系統既有的 `cmd.exe` 路徑充當無害的 `-ClaudePath` 佔位，`-DryRun` 只印出命令列即結束，佔位執行檔絕不會被啟動）。

```powershell
# Windows PowerShell 5.1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\validate.ps1

# 若已安裝 pwsh (PowerShell 7+)
pwsh -NoProfile -ExecutionPolicy Bypass -File .\validate.ps1

# 只跑靜態的 AST／一致性檢查，略過會另外啟動子行程的即時防護測試
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\validate.ps1 -SkipLiveProbes
```

結束碼 `0` 代表所有未略過的檢查均通過；`1` 代表至少一項失敗。`-ReportPath <file>` 可額外輸出 UTF-8 JSON 結果報告。

---

## 授權條款

本專案採用 [MIT License](LICENSE) 授權釋出。
