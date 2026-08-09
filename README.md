# 子代理 (Agent Delegation Tools)

把外部 AI Agent CLI 接成獨立子代理（Subagent）的工具庫、調度器與最佳實踐。

支援 **Antigravity CLI (`agy`)**、**OpenAI Codex CLI** 與 **Claude Code** 三大 AI Agent 後端，提供跨代理調派、多後端智慧路由、Windows 非 ASCII 沙箱路徑修復、UTF-8 編碼保證與 stdin 防阻塞機制。

---

## 三大子代理後端與調度器

| 後端 / 工具 | 呼叫腳本 | 核心專長 / 適用情境 | 預設模型 | 額度消耗 |
|---|---|---|---|---|
| **Antigravity CLI (AGY)** | `agy.ps1` | 超長上下文閱讀、快速 Scaffolding、架構分析、Plan 模式規劃 | `gemini-3.6-flash-low` (可選 Pro / Claude / GPT-OSS) | Google Antigravity |
| **Codex CLI** | `codex.ps1` | 複雜多檔案實作、重構、強實作者（內建 Windows 中文路徑 Junction 修復） | `gpt-5.6-sol` (可選 o-series) | ChatGPT / OpenAI |
| **Claude Code** | `claude.ps1` | 深入程式碼探索、安全性審查、架構對齊；可續談的多輪 worker | `sonnet` / `opus` | Anthropic Claude |
| **統一調度器** | `delegate.ps1` | 依任務類型自動路由：`analysis`/`scaffolding` → AGY、`review` → Claude、`implementation` → Codex | 自動選型 | 依選用後端 |

### 三個 CLI 在這台機器上的安裝位置

除了 PATH 之外都不需要另外設定，wrapper 會自己解析：

- `codex.exe` — `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`。hash 資料夾每次更新都會變，所以 `codex.ps1` 是呼叫當下才去找最新的那支，不寫死路徑。
- `agy.exe` — `%LOCALAPPDATA%\agy\bin\agy.exe`，已在 PATH 上。模型清單用 `agy models` 查，會隨版本變動，不要照抄舊筆記。
- `claude.exe` — `%USERPROFILE%\.local\bin\claude.exe`（原生安裝）。`claude.ps1` 先找 PATH，再退回這個路徑；若是 npm 安裝的 `claude.cmd`，會自動改走 `cmd.exe` 啟動。
- `cc-antigravity-plugin` — Claude Code plugin（user scope），提供 `/cc-antigravity-plugin:antigravity` 指令與 `antigravity-coder` / `antigravity-agent` 兩個內建子代理。跟本倉庫的 `agy.ps1` 是兩條不同的路徑：plugin 走 bridge，`agy.ps1` 直接叫 `agy.exe`。

---

## 快速使用 (CLI 腳本)

所有腳本均放置於倉庫根目錄（自動轉發）與 `skills/agent-delegation-tools/scripts/`：

### 1. 統一調度器 (`delegate.ps1`)

```powershell
# 自動依任務類型選擇最佳子代理（analysis 預設導向 AGY Flash；implementation 預設導向 Codex）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\delegate.ps1 -TaskType analysis "分析 src/架構.ts 的依賴關係"

# 指定子代理後端
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\delegate.ps1 -Agent codex -Sandbox workspace-write "實作 lexer.js 的錯誤恢復機制"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\delegate.ps1 -Agent agy -Mode plan "規劃資料庫遷移方案"
```

### 2. Antigravity CLI 子代理 (`agy.ps1`)

```powershell
# 快速執行分析任務
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\agy.ps1 "分析當前專案模組架構"

# 使用 Plan 模式與指定模型
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\agy.ps1 -Mode plan -Model gemini-3.6-flash-low -OutFile "$env:TEMP\agy-plan.txt" "制定重構計畫"

# 高推理強度
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\agy.ps1 -Model gemini-3.1-pro-low -Effort high "審查複雜演算法正確性"
```

### 3. Codex CLI 子代理 (`codex.ps1`)

