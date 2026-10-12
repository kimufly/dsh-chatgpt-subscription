# MoArk（模力方舟）线路实施计划

- **目标线路**：`moark` / 显示名「MoArk（模力方舟）」
- **起点**：本分支 `master` @ `d2d7da6`（上游 0.21.0），工作区含本线路的新增文件
- **状态**：**已实现并验证**（typecheck / 全量测试 / 构建 / 打包门禁全绿，除 4 个与改动无关的 macOS 环境失败）。本文记录实现所依据的证据与边界，以便复核与后续维护。
- **上游仓库**：`Aa728848/dsh-chatgpt-subscription`（MIT），本仓为 fork（`kimufly/dsh-chatgpt-subscription`）

---

## 1. 目标、成功标准与非目标

### 目标

新增第十条线路，把模力方舟按**访问令牌 + 预付费资源包**接入 DSH，并支持平台自己提供的**三张协议面**。

### 成功标准

- 用户在设置页粘贴一个访问令牌即可使用，无需 OAuth、无需改配置文件。
- 三张协议面（OpenAI 兼容 / Responses / Anthropic Messages）**都实现**，并可在设置页选择默认面。
- 模型目录**实时**取自 `/v1/models`，且只保留能对话的家族。
- 卡片形态与其余线路一致：hub 卡片 → 账号池 + 模型勾选 + 已知边界说明。
- 明确**不宣称**上游没有的东西（尤其是不画「剩余额度」）。

### 非目标

- **不做 OAuth2 授权码登录**。模力方舟的 OAuth2 是「第三方应用代表用户调用」的机制：需要先在平台创建第三方应用并拿到 `client_id` / `client_secret`，且 `redirect_uri` 必须与平台登记完全一致。那需要每个用户自己注册一个应用，与「订阅式一键登录」不是同一回事；本线路选择粘贴访问令牌。
- **不做配额 / 余额卡片**：平台没有公开接口（见 §3.4）。
- 不改动其它线路的文件（含上游 Ollama 线路的既有缺陷，只记录不修改，见 §5）。

---

## 2. 证据分级

沿用 `docs/plan-provider-agent-optimizations.md` 的口径：

| 等级 | 定义 | 实施规则 |
|---|---|---|
| **A** | 上游官方文档 / 实测端点可证明 | 直接实现 |
| **B** | 第三方材料或间接推断 | 实现但保守取值 |
| **C** | 无实测的猜测 | **不实现**；宁缺勿造 |

本线路的关键事实里，**没有任何 C 级进入默认路径**：凡是无法证明的（模型协议、模态、配额），一律不做声明，或降级为「用户可选 / 显式说明」。

---

## 3. 关键上游事实

### 3.1 形态：预付费资源包 + 访问令牌（等级 A）

逐字来源：`moark.com/docs/billing/purchase`、`moark.com/docs/billing/intro`、`moark.com/docs/account/access-token`。

- 访问令牌在 **工作台 → 设置 → 访问令牌** 创建，分「通用令牌」与「应用令牌」；通用令牌用于绑定 Serverless API 等调用资源。
- 令牌可**精细化绑定资源包**（全选 或 只勾选某些资源包）。
- 资源包分**全模型资源包**（覆盖全部模型，自动选算力）与**厂商算力资源包**（如沐曦、天数智芯，仅对应厂商算力，需手动绑定令牌）。
- 计费为**预付费**：包「用完或到期」即止。

**推论（等级 A 的直读）**：这不是「订阅账号」，所以没有 OAuth 登录态、没有 refresh_token、也没有可 `adopt` 的本机凭据。线路形状因此与 `ollama` 同构（静态凭据 + 号池 + 模型勾选），而不是与 `claude` / `chatgpt` 同构。

### 3.2 三张协议面（等级 A：官方文档逐字）

| 面 | 端点 | 官方依据 |
|---|---|---|
| OpenAI 兼容 | `https://api.moark.com/v1/chat/completions` | `docs/products/apis/texts/text-generation` 首例 curl 与 OpenAI 客户端示例 |
| Responses | `https://moark.com/v1/responses` | `docs/integrations/Development-Tools/Codex`：`wire_api = "responses"`、`base_url = "https://moark.com/v1"`、`experimental_bearer_token` |
| Anthropic Messages | `https://moark.com/anthropic/v1/messages` | `docs/integrations/Development-Tools/claude_code`：`ANTHROPIC_BASE_URL = "https://moark.com/anthropic"` |

**独立复核**：对三个路径发无鉴权 `GET`，均返回 **405（方法不允许）而非 404**，即路径真实存在、只是不接受 GET。这是本线路对「端点存在」的实测证据。

