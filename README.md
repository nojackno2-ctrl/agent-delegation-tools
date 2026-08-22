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

## 三大子代理後端與能力矩陣

| 子代理後端 | MCP 工具 | 核心專長與適用情境 | 預設模型 | 額度消耗來源 |
|---|---|---|---|---|
| **Google Antigravity CLI** | `invoke_agy` | 超長脈絡閱讀、架構分析、Plan 規劃、低成本快速產出 | `gemini-3.7-flash` (支援 Low/Medium/High 推理，可選 Pro / Claude / GPT) | Google Antigravity |
| **OpenAI Codex CLI** | `invoke_codex` | 跨檔案大型實作、深度代碼重構（內建 Windows 中文路徑 Junction） | `gpt-5.6-sol` (可選 o-series) | OpenAI / ChatGPT |
| **Anthropic Claude Code** | `invoke_claude` | 深度安全審查、邏輯對齊、架構邊界掃描；支援 Session 接續 | `claude-3-7-sonnet` / `opus` | Anthropic Claude |
| **智慧動態調度器** | `delegate_task` | 自動依任務類型路由（`analysis` $\to$ AGY, `review` $\to$ Claude, `implementation` $\to$ Codex）並即時負載均衡 | 智慧選型 | 依選用後端 |
| **並行 Worker Pool** | `delegate_parallel` | 多任務並行批次分發執行（可自訂並行上限，預設 4） | 智慧選型 | 依選用後端 |
| **即時配額檢測器** | `get_agent_quotas` | 零 Token 消耗即時讀取三大 CLI 訂閱用量、剩餘百分比與重置時間 | — | 0 Token |

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
`C:/離線儲存/程式設計/子代理/mcp-server/dist/index.js`

---

### 2. 在各 AI 客戶端中註冊 MCP Server

