# 委派優先政策 (Delegation-first policy)

父代理是**調度員**，不是工人。實際的工作交給三個訂閱制 CLI 執行，其中兩個外部 CLI 承擔主要負載。

## 後端與預設模型

| 後端 | CLI | 預設模型 | 預設 effort |
|------|-----|----------|-------------|
| `agy` | Google Antigravity | `gemini-3.7-flash` | `high` |
| `codex` | OpenAI Codex | `gpt-5.6-luna` | `high` |
| `claude` | Anthropic Claude CLI | `claude-sonnet-5` | `high` |

除非使用者指定，一律使用上表的預設值，不要在呼叫時另外指定模型。

## 規則

1. **先委派，不要自己動手。** 多檔案實作、重構、鷹架、批次修改、整個 codebase 的閱讀、寫測試、研究掃描 → 一律走 `mcp__agent-delegation__delegate_task` / `delegate_parallel`。不要為了外部 CLI 做得到的工作去開 Claude 子代理。
2. **優先用兩個外部 CLI。** `claude` 後端花的是**和父代理同一份**訂閱額度，只省 context 不省額度，所以自動路由永遠不會選它；只有使用者明講、或 `agy` 與 `codex` 都耗盡時才會用到。
3. **額度決定路由。** `balance_quota` 預設開啟：派工前會讀三個 CLI 的即時額度（10 秒快取），耗盡的供應商自動跳過並轉移。使用者問「還剩多少額度」時用 `get_agent_quotas`。
4. **子代理本來就有權限。** `sandbox` 預設 `workspace-write`，子代理可以在 `work_dir` 底下直接讀寫檔案，沒有任何核准步驟。**不要**回頭要求使用者授權子代理讀檔或改檔；只有純分析的工作才傳 `read-only`。
5. **一定要帶 `work_dir`**（絕對路徑），子代理才會落在正確的 repo。
6. **可平行的工作用 `delegate_parallel`**，批次會在外部 CLI 之間輪流分配。

## 例外

- 使用者明確要求由 Claude 本身處理，或工作只是幾行的設定 / 本機小修改。
- 需要 Claude 特有能力（例如本 session 的互動、對話式判斷）。

---

# Agent collaboration

- Read this file and `AI_HANDOFF.md` before changing the repository.
- Inspect the current branch, status, diff, and recent commits before editing.
- Preserve uncommitted work and do not commit, push, reset, rebase, or delete branches without explicit authorization.
- Update `AI_HANDOFF.md` after meaningful code changes, failed attempts, discoveries, and verification results.
- Do not claim success without direct verification.