Anthropic 面的鉴权：官方页只写了 `ANTHROPIC_AUTH_TOKEN`（Claude Code 以 Bearer 发送）。GLM 线路的实施计划另记录「Anthropic 兼容网关会同时读取 `x-api-key` 与 `Bearer Authorization`」。为兼容两种读法，本线路**同时发送两个头（同值）**，与 GLM 线路一致。**等级 A（官方页）+ B（网关读头行为）**，两者都不构成风险面：值本来就是手里的令牌。

### 3.3 模型目录（等级 A：实测）

- `GET https://api.moark.com/v1/models` → **HTTP 200，208 条**，envelope `{object, data:[{id, object, created}]}`，**无需鉴权**。
- 三个 host（`api.moark.com`、`moark.com`、`moark.com/anthropic`）的 `/v1/models` 返回**同一份列表**。
- 条目里**只有 `id` / `object` / `created`**：没有模态、没有上下文窗口、**没有协议**。

因此：

1. 目录要**过滤**——208 条里包含向量、重排、图像、视频、语音、OCR、3D，放进选择器等于制造失败选项。
2. **不能逐模型声明协议**（没有可转录的事实），改由用户选择线路级默认面。
3. **不内置兜底表**：任何硬编码名字都是对「某资源包 entitle 了什么」的猜测。

### 3.4 配额：平台没有公开接口（等级 A：实测 + 文档核对）

文档中「用量统计 / 账户余额」只存在于**工作台页面**，没有对应的开放接口。实测候选路径全部 404：

| 路径 | 结果 |
|---|---|
| `GET /api/open/v1/tokens` | 404 |
| `GET /api/open/v1/apikeys` | 404 |
| `GET /api/v1/user/balance` | 404 |
| `GET /api.moark.com/v1/dashboard/billing/credit_grants` | 404 |
| `GET /api/open/v1/userinfo` | 401（**存在**，但需 OAuth 令牌，见 §3.5） |

**结论**：本线路**不实现配额卡片**。用一个不存在的端点画进度条，是在宣称上游无法支持的事实。能给出的只有**本机消耗**（每次响应自带 `usage`）。

### 3.5 OAuth2 存在，但不适用于本线路的登录（等级 A）

`docs/integrations/oauth2` 与 `docs/oauth` 记录了一套标准授权码流程：

- 授权：`GET https://moark.com/oauth/authorize?response_type=code&client_id=…&redirect_uri=…&scope=user_info api_key&state=…`
- 令牌：`POST https://moark.com/api/open/oauth/token`（支持 Basic 或 body 传 client 凭据），返回 `access_token` / `refresh_token` / `expires_in`。
- 用户信息：`GET https://moark.com/api/open/v1/userinfo`。
- 进阶：授权后可用 OAuth `access_token` 列出用户可访问的令牌（`/api/open/v1/{namespace}/tokens`），再取详情换**短期 `proxy_access_token`**（约 1800s，用于代表用户调用）。

**为什么不采用**：整套流程的前置条件是**已创建第三方应用并持有 `client_id` / `client_secret`**，且 `redirect_uri` 必须与登记值严格一致。对一个本地插件而言，这要求每个用户先去平台注册一个应用——比粘贴一个访问令牌重得多，而收益（免粘贴）与成本不成比例。**记为后续可选增强，不在本轮范围内。**

### 3.6 402 的语义（等级 B）

预付费平台的经典语义是「额度用尽 → 402 Payment Required」。文档没有逐字写状态码，但「资源包用完或到期」是明文事实，402 是其标准表达。实现上把 402 单独映射为 `QUOTA_EXCEEDED`（**既不是凭据失败，也不是限流**），并在文案里给出「买/续费资源包，或换令牌」。**若某部署实际用 403 + 文案表达额度耗尽，会走 `INVALID_CREDENTIAL` 分支并在消息里带上上游原文**——文案保留原文正是为了这种情况可诊断。

---

## 4. 决策记录