#### 🅰️ Claude Desktop (`%APPDATA%\Claude\claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "agent-delegation": {
      "command": "node",
      "args": ["C:/離線儲存/程式設計/子代理/mcp-server/dist/index.js"]
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
      "args": ["C:/離線儲存/程式設計/子代理/mcp-server/dist/index.js"]
    }
  }
}
```

#### 🅲 Cursor / Windsurf / Zed

在設定介面新增 MCP Server：
- **Name**: `agent-delegation`
- **Command**: `node`
- **Args**: `C:/離線儲存/程式設計/子代理/mcp-server/dist/index.js`

#### 🅳 VS Code (Roo Code / Cline / Copilot)

在 MCP 設定檔中加入：
```json
{
  "mcpServers": {
    "agent-delegation": {
      "command": "node",
      "args": ["C:/離線儲存/程式設計/子代理/mcp-server/dist/index.js"],
      "disabled": false,
      "autoApprove": [
        "get_agent_quotas",
        "delegate_task",
        "delegate_parallel"
      ]
    }
  }
}
```

---

## MCP 提供之標準工具 (Tools) 詳解

### 1. `get_agent_quotas`（即時配額查詢）
零 Token 消耗讀取本機各 CLI 的剩餘訂閱額度、使用率與重置時間。
- **參數**：
  - `agent` (string, 可選): `"all"` (預設) | `"codex"` | `"claude"` | `"agy"`
  - `timeout_sec` (number, 可選): 查詢逾時秒數（預設 20）
  - `bypass_cache` (boolean, 可選): 是否繞過 10 秒 TTL 記憶體快取強制重整（預設 `false`）
  - `work_dir` (string, 可選): 工作目錄上下文

### 2. `delegate_task`（智慧調度與負載均衡）
智慧評估任務性質與當前各後端配額健康度，自動路由至最佳後端執行。
- **參數**：
  - `prompt` (string, 必填): 任務說明或指令
  - `task_type` (enum, 可選): `"analysis"` (預設, 導向 AGY) | `"implementation"` (導向 Codex) | `"review"` (導向 Claude) | `"scaffolding"`
  - `sandbox` (enum, 可選): `"read-only"` (預設) | `"workspace-write"` (修改程式碼時使用) | `"danger-full-access"`
  - `balance_quota` (boolean, 可選): 自動避開額度剩餘 $\le 10\%$ 或已耗盡的後端（預設 `true`）
  - `agent` (enum, 可選): 強制指定後端 (`"auto"` | `"codex"` | `"claude"` | `"agy"`)
  - `fallback_agent` (enum, 可選): 指定備用後端 (`"codex"` | `"claude"` | `"agy"` | `"none"`)
  - `work_dir` (string, 可選): 執行工作目錄
  - `agy_model` / `codex_model` / `claude_model`: 模型覆寫參數
  - `agy_effort`: Antigravity 思考強度 (`"low"` | `"medium"` | `"high"`)

### 3. `delegate_parallel`（多任務並行 Worker Pool）
同時分發多項子代理任務並行處理，保持原始索引與輸出摘要。
- **參數**：
  - `tasks` (array of string, 必填): 待執行的任務提示詞陣列
  - `task_type` (enum, 可選): `"analysis"` | `"implementation"` | `"review"` | `"scaffolding"`
  - `sandbox` (enum, 可選): `"read-only"` | `"workspace-write"` | `"danger-full-access"`
  - `max_concurrency` (number, 可選): 最大並行工作進程數（預設 4，上限 16）
  - `work_dir` (string, 可選): 工作目錄

### 4. `invoke_agy`（直接呼叫 Antigravity CLI）
- **參數**：`prompt`, `mode` (`"plan"` | `"accept-edits"`), `model`, `effort`, `work_dir`, `timeout_sec`

### 5. `invoke_codex`（直接呼叫 OpenAI Codex CLI）
- **參數**：`prompt`, `sandbox` (`"read-only"` | `"workspace-write"`), `model`, `effort`, `work_dir`, `timeout_sec`

### 6. `invoke_claude`（直接呼叫 Anthropic Claude Code CLI）
- **參數**：`prompt`, `mode`, `context` (`"isolated"` 預設省 90% tokens | `"project"`), `session_id`, `resume`, `work_dir`, `timeout_sec`

---

## 退出碼與異常處理規範

| 退出碼 | 狀態含義 | 建議處理方式 |
|:---:|---|---|
| `0` | **成功完成** | 正常讀取輸出結果。 |
| `10` | **API 額度耗盡 (Quota Exceeded)** | 自動負載平衡器會將該後端在快取中標註為 `depleted` 並切換至健康後端。**切勿**配置私人付費 API Key 盲目重試。 |
| `75` | **所有後端額度皆已耗盡** | 依 Fallback 鏈嘗試後全部耗盡，建議等待額度重置時間。 |
| `78` | **認證或設定錯誤** | CLI 未登入或授權過期，請執行對應的 `auth login`。 |
| `124` | **執行逾時 (Timeout)** | 子代理進程已被安全終止（預設 900s），建議縮小任務粒度。 |
| `1` | **執行失敗** | 檢查 stderr 錯誤輸出。 |

---

## 自動化測試與開發維護

本專案內建完整的 **零依賴 Node.js 原生測試套件**（基於 `node:test` 與 `node:assert`）：

```powershell
cd mcp-server

# 執行單元與整合測試套件 (Core, Quota, Cache, Dispatcher)
npm test

# 執行 Stdio JSON-RPC 端對端整合煙霧測試 (Live Quota & Dispatch)
npm run test:client

# 執行 TypeScript 型別檢查
npm run lint
```

---

## 專案目錄結構

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
│       │   ├── quota/                # 原生配額查詢服務 (Codex JSON-RPC, Claude OAuth, AGY RPC, TTL 快取)
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
│       ├── tests/                    # 零依賴原生 Node.js 單元與整合測試套件
│       │   ├── core.test.ts
│       │   ├── quota-parsers.test.ts
│       │   ├── quota-cache.test.ts
│       │   └── dispatcher.test.ts
│       └── test-client.ts            # Stdio 端對端測試客戶端
├── README.md                         # 本專案說明文件 (MCP Server 核心指南)
├── AGENTS.md                         # 跨 Agent 協作規範
├── AI_HANDOFF.md                     # 即時共享專案記憶與交接手冊
└── [scripts/]                        # 獨立備用 PowerShell CLI 腳本 (非 MCP 環境終端手動呼叫)
```

---

## 附錄：終端獨立腳本備用參考 (Standalone CLI)

若需要在純 PowerShell 終端機環境中直接執行，專案根目錄亦保留備用封裝腳本：
- `.\delegate.ps1 -TaskType implementation -Sandbox workspace-write "實作功能"`
- `.\status.ps1 -Agent all`
- 驗證腳本：`powershell -ExecutionPolicy Bypass -File .\validate.ps1`

---

## 授權條款

本專案採用 [MIT License](LICENSE) 授權釋出。
