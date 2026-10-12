/**
 * Wire contracts for the MoArk (模力方舟 / Gitee AI) line's settings API.
 *
 * Boundary discipline matches `account-pool-contracts.ts` and
 * `ollama-contracts.ts`: everything declared here is public information the
 * settings card renders. The access token is host-only and appears in no type
 * below — not in a request body type, not in a status payload, not in an error.
 *
 * MoArk is a **token + prepaid resource-pack** platform rather than a
 * subscription service: a user registers at moark.com, creates an access token
 * under 工作台 → 设置 → 访问令牌, optionally buys a 全模型资源包, and calls the
 * API with `Authorization: Bearer <token>`. The token does not expire and is
 * revoked from the console, so there is no refresh and, like the Ollama line,
 * no plan/expiry field here to invent.
 *
 * MoArk publishes **no** account balance or quota endpoint in its public
 * documentation, and probing the plausible paths returns 404 (see
 * `docs/moark-line-plan.md` §3.4). So no quota DTO exists on this boundary
 * either: a card that drew a "remaining" bar from an invented endpoint would
 * claim something the upstream cannot support. What the line *can* count is
 * spend — the per-response token numbers the service itself returns — and that
 * is what `MoarkUsageDto` carries.
 */

import type {
  AccountPoolStatusDto,
  PoolAccountSummaryDto,
} from './account-pool-contracts.ts'

/** Line id. Distinct from any user-made `moark`-named compatibility route. */
export const MOARK_PROVIDER_ID = 'moark'

/** Display name on the settings card and the hub card. */
export const MOARK_PROVIDER_NAME = 'MoArk（模力方舟）'

/**
 * Route prefix (host exposes, client consumes).
 *
 * Consistent with every other line here: a line hangs its own settings surface
 * off `/<line>/api` rather than nesting under the Codex line's
 * `/api/dsh-chatgpt-subscription`.
 */
export const MOARK_ROUTE_PREFIX = '/moark/api'

/**
 * Which of MoArk's three protocol surfaces serves a request.
 *
 * MoArk documents all three against the same model catalogue:
 *
 * - `openai`    — `https://api.moark.com/v1/chat/completions`, the platform's
 *                 primary documented path and the one its own OpenAI-client
 *                 examples use;
 * - `responses` — `https://moark.com/v1/responses`, what MoArk's official Codex
 *                 configuration page points `wire_api = "responses"` at;
 * - `anthropic` — `https://moark.com/anthropic/v1/messages`, what MoArk's
 *                 official Claude Code configuration page sets
 *                 `ANTHROPIC_BASE_URL` to.
 *
 * The surfaces are chosen per request, not per line: the three are
 * interchangeable from the caller's side because they return the same assistant
 * message and accept the same tool definitions, and different surfaces have
 * different strengths for different models, so the choice is a setting rather
 * than a structural fork of the line.
 */
export type MoarkWire = 'openai' | 'responses' | 'anthropic'

/** What one pooled token has consumed, counted locally from the service's own per-response token numbers. */
export interface MoarkUsageDto {
  inputTokens: number
  outputTokens: number
  requestCount: number
  /** Unix milliseconds the last completed turn was counted. */
  lastCountedAt?: number
}

/** One account as the MoArk card renders it. Never carries the token. */
export interface MoarkAccountSummaryDto extends PoolAccountSummaryDto {
  /** Model id this account last served, when the adapter recorded one. */
  lastModelId?: string
  usage?: MoarkUsageDto
}

/** The whole pool slice the card needs. */
export interface MoarkPoolStatusDto {
  accounts: MoarkAccountSummaryDto[]
  activeAccountId?: string
  rotationStrategy: AccountPoolStatusDto['rotationStrategy']
}

/** One catalogue row as the settings card lists it. */
export interface MoarkCatalogEntryDto {
  id: string
  name?: string
  /** The surface this model was declared to speak; absent means the line default. */
  wire?: MoarkWire
  contextWindow?: number
}

/** Everything the settings card renders for the MoArk tab. */
export interface MoarkWebStatus {
  pool: MoarkPoolStatusDto
  /** Model ids synced from the service's own `/v1/models`, chat-capable families only. */
  models: MoarkCatalogEntryDto[]
  /**
   * Which of them the user has switched on: null is 'no filter', i.e. every
   * model in the list — modelling 'all' this way rather than as an explicit
   * all-ids list means a model the service adds later is not silently hidden
   * by a selection made before it existed. An array is an explicit selection,
   * and an empty one switches every model off.
   */
  enabledModelIds: string[] | null
  /** Surface used for a model whose catalogue row declares none. */
  defaultWire: MoarkWire
  /** True when at least one account can currently serve a request. */
  usable: boolean
  /**
   * Whether THIS plugin currently owns the `moark` provider route.
   *
   * A route is claimed through `llm.registerAdapter`, and registration is
   * all-or-nothing: if another adapter already serves `moark` — a hand-configured
   * provider in DSH settings that happens to use the same id is the usual rival —
   * the claim is refused. The settings card still works, because its routes are
   * independent of the claim, but the model picker would then keep showing *that*
   * adapter's models and none of ours — which is indistinguishable from "the line
   * is broken" unless it is stated. Every other line here reports this; so does
   * this one.
   */
  serving: boolean
  /** Why the route is served by another adapter, or null while this plugin owns it. */
  conflict: string | null
  // Distinct from an empty models list: 'never synced' and 'synced, the
  // service returned nothing' are different states, and the card words them
  // differently.
  catalogSynced: boolean
  /** Where a user creates an access token. Rendered as the card's key link. */
  keyUrl: string
}

/** Actions the accounts endpoint accepts. */
export type MoarkAccountAction =
  | 'add'
  | 'set-primary'
  | 'set-alias'
  | 'delete'
  | 'clear-cooldown'
  | 'strategy'

/**
 * The surfaces a settings update may select.
 *
 * Exported as a runtime list as well as a type because the card renders one
 * radio per entry and the host validates the incoming value against it — a
 * single source means the two cannot drift.
 */
export const MOARK_WIRES: readonly MoarkWire[] = Object.freeze(['openai', 'responses', 'anthropic'])

/** Whether a value from the wire is one of the surfaces this line speaks. */
export function isMoarkWire(value: unknown): value is MoarkWire {
  return typeof value === 'string' && (MOARK_WIRES as readonly string[]).includes(value)
}