| # | 决策 | 取值 | 理由 |
|---|---|---|---|
| D1 | provider id / 显示名 | `moark` / 「MoArk（模力方舟）」 | 与用户可能的自建兼容路由区分；中文括号是其它线路的既有风格 |
| D2 | 鉴权方式 | **粘贴访问令牌** | §3.5；与 `ollama` 同构，无 OAuth / 无 refresh |
| D3 | 协议面 | **三面全实现，线路级默认 + 目录行可覆盖** | §3.2、§3.3；没有逐模型协议可转录 |
| D4 | 模型目录 | **实时 `/v1/models`，拒绝名单过滤，无兜底表** | §3.3 |
| D5 | 配额卡片 | **不做**；只显示本机消耗 | §3.4 |
| D6 | 视觉声明 | 按家族名**保守白名单**；未列出则按纯文本并**在对话中说明** | 静默丢弃图片是最坏的错 |
| D7 | 思考控制 | 仅对声明支持的家族发送；无法表达的取值**丢弃而非降级** | 三个面词汇不同 |
| D8 | 402 | 单独映射 `QUOTA_EXCEEDED` | §3.6 |
| D9 | 冷却时长 | 15 分钟（`POOL_COOLDOWN_MS`） | 预付费包的「429」是真实限流/耗尽，短退避无意义；与 Ollama 同值 |
| D10 | 上下文窗口默认 | `128_000` | 目录不声明；官方 Codex 页对 `DeepSeek-V4-Pro` 配了 1,000,000，但那是**一个模型**的推荐值，不是全平台地板。取保守值：偏小只是多一次压缩，偏大则溢出丢轮次 |

---

## 5. 实现期间发现的上游缺陷（只记录，未修改）

**Ollama 线路的「调度策略」选择器不可用。**

- `src/host/ollama/routes.ts`：`accounts` 分支里，`else if (accountId === undefined) return 400 'accountId is required.'` 排在 `action === 'strategy'` 分支**之前**。
- `src/client/ollama/OllamaSection.tsx` 的 `onSetStrategy` 调用 `API.accountAction('strategy', { strategy })`，**不带** `accountId`。
- 结果：选任何策略都返回 `accountId is required.`，策略永远无法落盘。
- `test/ollama-routes.test.ts` **没有覆盖** `strategy` 动作（`grep -n strategy` 无命中），所以这个缺陷一直没被发现。

MoArk 线路把 `strategy` 分支**提前到 `accountId` 判断之前**，并在 `test/moark-routes.test.ts` 加了回归测试。**本分支未修改上游 Ollama 的文件**，以免把一条新增线路的改动与一条既有缺陷的修复混在一起；建议单独提交一个一行的重排修复（连同它的回归测试）。

---

## 6. 交付物清单

**host**（`src/host/moark/`）

| 文件 | 职责 |
|---|---|
| `types.ts` | 端点常量、三面 header 构造、目录/视觉/思考的家族判定、超时与冷却常量 |
| `wire.ts` | 与协议面无关的 IR（`MoarkRequest` / `MoarkStreamEvent` / `MoarkCallResult` …） |
| `sse.ts` | 三面共用的 SSE 帧读取（**按字节 pulse 活动**、`[DONE]` 视作控制帧） |
| `openai.ts` | `/v1/chat/completions`：请求体渲染 + chunk 解析（含 `tool_calls` 分片累积） |
| `responses.ts` | `/v1/responses`：`input` 条目化 + 事件词汇映射（终态参数**替换**而非追加） |
| `anthropic.ts` | `/v1/messages`：`system` 提升、`tool_result` 归并到单个 user turn、`input_json_delta` 累积 |
| `catalog.ts` | `loadCatalog` → `{models, failure?, status?}`，**失败是结果不是异常** |
| `mapper.ts` | IR → DSH block 协议（文本 / 思考 / 工具块的开闭与终态 finish） |
| `token-store.ts` | 凭据与模型设置（三态选择 + `defaultWire`），系统凭据库后端矩阵 |
| `account-pool.ts` | `AccountPoolCore` 封装：静态令牌、无过期、无 adopt |
| `adapter.ts` | `LlmAdapter`：目录、能力、**按面分发**、号池轮转、错误码映射（含 402） |
| `routes.ts` | `/moark/api` 下的设置面 |

**shared / client**

- `src/shared/moark-contracts.ts`：provider id / 名 / 路由前缀 / `MoarkWire` + 守卫 / DTO（**无凭据**）
- `src/client/moark/{api.ts, locales.ts, MoarkSection.tsx}`

**注册点（缺一不可）**

- `src/host/common/model-request-control.ts` — `CONTROLLED_PROVIDERS` 追加 `moark`（否则 `modelFetch.moark` 为 `undefined`）
- `src/host/common/request-diagnostics.ts` — `DIAGNOSTIC_PROVIDERS` 追加 `moark`
- `src/index.ts` — import、store/pool/adapter 构造、`claimProviderRoute`、`registerMoarkRoutes`、`HubSummarySource`、dispose 配对
- `src/client/index.tsx` — 字典注册 + `LocaleNamespaceMap`
- `src/client/hub/providers.tsx` — `HUB_PROVIDERS` 一条
- `src/client/hub/brand-icons.tsx` — `HubProviderId` 联合 + `PROVIDER_BRANDS` 一行

