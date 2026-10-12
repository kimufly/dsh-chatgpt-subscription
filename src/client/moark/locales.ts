import { accountPoolZh, accountPoolEn } from '../common/account-pool-labels.ts'

/**
 * The MoArk tab's dictionary.
 *
 * Spreads the shared pool labels first so the account card cannot drift from the
 * other tabs, then adds only what is genuinely this line's: pasting an access
 * token, choosing a protocol surface, syncing the catalogue, and the honest
 * statement of what MoArk does and does not publish.
 */
export const NS_MOARK = 'dsh-moark'

export const zh = {
  ...accountPoolZh,
  // The shared card says "账号" and offers a sign-in; this line pastes a token,
  // so the two labels that reach the user are the ones that name it.
  relogin: '重新粘贴令牌',
  needsRelogin: '令牌已失效',
  addAccount: '添加访问令牌',
  noAccounts: '暂无令牌。点击「添加访问令牌」粘贴一个模力方舟访问令牌。',

  title: 'MoArk（模力方舟）',
  pageDesc: '用模力方舟（Gitee AI）的访问令牌接入平台模型。令牌在工作台 → 设置 → 访问令牌创建；它不会过期，在控制台吊销即可作废。',
  keysUrlLabel: '创建访问令牌',
  routeOwned: '模型路由由本插件提供。',
  routeConflict: '模型路由已被其他 Provider 占用：{detail}。此时模型选择器里显示的是对方的模型，而不是本线路的；请在 DSH 设置中移除重名的 Provider 配置后重新加载。',

  keySection: '访问令牌',
  keyPlaceholder: '粘贴模力方舟访问令牌',
  keyAliasLabel: '别名（可选）',
  keyAliasPlaceholder: '例如：个人项目调用',
  keyAliasHint: '多个令牌同名时无法区分，别名只用于你自己的识别，不会发送给上游。',
  keyHint: '令牌只保存在本机（macOS 钥匙串 / Windows DPAPI / Linux Secret Service），不会写入浏览器，也不会出现在任何返回给页面的数据里。',
  keySave: '保存令牌',
  keySaving: '保存中…',
  keyCreated: '管理访问令牌',

  wireSection: '协议面',
  wireHint: '同一个模型在三条协议面上都能调用：OpenAI 兼容面（api.moark.com/v1）、Responses 面（moark.com/v1，Codex 用的那条）、Anthropic 面（moark.com/anthropic，Claude Code 用的那条）。模力方舟的模型目录不声明协议，所以这里是你选择默认面的地方。',
  wireOpenai: 'OpenAI 兼容（/v1/chat/completions）',
  wireResponses: 'Responses（/v1/responses）',
  wireAnthropic: 'Anthropic Messages（/anthropic/v1/messages）',
  wireSaved: '已切换协议面',

  modelsSection: '模型',
  modelsHint: '模型列表从模力方舟的 /v1/models 实时读取（当前有 208 个条目），只保留能对话的家族：向量、重排、图像、视频、语音、OCR 与 3D 模型不会出现在选择器里。',
  catalogSync: '同步模型列表',
  catalogSyncing: '同步中…',
  catalogNeverSynced: '还没有同步过模型列表。添加访问令牌后点「同步模型列表」。',
  catalogEmpty: '模力方舟返回了空列表。稍后重试，或检查访问令牌绑定的资源包。',
  catalogNeedKey: '同步需要一个访问令牌。',
  catalogFailed: '同步失败：{detail}',
  modelCount: '共 {count} 个模型',
  noModels: '暂无模型',
  selectAll: '全选',
  unselectAll: '全不选',
  noneSelected: '未选择任何模型',

  limitsSection: '已知边界',
  limitsHint: '以下是模力方舟平台本身的事实，不是本插件的取舍；写在这里是为了让你不必自己踩一遍。',
  limitNoQuota: '模力方舟没有公开的余额 / 配额查询接口（/v1/models 之外的候选路径都返回 404），所以这里不显示「剩余额度」——只统计本机实际消耗的 token。',
  limitPrepaid: '平台是预付费资源包制：全模型资源包或厂商算力资源包用完即止，额度用尽时上游返回 402，本插件会照实报出而不是当成限流。',
  limitNoFallback: '本插件不内置模型兜底表：模力方舟的模型集合变化快，硬编码的名字会变成一个能选中却调用失败的模型。首次使用请先同步。',
  limitVision: '模型目录不声明模态，所以「支持图片」是按家族名保守声明的：没列出的家族一律按纯文本处理，不会静默丢掉你的截图。',
  limitShared: '一个令牌可被多个客户端共用，但平台按令牌限流；本插件把 429 视为该令牌的冷却并自动切到下一个。',

  error: '操作失败：{detail}',

  usageTitle: '本机消耗',
  usageInput: '输入 {tokens} tokens',
  usageOutput: '输出 {tokens} tokens',
  usageRequests: '调用 {count} 次',
  usageNone: '尚无调用记录',
  usageHint: '这些数字来自模力方舟每次响应自己返回的 token 计数，只统计本机发出的请求；它们不是剩余额度。',

  lastModel: '上次模型',
}