```powershell
# 執行實作任務（預設 workspace-write 沙箱）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\codex.ps1 "把 app/world.mjs 的 X 重構成 Y"

# 純分析模式（read-only，不修改檔案）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\codex.ps1 -Sandbox read-only "說明 app/scene3d.mjs 怎麼組場景"

# 指定工作目錄（支援中文路徑自動轉換）與輸出結果
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\codex.ps1 -WorkDir "C:\離線儲存\程式設計\Aperture World" -OutFile result.txt "..."
```

### 4. Claude Code 子代理 (`claude.ps1`)

預設值就是 worker 的形狀：`plan` 權限模式（只讀不寫）、隔離脈絡、json 結果信封、900 秒逾時。

```powershell
# 執行審查與分析（只讀）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\claude.ps1 -OutFile "$env:TEMP\review.txt" "審查 src/api.ts 的邊界條件"

# 允許寫入，並且只放行它驗證自己所需的那一條指令
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\claude.ps1 -Mode acceptEdits -AllowedTools 'Bash(npm test)' "修好 src/lexer.js 的失敗測試，跑 npm test 並回報輸出"

# 續談同一個 worker（每次執行都會印出 session id）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\claude.ps1 -Resume 7b720d06-f238-413b-b98e-04f3c78bd0ad "把你剛剛提的第 2 點實作出來"
```

主要參數：

| 參數 | 作用 |
|---|---|
| `-Mode` | `plan`（預設）/ `acceptEdits` / `bypassPermissions` / `dontAsk` / `auto` / `manual`。同時接受 `read-only`、`workspace-write`、`danger-full-access`，讓 `delegate.ps1` 的 `-Sandbox` 可以原樣轉發。 |
| `-Context` | `isolated`（預設）會加上 `--safe-mode`：不載入 plugin、skill、hook、MCP 與 `CLAUDE.md`。本倉庫實測：不加約 48.7k prompt tokens，加了約 7.0k，再用 `-Tools` 收窄約 3.6k。只有 worker 真的需要專案設定時才改用 `project`。 |
| `-Tools` / `-AllowedTools` / `-DisallowedTools` | 收窄內建工具集 / 放行特定呼叫（`'Bash(npm test)'`）/ 封鎖特定呼叫。 |
| `-OutFile` / `-RawFile` | 最終回覆（UTF-8 無 BOM）／原始 json 信封（含 `session_id`、`total_cost_usd`、`permission_denials`）。 |
| `-Resume` / `-SessionId` / `-ForkSession` | 多輪委派。每次執行都會印出 session id，後續任務接續同一個 worker，不必重送整份交接。 |
| `-Model` / `-FallbackModel` / `-Effort` / `-MaxBudgetUsd` | 模型檔位、過載時的備援模型清單、推理強度、花費上限。 |
| `-AddDir` / `-AppendSystemPrompt` / `-WorkDir` | 額外可讀目錄、追加系統提示、worker 的工作目錄。 |
| `-TimeoutSec`（預設 900）/ `-DryRun` | 硬性逾時（`claude` 本身沒有 `--print-timeout`）；`-DryRun` 只印出解析後的命令列，不實際呼叫。 |

離開碼：`0` 成功、`124` 逾時（worker 已被終止）、`10` 撞到 Anthropic 額度上限。看到 `10` 就換後端或等重置，**不要**配置 API key 當備援。另外 wrapper 會擋下巢狀委派（`CLAUDE_DELEGATION_DEPTH`），除非明確傳入 `-AllowNested`。

---

## 讓各 Agent 載入 Skill

三個後端各有自己的 adapter 來源，內容都在 `skills/agent-delegation-tools/` 之下單一來源維護：

| 後端 | 來源檔 | 專案層級安裝位置 | 全域安裝位置 |
|---|---|---|---|
| Claude Code | `claude-code/SKILL.md` | `.claude/skills/agent-delegation-tools/` | `~/.claude/skills/agent-delegation-tools/` |
| Antigravity | `antigravity/SKILL.md` | `.agents/skills/agent-delegation-tools/` | `~/.agents/skills/agent-delegation-tools/` |
| Codex | `SKILL.md`（canonical） | —（Codex 只讀全域） | `~/.codex/skills/agent-delegation-tools/` |