> **未加入 `capabilities.ts` 的 `TABLE`**：该表是「有证据的能力矩阵」，而 MoArk 无逐模型协议/模态证据。GLM 线路同样是「在表外」的先例，且 `test/capabilities.test.ts` 断言的是表内 8 条精确集合——因此**不动该表**是正确做法，不是遗漏。

**测试**：`test/moark-{catalog,surfaces,projection,routes,section}.test.ts(x)`，共 74 例。

---

## 7. 验证记录

环境：macOS，Node v26.1.0，npm 11.13.0。

| 门禁 | 结果 |
|---|---|
| `npx tsc -b --force` | **0 error** |
| `npx tsc -p test/tsconfig.json` | **0 error** |
| `npm test` | **3559 passed / 4 failed / 13 skipped**（221 文件） |
| `npm run build`（`rm -rf lib` 后） | **OK**，`lib/index.js` 2.30 MB、`lib/client.js` 600 KB |
| `npm pack --dry-run` | **OK**，512 files |

**4 个失败与本改动无关，基线即存在**（改动前同一台机器复现同样 2 个文件 / 4 个用例）：

- `test/token-store-linux.test.ts`（3）——要求 `process.platform === 'linux'`，macOS 上必然失败；
- `test/claude-oauth.test.ts`（1）——`bind EADDRNOTAVAIL 127.0.0.2`，需要 macOS loopback 别名。

测试总数由基线的 3501 增至 3576（+75）：新增 74 例，另 1 例来自 `test/model-request-control.test.ts` 的 `it.each(CONTROLLED_PROVIDERS)`——把 `moark` 加进 `CONTROLLED_PROVIDERS` 后该参数化用例自动覆盖了它。

### 实现期间由测试与独立复核捕获并修复的四个真实缺陷

1. **Responses 面工具参数被重复拼接**（`responses.ts`）：`response.output_item.done` 携带的是**完整** `arguments`，而增量帧已把片段累积过；原先按「追加」处理，导致任何有增量帧的调用参数翻倍（`{"p":"a"}{"p":"a"}`）。修正为终态值**替换**累积值（仅在从未收到增量时起兜底作用）。
2. **Responses 面正文被重复输出**（`responses.ts`）：标准 Responses 流会在 `response.output_text.delta` 之后，再为同一个 message item 发 `response.output_item.done`，而那个终态条目携带**完整正文**。原实现无条件采纳它，**每段回答都会显示两遍**；原注释声称「仅在无增量时采纳」，但代码里并没有这个判断。现已按 `sawTextDelta` 真正加门：增量到过就不再采纳终态文本，增量没到过（网关缓冲的情形）才采纳。仓库自身的 `responses-client.ts` 的 `adoptText` 早就是这个做法，此处对齐它，并补了两条回归测试（有增量 / 无增量）。
3. **Anthropic 面输入 token 计数被清零**（`anthropic.ts`）：Anthropic 把用量**拆在两个事件**里——`message_start` 给 `input_tokens`，`message_delta` 通常**只给 `output_tokens`**。适配器取「最后一个 usage 事件」，而原实现把缺失的输入计数写成 `0`，于是每轮记账的输入侧永远是 0。现改为**跨帧携带** `input_tokens`（`message_delta` 未给就沿用 `message_start` 的值）。原测试把 `{inputTokens: 0, outputTokens: 9}` 当成期望值，属于「把错误固化进测试」，已一并改正。
4. **`stop_reason: 'tool_use'` 未归一**（`anthropic.ts`）：Anthropic 的 `tool_use` 与另两面的 `tool_calls` 是同一个终态，现统一归一。当前映射器只依据「是否出现过工具调用」决定 finish（因此这个字段此前是惰性的），但归一后任何将来读取该字段的消费者看到的是同一套词汇。

> 第 1、3 条由测试暴露（第 3 条我最初还把错误值写进了断言）；第 2 条由一次独立只读复核发现——**它当时没有被任何测试覆盖**，因为既有用例只走了 `function_call` 分支。这几条都不是编译期能发现的问题，也正是「实现完必须用测试钉住行为」的理由。

---

## 8. 后续可做（未做）

- **OAuth2 授权码登录**（§3.5）：需要用户自建第三方应用，作为可选增强。
- **配额卡片**：若平台日后开放余额/资源包接口，再接。
- **拒绝名单收窄**：把 `ACE-Step` / `comfyui` / `Real-ESRGAN` / `RMBG-2.0` / `sam3` / `ViduQ*` 等无家族标记的非对话 id 纳入，需要**按实测证据**扩表，而不是按名字猜。
