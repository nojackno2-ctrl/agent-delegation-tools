# Agent Delegation MCP Server

[![MCP](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-8A2BE2.svg)](https://modelcontextprotocol.io/)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%20%7C%2011-blue.svg)](https://www.microsoft.com/windows)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B%20%7C%2022%2B-green.svg)](https://nodejs.org/)
[![Supported Agents](https://img.shields.io/badge/Supported%20Agents-Antigravity%20%7C%20Codex%20%7C%20Claude%20Code-brightgreen.svg)](#三大子代理後端與能力矩陣)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**Agent Delegation MCP Server** 是一套標準 **Model Context Protocol (MCP)** 伺服器，專為 Windows 環境打造，提供跨 CLI 子代理（Subagent）調度、即時訂閱配額監控與智慧負載均衡服務。

透過此 MCP Server，任何支援 MCP 的 AI 客戶端（如 **Claude Desktop**, **Antigravity**, **Cursor**, **Windsurf**, **Zed**, **VS Code**）皆能以強型別 JSON-RPC 工具呼叫，將程式碼實作、架構分析、深度審查等重型任務委派給獨立的外部 CLI（**Google Antigravity CLI**, **OpenAI Codex CLI**, **Anthropic Claude Code**）。

---

## 為什麼採用 MCP 模式？

相比傳統複製提示詞檔案的 Skill 模式，**MCP Server 具備顯著優勢**：

1. **原生強型別呼叫 (JSON-RPC)**：主 Agent 直接透過標準 Tool Call 傳遞結構化參數，免除終端機指令手動審批與跳轉。
2. **極致效能與 In-Memory TTL 快取**：內建記憶體配額快取（TTL 10s）與連線快取，將配額查詢與負載均衡開銷從 2000ms+ 降至 **<2ms**。
3. **系統級 Windows 痛點自動修復**：
   - 🛡️ **中文 / 非 ASCII 路徑修復**：自動建立 NTFS 純 ASCII Junction 映射，徹底解決 Codex 沙箱在非 ASCII 路徑下失效崩潰的問題。
   - ⚡ **Token 深度隔離**：Claude Code 呼叫時自動啟用 `--safe-mode` 隔離，節省高達 **90%+ Token 消耗**。
   - 🛑 **Process Tree 終止與防掛死**：採用 Windows `CommandLineToArgvW` 轉義、`taskkill /PID /T /F` 殺死孤兒進程與防遞迴防護（`AGENT_DELEGATION_DEPTH`）。
4. **100% 零外部運行依賴**：完全以原生 TypeScript / Node.js 實作，不依賴本機 PowerShell 腳本橋接。

---

## 委派政策（預設行為）

父代理是**調度員**：實作、重構、鷹架、批次修改、整份 codebase 閱讀等工作一律外送給 CLI 子代理執行，不自己動手，也不開 Claude 子代理。

- **兩個外部 CLI 承擔主要負載。** `claude` 後端花的是和父代理同一份訂閱額度，只省 context 不省額度，因此自動路由永不選它；只有使用者指名、或 AGY 與 Codex 都耗盡時才會用到。
- **額度決定路由。** `balance_quota` 預設開啟，派工前讀三個 CLI 的即時額度（10 秒快取），耗盡者自動跳過並轉移。
- **子代理預設就有寫入權限。** `sandbox` 預設 `workspace-write`，寫入模式跳過互動提示；只有 Codex 提供 OS 沙箱邊界，AGY 與 Claude 不受 `work_dir` 限制（見下方沙箱說明）。純分析才傳 `read-only`。
- **MCP 優先發現與單一命名空間**：在 Codex 及所有支援環境中，一律優先搜尋 deferred/lazy 工具（`get_agent_quotas`、`delegate_task`、`delegate_parallel`、`invoke_agy`、`invoke_codex`、`invoke_claude`、`get_job_status`、`get_job_result`、`cancel_job`，包含 `ALL_TOOLS` / tool search），使用單一 canonical `agent_delegation` 命名空間。唯有確認無 MCP 連接時才 fallback 至 PowerShell 腳本。
- **沙盒透過主機 MCP bridge 使用外部 CLI。** `CodexSandboxOffline` 不直接繼承主機登入憑證；`invoke_*`、`delegate_*` 與 `get_agent_quotas` 由主機側 MCP Server 啟動已登入的 CLI。禁止把 `auth.json`、OAuth token 或其他憑證複製進 workspace／temp 來繞過身分隔離。在沙盒內執行 `codex mcp list` 僅讀取沙箱環境目錄，無法診斷 Desktop 主機註冊表，切勿將其誤判為 MCP 斷線。

MCP Server 會在連線時把這份政策以 `instructions` 送給客戶端，因此任何接上的代理都會依此行為。

---

## 三大子代理後端與能力矩陣

| 子代理後端 | MCP 工具 | 核心專長與適用情境 | 預設模型 | 額度消耗來源 |
|---|---|---|---|---|
| **Google Antigravity CLI** | `invoke_agy` | 超長脈絡閱讀、架構分析、Plan 規劃、低成本快速產出 | `gemini-3.8-flash` + effort `medium`（可選 `gemini-3.7-flash`、`gemini-3.1-pro` 等） | Google Antigravity |
| **OpenAI Codex CLI** | `invoke_codex` | 跨檔案大型實作、深度代碼重構（內建 Windows 中文路徑 Junction） | `gpt-6.1-sol` + effort `medium` | OpenAI / ChatGPT |
| **Anthropic Claude Code** | `invoke_claude` | 深度安全審查、邏輯對齊、架構邊界掃描；支援 Session 接續 | `claude-sonnet-5-5` + effort `medium` | Anthropic Claude（**與父代理同一份額度**） |
| **智慧動態調度器** | `delegate_task` | 自動依任務類型路由（`analysis`/`scaffolding` $\to$ AGY，`implementation`/`review` $\to$ Codex）並即時負載均衡；自動路由**不會**選 Claude | 智慧選型 | 依選用後端 |
| **並行 Worker Pool** | `delegate_parallel` | 多任務並行批次分發執行，在兩個外部 CLI 之間輪流分配（可自訂並行上限，預設 4） | 智慧選型 | 依選用後端 |
| **即時配額檢測器** | `get_agent_quotas` | 零 Token 消耗即時讀取三大 CLI 訂閱用量、剩餘百分比與重置時間 | — | 0 Token |
| **工作狀態** | `get_job_status` | 省略 `job_id` 列出保留的工作；指定 ID 查詢摘要 | — | 0 Token |
| **工作結果** | `get_job_result` | 以 `job_id` 輪詢，`wait_sec` 預設 25、上限 50 秒 | — | 0 Token |
| **取消工作** | `cancel_job` | 取消指定工作並終止子行程樹 | — | 0 Token |

---

## 快速開始與客戶端配置

### 1. 建置 MCP Server

在專案目錄下安裝依賴並編譯：

```powershell
cd mcp-server
npm install
npm run build
```

編譯完成後，可執行檔將產生於：
`<REPO_ROOT>/mcp-server/dist/index.js`

`<REPO_ROOT>` 是 clone 後 repo 的絕對路徑（含 README.md 的目錄）。在 repo 根目錄用 PowerShell `(Get-Location).Path` 找到它；建置後用 `(Resolve-Path .\mcp-server\dist\index.js).Path` 取得完整入口路徑。將下方設定範例的 placeholder 換成實際路徑；JSON 可用 `/` 或將 `\` 寫成 `\\`。Node 路徑也請依本機安裝位置調整。

---

### 2. 在各 AI 客戶端中註冊 MCP Server

#### 🅰️ Claude Desktop (`%APPDATA%\Claude\claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "agent-delegation": {
      "command": "node",
      "args": ["<REPO_ROOT>/mcp-server/dist/index.js"]
    }
  }
}
```

#### 🅱️ Antigravity / Gemini CLI (`mcp_config.json` 或 Settings)

```json
{
  "mcpServers": {
    "agent-delegation": {
      "command": "node",
      "args": ["<REPO_ROOT>/mcp-server/dist/index.js"]
    }
  }
}
```

#### 🅲 Cursor / Windsurf / Zed

在設定介面新增 MCP Server：
- **Name**: `agent-delegation`
- **Command**: `node`
- **Args**: `<REPO_ROOT>/mcp-server/dist/index.js`

#### 🅳 VS Code (Roo Code / Cline / Copilot)

在 MCP 設定檔中加入：
```json
{
  "mcpServers": {
    "agent-delegation": {
      "command": "node",
      "args": ["<REPO_ROOT>/mcp-server/dist/index.js"],
      "disabled": false,
      "autoApprove": [
        "get_agent_quotas",
        "delegate_task",
        "delegate_parallel",
        "invoke_agy",
        "invoke_codex",
        "invoke_claude",
        "get_job_status",
        "get_job_result",
        "cancel_job"
      ]
    }
  }
}
```

#### 🅴 OpenAI Codex CLI (`~/.codex/config.toml`)

單一 Canonical 表名為 `[mcp_servers.agent_delegation]`，使用絕對 Node 路徑（支援 `CODEX_MCP_NODE_PATH` 覆寫）：
```toml
[mcp_servers.agent_delegation]
command = "C:\\Program Files\\nodejs\\node.exe"
args = ["<REPO_ROOT>/mcp-server/dist/index.js"]
```

---

## MCP 提供之標準工具 (Tools) 詳解

### 1. `get_agent_quotas`（即時配額查詢）
零模型 Token 消耗讀取本機各 CLI 的剩餘訂閱額度、使用率與重置時間。Codex 與 Claude 讀取 7 天窗口；AGY 透過官方 `/usage` slash command 同時讀取 Gemini、Claude/GPT pools 的 7 天與 5 小時窗口。若 AGY `/usage` 無法提供 7 天窗口，reader 會 fail closed 為 `unavailable`，不會拿 Language Server 的短期 `quotaInfo` 冒充週額度。
- **參數**：
  - `agent` (string, 可選): `"all"` (預設) | `"codex"` | `"claude"` | `"agy"`
  - `timeout_sec` (number, 可選): 查詢逾時秒數（預設 20）
  - `bypass_cache` (boolean, 可選): 是否繞過 10 秒 TTL 記憶體快取強制重整（預設 `false`）
  - `work_dir` (string, 可選): 工作目錄上下文

### 2. `delegate_task`（智慧調度與負載均衡）
智慧評估任務性質與當前各後端配額健康度，自動路由至最佳後端執行。
- **參數**：
  - `prompt` (string, 必填): 任務說明或指令
  - `task_type` (enum, 可選): `"implementation"` (預設，導向 Codex) | `"review"` (導向 Codex) | `"analysis"` (導向 AGY) | `"scaffolding"` (導向 AGY)
  - `sandbox` (enum, 可選): `"workspace-write"` (預設) | `"read-only"` (純分析) | `"danger-full-access"`
  - `balance_quota` (boolean, 可選): 自動避開額度剩餘 $\le 10\%$ 或已耗盡的後端（預設 `true`）
  - `agent` (enum, 可選): 強制指定後端 (`"auto"` | `"codex"` | `"claude"` | `"agy"`)
  - `fallback_agent` (enum, 可選): 指定備用後端 (`"codex"` | `"claude"` | `"agy"` | `"none"`)。`"none"` 會把工作固定在主要後端：不做額度轉移、也不失敗轉移
  - `work_dir` (string, 必填): 絕對路徑，必須是既存目錄
  - `async` (boolean, 可選): 預設 `true`，立即傳回 `job_id`；`false` 同步等待
  - `timeout_sec` (number, 可選): 預設 `0` 不限執行時間；正值設定子代理逾時
  - `agy_model` / `codex_model` / `claude_model`: 模型覆寫參數
  - `agy_effort`: Antigravity 思考強度 (`"low"` | `"medium"` | `"high"`)

### 3. `delegate_parallel`（多任務並行 Worker Pool）
同時分發多項子代理任務並行處理，保持原始索引與輸出摘要。
- **參數**：
  - `tasks` (array of string, 必填): 待執行的任務提示詞陣列
  - `task_type` (enum, 可選): `"implementation"` (預設) | `"analysis"` | `"review"` | `"scaffolding"`
  - `sandbox` (enum, 可選): `"workspace-write"` (預設) | `"read-only"` | `"danger-full-access"`
  - `max_concurrency` (number, 可選): 最大並行工作進程數（預設 4，上限 16）
  - `work_dir` (string, 必填): 絕對路徑，必須是既存目錄
  - `async` (boolean, 可選): 預設 `true`，傳回整批工作的 `job_id`

### 4. `invoke_agy`（直接呼叫 Antigravity CLI）
- **參數**：`prompt`, `mode` (`"plan"` | `"accept-edits"` | `"read-only"` | `"workspace-write"`)，`model`, `effort`, `work_dir`（必填、絕對且既存目錄）, `timeout_sec`, `async`（預設 `false`）

### 5. `invoke_codex`（直接呼叫 OpenAI Codex CLI）
- **參數**：`prompt`, `sandbox` (`"read-only"` | `"workspace-write"` | `"danger-full-access"`), `model`, `effort`, `work_dir`（必填、絕對且既存目錄）, `timeout_sec`, `async`（預設 `false`）
- 寫入模式使用 `--approve-for-me` 自動審核；目前 Codex CLI 由此旗標隱含 `workspace-write`，wrapper 不會再同傳互斥的 `--sandbox workspace-write`。唯讀模式仍顯式傳 `--sandbox read-only`。
- 主機側 resolver 優先選擇同時包含 `codex.exe` 與匹配 `codex-code-mode-host.exe` 的 Desktop bundle；缺少 companion 的 `~\.codex\.sandbox-bin` 只作 fallback，避免工具呼叫 fail closed 後模型仍誤報完成。

### 6. `invoke_claude`（直接呼叫 Anthropic Claude Code CLI）
- **參數**：`prompt`, `mode`, `context` (`"isolated"` 預設 | `"project"`), `model`, `effort`, `session_id`, `resume`, `work_dir`（必填、絕對且既存目錄）, `timeout_sec`, `async`（預設 `false`）

### 7. `get_job_status`（工作摘要／列表）
- **參數**：`job_id`（可選）；省略時列出所有仍保留的工作，指定時回傳該工作狀態摘要。

### 8. `get_job_result`（輪詢工作結果）
- **參數**：`job_id`（必填）、`wait_sec`（預設 25，範圍 0–50 秒）。`0` 立即查詢；等待時間用完仍在執行時，繼續輪詢同一個 ID。

### 9. `cancel_job`（取消與清理）
- **參數**：`job_id`（必填）；終止該工作的子行程樹，取消退出碼為 `130`。

## 非同步工作流程與主機逾時

Desktop MCP 主機有自己的請求逾時限制，會忽略 `MCP_TOOL_TIMEOUT`；子代理的 `timeout_sec=0` 也無法取消主機限制。因此長任務應採「派工 → 輪詢」：

1. 呼叫 `delegate_task` 或 `delegate_parallel`，預設 `async=true`，立即取得 `job_id`。所有派工與 `invoke_*` 呼叫都必須傳入絕對且既存目錄的 `work_dir`。
2. 呼叫 `get_job_result({"job_id":"<JOB_ID>","wait_sec":25})`；單次最多等 50 秒。狀態是 `running` 時繼續輪詢，直到 `succeeded`、`failed`、`timed_out` 或 `cancelled`。收到 ID 只代表已派工，不能當成成功。
3. 用 `get_job_status` 列出工作或查摘要；需要停止時呼叫 `cancel_job`，它會終止子行程樹。
4. 結果包含 `attempts` 容錯切換歷史，可追查每個後端嘗試及失敗原因。過長輸出保留尾端（tail-truncated），並附完整 log 檔路徑；檢查結果時必要可讀取完整 log。

`invoke_agy`、`invoke_codex`、`invoke_claude` 預設同步（`async=false`），長任務請明確傳 `async=true`，再使用同一套輪詢流程。`delegate_*` 也可傳 `async=false` 同步等待，但仍受主機請求逾時限制。完成工作在記憶體中保留 1 小時，最多 50 筆；執行中的工作不因保留期限被移除。主機重啟／重新連線載入新 Server 時，記憶體工作列表不會持久保存。

## 沙箱邊界與 Windows 疑難排解

只有 **Codex** 的 `workspace-write` 提供 OS 沙箱限制。**AGY** 寫入模式使用 `--dangerously-skip-permissions`，**Claude CLI** 使用 `bypassPermissions`：兩者跳過權限提示，**不會被限制在 `work_dir`**。`work_dir` 是工作起始目錄；父代理仍須界定可修改檔案並審查 diff。`read-only` 分別映射為 AGY `plan`、Claude `plan`、Codex `read-only`；前兩者是 CLI 計畫模式，不能宣稱等同 OS 檔案隔離。`danger-full-access` 也沒有 workspace 沙箱邊界。

若 Codex 記錄 `helper_unknown_error: setup refresh had errors`，並出現 `write ACE failed ... open ACL target for update`，repo 資料夾可能由另一個（已孤立的）SID 擁有，導致 Windows 沙箱無法更新 ACL；這和 Git 的 `dubious ownership` 是同一個所有權問題。在**系統管理員**終端機，將 `<repo>` 換成受影響 repo 的絕對路徑後執行：

```powershell
takeown /F <repo> /R /D Y
```

修復所有權後重試；單純增加逾時不會修好 ACL。此處只是操作說明，不會自動修改主機設定。

---

## 退出碼與異常處理規範

| 退出碼 | 狀態含義 | 建議處理方式 |
|:---:|---|---|
| `0` | **成功 (Success)** | 讀取結果並驗證變更。 |
| `1` | **一般失敗 (Generic failure)** | 檢查 stderr 與完整 log。 |
| `10` | **單一供應商額度耗盡 (Single provider quota exceeded)** | 調度器嘗試健康備援；勿以私人 API Key 盲目重試。 |
| `75` | **所有供應商耗盡／拒絕遞迴委派 (All providers depleted / recursive delegation refused)** | 等待額度重置或移除遞迴派工；勿繞過深度防護。 |
| `78` | **設定／認證錯誤 (Config/auth error)** | 修復設定或執行對應登入；不當成額度耗盡。 |
| `79` | **環境失敗 (Environment failure)** | 例如 Codex Windows 沙箱設定失敗；調度器會切換備援 (fails over)，查看 `attempts` 並修復環境。 |
| `124` | **逾時 (Timeout)** | 子代理 `timeout_sec` / `-TimeoutSec` 預設 `0` 不限時；正值限制執行，配額查詢另有逾時。 |
| `130` | **取消 (Cancelled)** | 使用者或呼叫端取消；子行程樹已終止。 |

退出碼唯一來源為 [`mcp-server/src/core/types.ts`](mcp-server/src/core/types.ts) 的 `EXIT_CODES`；README 與 SKILL 表格依此同步。

---

## 自動化測試與開發維護

本專案內建完整的 **零依賴 Node.js 原生測試套件**（基於 `node:test` 與 `node:assert`）：

```powershell
cd mcp-server

# 執行單元與整合測試套件，含使用測試替身的 Stdio JSON-RPC 測試
npm test

# 執行 TypeScript 型別檢查
npm run lint
```

---

## 專案目錄結構

### 兩套前端與同步規則

PowerShell wrappers 與 TypeScript MCP Server 是刻意保留的兩套前端：前者支援純終端／無 MCP 的環境，後者以原生 TypeScript 提供 MCP 工具，不透過 PowerShell 橋接。預設模型／effort 以 `mcp-server/src/core/defaults.ts` 為準，退出碼以 `mcp-server/src/core/types.ts` 為準；`tests/parity.Tests.ps1` 檢查兩套前端的預設模型與退出碼一致性。詳見 [架構與前端同步說明 (docs/architecture.md)](docs/architecture.md)。

PowerShell 腳本只存放於 `skills/agent-delegation-tools/scripts/`，技能說明只存放於 `skills/agent-delegation-tools/SKILL.md`；`install.ps1` 將此套件安裝到使用者技能目錄。從 repo 根目錄執行 parity 檢查：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/parity.Tests.ps1
```

```
.
├── mcp-server/                       # Model Context Protocol (MCP) Server 核心專案
│   ├── package.json                  # TypeScript / Node.js 專案配置
│   ├── tsconfig.json                 # TypeScript 編譯設定
│   └── src/
│       ├── index.ts                  # MCP Stdio Server 入口與 Tool 註冊
│       ├── core/                     # 核心基礎設施 (行程管理、路徑轉義、NTFS Junction、可執行檔快取)
│       │   ├── executables.ts
│       │   ├── junction.ts
│       │   ├── process.ts
│       │   └── types.ts
│       ├── services/
│       │   ├── quota/                # 原生配額查詢服務 (Codex JSON-RPC, Claude OAuth, AGY /usage, TTL 快取)
│       │   │   ├── agy-quota.ts
│       │   │   ├── claude-quota.ts
│       │   │   ├── codex-quota.ts
│       │   │   └── quota-service.ts
│       │   ├── invokers/             # 原生 CLI 呼叫器 (AGY, Codex, Claude)
│       │   │   ├── agy-invoker.ts
│       │   │   ├── claude-invoker.ts
│       │   │   └── codex-invoker.ts
│       │   └── dispatcher/           # 智慧調度服務 (動態負載均衡、並行 Worker Pool)
│       │       ├── delegate-service.ts
│       │       └── parallel-service.ts
│       ├── tools/                    # MCP 工具定義 (get_agent_quotas, delegate_task, delegate_parallel 等)
│       │   ├── quota.ts
│       │   ├── delegate.ts
│       │   └── invokers.ts
│       └── tests/                    # 零依賴原生 Node.js 單元與整合測試套件
│       │   ├── core.test.ts
│       │   ├── quota-parsers.test.ts
│       │   ├── quota-cache.test.ts
│       │   └── dispatcher.test.ts
├── README.md                         # 本專案說明文件 (MCP Server 核心指南)
├── AGENTS.md                         # 跨 Agent 協作規範
├── AI_HANDOFF.md                     # 即時共享專案記憶與交接手冊
├── docs/handoff-archive.md            # 2026-10-03 以前的交接歷史
├── docs/architecture.md               # 兩套前端架構與 Parity 同步規範
└── skills/agent-delegation-tools/scripts/ # PowerShell 腳本
```

---

## 附錄：終端獨立腳本備用參考 (Standalone CLI)

若需要在純 PowerShell 終端機環境中直接執行，從專案根目錄呼叫技能套件的封裝腳本：

- `.\skills\agent-delegation-tools\scripts\delegate.ps1 -TaskType implementation -Sandbox workspace-write "實作功能"`
- `.\skills\agent-delegation-tools\scripts\status.ps1 -Agent all`
- 驗證腳本：`powershell -ExecutionPolicy Bypass -File .\validate.ps1`

---

## 授權條款

本專案採用 [MIT License](LICENSE) 授權釋出。