三份 adapter 都採「絕對路徑優先」解析：先找 `C:\離線儲存\程式設計\子代理` 的 wrapper，找不到才退回該安裝自帶的 `scripts\`。所以全域安裝在任何專案裡都能用，而 wrapper 只有倉庫這一份是真正的來源。

一鍵同步全部安裝位置：

```powershell
$repo = 'C:\離線儲存\程式設計\子代理'
$src = Join-Path $repo 'skills\agent-delegation-tools'
$targets = @{
    "$env:USERPROFILE\.claude\skills\agent-delegation-tools" = "$src\claude-code\SKILL.md"
    "$env:USERPROFILE\.agents\skills\agent-delegation-tools" = "$src\antigravity\SKILL.md"
    "$env:USERPROFILE\.codex\skills\agent-delegation-tools"  = "$src\SKILL.md"
}
foreach ($t in $targets.GetEnumerator()) {
    New-Item -ItemType Directory -Force -Path (Join-Path $t.Key 'scripts') | Out-Null
    Copy-Item -LiteralPath $t.Value -Destination (Join-Path $t.Key 'SKILL.md') -Force
    # 注意：萬用字元要用 -Path，-LiteralPath 不會展開 *
    Copy-Item -Path (Join-Path $src 'scripts\*.ps1') -Destination (Join-Path $t.Key 'scripts') -Force
}
Copy-Item -LiteralPath "$src\claude-code\SKILL.md"  -Destination "$repo\.claude\skills\agent-delegation-tools\SKILL.md" -Force
Copy-Item -LiteralPath "$src\antigravity\SKILL.md"  -Destination "$repo\.agents\skills\agent-delegation-tools\SKILL.md" -Force
```

（Codex 另外需要 `agents\openai.yaml`；上面的 `~/.codex` 與 `~/.agents` 安裝已包含該檔。）

呼叫方式：

- **Claude Code**：`Skill("agent-delegation-tools", "<任務描述>")`。要不要委派、選哪個後端由使用者層級的 `agent-delegation` skill 負責，這支只管怎麼呼叫。
- **Antigravity**：「使用 agent-delegation-tools skill，將這個分析任務委派給獨立子代理 worker」
- **Codex**：`$agent-delegation-tools 把這個實作任務交給獨立子代理 worker`

---

## 核心設計與 Windows 踩坑防護

1. **中文 / 非 ASCII 路徑 Junction 修復**：
   Codex Windows 沙箱在非 ASCII 路徑下會默默掉回 `C:\` 導致相對路徑與 Git 失效。`codex.ps1` 自動建立 `%USERPROFILE%\codex-ws\<slug>` 之 ASCII Junction 映射並維護。
2. **Standard Input (stdin) 懸掛修復**：
   在 PowerShell / Agent 自動化程序中，外部 CLI 可能因等待 stdin 阻塞。`codex.ps1` 與 `agy.ps1` 導向 `$null` 輸入；`claude.ps1` 則改成把 prompt 寫成 UTF-8 暫存檔後由 stdin 餵入——stdin 一樣會關閉不會卡住，而且引號、換行與中文完全不經過 Windows 命令列解析。
3. **UTF-8 編碼與 OutFile 支援**：
   所有腳本統一使用 UTF-8 編碼寫入 `-OutFile`，避免中文輸出在 Windows 預設 CP950 下變成亂碼。
4. **選型與額度紀律**：
   - 長文本分析、大量 Scaffolding 優先使用 **AGY Flash**（每 token 最便宜、上下文最大）。
   - 多檔案複雜實作優先使用 **Codex**。
   - 一次僅運行單一外部子代理，避免無節制的並行 fan-out 或遞迴調用。
5. **Claude worker 的脈絡隔離**：
   `claude.ps1` 預設 `-Context isolated`（`--safe-mode`）。子代理不需要繼承母代理的 plugin、skill、hook、MCP 與 `CLAUDE.md`——那些每次呼叫都要重付 prompt 成本（本倉庫實測 48.7k → 7.0k tokens），而且母代理的常駐指示會一起繼承下去，可能讓 worker 做出不是你要它做的事。
6. **逾時、額度與遞迴防護**：
   `claude.ps1` 自帶硬性逾時（預設 900 秒，逾時殺掉並回傳 124）、額度上限偵測（回傳 10，提示換後端而非改用付費 API），以及 `CLAUDE_DELEGATION_DEPTH` 遞迴守衛。