export const en: Record<keyof typeof zh, string> = {
  ...accountPoolEn,
  relogin: 'Paste a token again',
  needsRelogin: 'Token rejected',
  addAccount: 'Add access token',
  noAccounts: 'No token yet. Click "Add access token" to paste a MoArk access token.',

  title: 'MoArk',
  pageDesc: 'Access MoArk (Gitee AI) models with an access token. Create one under Console → Settings → Access Tokens; it does not expire, and revoking it in the console invalidates it.',
  keysUrlLabel: 'Create an access token',
  routeOwned: 'This plugin serves the model route.',
  routeConflict: 'Another provider already owns the model route: {detail}. The model picker is showing that provider\u2019s models, not this line\u2019s — remove the duplicate provider configuration in DSH settings and reload.',

  keySection: 'Access token',
  keyPlaceholder: 'Paste your MoArk access token',
  keyAliasLabel: 'Alias (optional)',
  keyAliasPlaceholder: 'e.g. personal-project',
  keyAliasHint: 'Several tokens are otherwise indistinguishable; the alias is only for your own reference and is never sent upstream.',
  keyHint: 'The token is stored only on this machine (macOS Keychain / Windows DPAPI / Linux Secret Service). It never reaches the browser and appears in no data returned to the page.',
  keySave: 'Save token',
  keySaving: 'Saving…',
  keyCreated: 'Manage access tokens',

  wireSection: 'Protocol surface',
  wireHint: 'One model can be called over any of three surfaces: the OpenAI-compatible one (api.moark.com/v1), the Responses one (moark.com/v1, what Codex uses), and the Anthropic Messages one (moark.com/anthropic, what Claude Code uses). MoArk\u2019s catalogue declares no protocol, so this is where you pick the default.',
  wireOpenai: 'OpenAI-compatible (/v1/chat/completions)',
  wireResponses: 'Responses (/v1/responses)',
  wireAnthropic: 'Anthropic Messages (/anthropic/v1/messages)',
  wireSaved: 'Surface switched',

  modelsSection: 'Models',
  modelsHint: 'The list is read live from MoArk\u2019s /v1/models (208 entries today) and keeps only conversational families: embeddings, rerankers, image, video, speech, OCR and 3D models never reach the picker.',
  catalogSync: 'Sync models',
  catalogSyncing: 'Syncing…',
  catalogNeverSynced: 'The model list has never been synced. Add an access token, then click "Sync models".',
  catalogEmpty: 'MoArk returned an empty list. Retry later, or check the resource pack bound to this token.',
  catalogNeedKey: 'Syncing needs an access token.',
  catalogFailed: 'Sync failed: {detail}',
  modelCount: '{count} models',
  noModels: 'No models',
  selectAll: 'Select all',
  unselectAll: 'Clear all',
  noneSelected: 'No model selected',

  limitsSection: 'Known boundaries',
  limitsHint: 'These are facts about the MoArk platform itself, not choices this plugin made; they are written down so you do not have to discover them the hard way.',
  limitNoQuota: 'MoArk publishes no balance or quota endpoint (every plausible path besides /v1/models answers 404), so no "remaining" figure is shown — only the tokens this machine actually spent.',
  limitPrepaid: 'The platform is prepaid: a 全模型资源包 or a vendor 算力资源包 runs out and stops. An exhausted pack answers 402 upstream, which this plugin reports as itself rather than as a rate limit.',
  limitNoFallback: 'There is no built-in fallback model table: MoArk\u2019s model set moves quickly, and a hard-coded name becomes a model you can select and then fail on. Sync once before first use.',
  limitVision: 'The catalogue declares no modalities, so image support is a conservative per-family claim: families not on the list are treated as text-only, and your screenshot is never silently dropped.',
  limitShared: 'One token can be shared by several clients, but the platform rate-limits per token; this plugin treats a 429 as that token\u2019s cooldown and rotates to the next one.',

  error: 'Failed: {detail}',

  usageTitle: 'Local spend',
  usageInput: '{tokens} input tokens',
  usageOutput: '{tokens} output tokens',
  usageRequests: '{count} requests',
  usageNone: 'No calls recorded yet',
  usageHint: 'These numbers come from the token counts MoArk returns on each response and cover requests from this machine only; they are not a remaining balance.',

  lastModel: 'Last model',
}

export const dictionaries = { zh, 'zh-CN': zh, en, 'en-US': en }

export type MoarkLocaleKey = keyof typeof zh
