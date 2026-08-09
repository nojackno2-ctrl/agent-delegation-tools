# 子代理

把外部 agent CLI 接成 Claude Code 子代理的工具與筆記。

## 三個後端

| 後端 | 呼叫方式 | 模型 | 額度 |
|---|---|---|---|
| Claude 子代理 | Claude Code 內建 Agent 工具 | sonnet / opus | 不燒外部額度 |
| Codex | `codex.ps1`（本資料夾） | 依 `~/.codex/config.toml`，可用 `-Model` 覆蓋 | ChatGPT |
| Antigravity | `agy -p "<task>" --model <m>` | Gemini 3.6/3.5 Flash、3.1 Pro、Claude 4.6、GPT-OSS 120B | Google |

安裝位置（都不需要另外設定 PATH 以外的東西）：

- `codex.exe` — `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`，hash 每次更新會變，`codex.ps1` 會自己找
- `agy.exe` — `%LOCALAPPDATA%\agy\bin\agy.exe`（v1.1.11），已在 PATH 上。模型清單用 `agy models` 查，會隨版本變
- `cc-antigravity-plugin` — Claude Code plugin，user scope，提供 `/cc-antigravity-plugin:antigravity` 與 `antigravity-coder` / `antigravity-agent` 兩個子代理

## codex.ps1

```powershell
# 對當前目錄的專案
.\codex.ps1 "把 app/world.mjs 的 X 重構成 Y"

# 指定專案
.\codex.ps1 -WorkDir "C:\離線儲存\程式設計\Aperture World" "..."

# 純分析，不讓它動檔案
.\codex.ps1 -Sandbox read-only "說明 app/scene3d.mjs 怎麼組場景"
```

其他旗標：`-Model`、`-Effort`、`-OutFile <path>`、`-Json`、`-SkipGitCheck`、`-NoAliasPath`。

`-Effort` 接 `low`/`medium`/`high`/`xhigh`/`ultra`/`max`，省略則用 `~/.codex/config.toml` 的 `model_reasoning_effort`。Codex 沒有這個旗標，腳本轉成 `-c model_reasoning_effort=...`。

`-OutFile` 只寫最終回覆（不含 transcript）。讀它要指定編碼，否則中文變亂碼：

```powershell
Get-Content result.txt -Encoding UTF8
```

## 為什麼需要這支 wrapper

### 1. 中文路徑會讓 Codex 沙箱失效

這是踩到最久的一個。Codex 的 Windows 沙箱**設不進含非 ASCII 字元的工作目錄** —— 它不會報錯，而是讓 spawn 出來的 shell 默默掉到 `C:\`。後果：

- 所有相對路徑失效
- `Set-Location` 進專案目錄被拒（Access is denied），連 `\\?\` 延伸路徑也一樣
- `git` 直接回報 `fatal: not a git repository`

因為 `C:\離線儲存\程式設計\` 整條路徑都有中文，這裡每個專案都會中。實測差異（同樣是建一個一行的檔案）：

| | 修正前 | 修正後 |
|---|---|---|
| tool 呼叫 | 4–5 次（一直在猜路徑） | 1 次 |
| `git` | 不可用 | 正常 |
| tokens | 42k | 9k |

解法是給 Codex 一條純 ASCII 的 junction：`%USERPROFILE%\codex-ws\<slug>` → 真實專案目錄。同一批檔案，不是複本；`codex.ps1` 偵測到非 ASCII 路徑時自動建立與維護（指向錯的舊 junction 會自動重指）。

### 2. 沙箱預設值太寬

`~/.codex/config.toml` 目前是 `approval_policy = "never"` + `sandbox_mode = "danger-full-access"`，也就是不經任何確認直接改檔案跑指令。`codex.ps1` 預設改成 `workspace-write`，要放寬得自己明確指定。

## 選型準則

- **預設用 Claude 子代理** —— 不燒外部額度，transcript 看得到，權限機制照常生效
- **Codex** —— 多檔實作、重構，需要獨立的強實作者時
- **AGY Flash** —— 長上下文閱讀、大量 scaffolding，每 token 最便宜、上下文最大

額度紀律（`codex` 和 `agy` **都沒有查剩餘額度的指令**，只能靠選型而不是查表）：

- 夠用的最便宜檔位優先：Flash 先於 Pro，Low 先於 High，sonnet 先於 opus
- 一次跑一個外部 agent，不並行 fan-out
- 撞到 quota / auth 錯誤就換後端，不原地重試

## 已知雜訊

- `Reading additional input from stdin...` —— stdin 被導向 null 造成的，無害
- `cc-antigravity-plugin` 有個 SessionStart hook 會注入「所有檔案工作一律交給 AGY」的常駐指示。要關掉：

  ```powershell
  claude plugin configure cc-antigravity-plugin@cc-antigravity-plugin --config coding_policy=off
  ```
