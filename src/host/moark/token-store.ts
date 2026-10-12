import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DEFAULT_WIRE, PROVIDER_ID } from './types.ts'
import type { CredentialStore } from '../token-store.ts'
import { WindowsDpapiCredentialStore } from '../token-store-windows.ts'
import { MacKeychainCredentialStore } from '../token-store-macos.ts'
import { SecretServiceCredentialStore } from '../credential-store-secret-service.ts'
import { dshHomeDir } from '../common/home.ts'
import { isMoarkWire, type MoarkWire } from '../../shared/moark-contracts.ts'
import type { MoarkCatalogModel } from './types.ts'

/**
 * One stored MoArk credential.
 *
 * MoArk (模力方舟 / Gitee AI) authenticates with a static access token created in
 * the console under 工作台 → 设置 → 访问令牌, not with the rotating OAuth pair the
 * subscription lines in this plugin store. The token does not expire and is
 * revoked from that same console page, so there is no refresh token, nothing to
 * renew, and — matching the Ollama line, which is the other token-based line
 * here — no sign-in to adopt from another client's credential file: this plugin
 * is always the one that created the credential, and a pool account is "a token
 * a user pasted" rather than "a session this plugin established".
 *
 * The token is host-only and never crosses to a browser; a settings card renders
 * the alias and the account status, never this value. It is also never logged,
 * and no error message above this layer is allowed to quote it.
 */
export interface MoarkCredentials {
  /** Bearer token from 工作台 → 设置 → 访问令牌. Host-only. */
  apiKey: string
  /** User-chosen label so several tokens are distinguishable. */
  alias?: string
  /** Unix milliseconds the token was added to the pool. */
  addedAt?: number
}

export interface MoarkModelSettings {
  enabled: boolean
  /**
   * The user's model filter: null is "no filter" — every catalogued model,
   * including ones a later sync adds. An array is an explicit selection, and
   * an empty one switches every model off.
   */
  enabledModelIds: string[] | null
  catalogModels: MoarkCatalogModel[]
  defaultReasoningEffort: string | null
  /**
   * Which of MoArk's three protocol surfaces serves a model that declares none.
   *
   * A line-level setting rather than a per-model fact because MoArk's own
   * `/v1/models` states nothing but an id — no wire, no modalities, no context
   * window — so there is no per-model value to transcribe. See `types.ts`.
   */
  defaultWire: MoarkWire
}

export interface MoarkPreferenceStore {
  status(): MoarkModelSettings
  update(patch: {
    enabled?: boolean
    enabledModelIds?: string[] | null
    defaultReasoningEffort?: string | null
    defaultWire?: MoarkWire
  }): Promise<MoarkModelSettings>
}

export function credentialPath(): string {
  return path.join(dshHomeDir(), 'storages', 'moark-credentials.json')
}

export function modelSettingsPath(): string {
  return path.join(dshHomeDir(), 'storages', 'moark-models.json')
}

/** Stable keyring account name for one credential file. */
function credentialAccount(filePath: string): string {
  return createHash('sha256').update(path.resolve(filePath)).digest('hex')
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('MoArk credential payload is invalid')
  return value
}

export function parseMoarkCredentials(value: unknown): MoarkCredentials {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('MoArk credential payload is invalid')
  }
  const record = value as Record<string, unknown>
  const apiKey = record.apiKey
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('MoArk credential is missing its access token')
  }
  const credentials: MoarkCredentials = { apiKey }
  const alias = optionalString(record, 'alias')
  if (alias !== undefined) credentials.alias = alias
  const addedAt = record.addedAt
  if (typeof addedAt === 'number' && Number.isFinite(addedAt)) credentials.addedAt = addedAt
  return credentials
}

/**
 * The OS credential backend for this platform.
 *
 * Same matrix as every other line here: DPAPI on Windows, Keychain on macOS,
 * Secret Service on Linux. The plaintext JSON file is a migration source only,
 * never the live store.
 */
function createCredentialBackend(filePath: string): CredentialStore<MoarkCredentials> {
  if (process.platform === 'win32') {
    return new WindowsDpapiCredentialStore(`${filePath}.dpapi`, parseMoarkCredentials)
  }
  if (process.platform === 'darwin') {
    return new MacKeychainCredentialStore(PROVIDER_ID, credentialAccount(filePath), parseMoarkCredentials)
  }
  if (process.platform === 'linux') {
    return new SecretServiceCredentialStore(PROVIDER_ID, credentialAccount(filePath), parseMoarkCredentials)
  }
  throw new Error('MoArk credential storage requires Windows, macOS, or Linux.')
}

/** Encrypted credential store for the single-token (no pool) configuration. */
export class FileCredentialStore {
  constructor(
    private readonly filePath = credentialPath(),
    private readonly backend: CredentialStore<MoarkCredentials> = createCredentialBackend(filePath),
  ) {}

  path(): string {
    return this.filePath
  }

  async read(): Promise<MoarkCredentials | null> {
    return this.backend.load()
  }

  async write(credentials: MoarkCredentials): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await this.backend.save(credentials)
  }

  async clear(): Promise<void> {
    await this.backend.clear()
  }
}

/**
 * The selection as one settings file means it.
 *
 * Version 3 stores the tri-state as-is alongside the line's surface choice; a
 * version 2 file predates `defaultWire` and stores the same tri-state, so both
 * are read the same way and the missing surface falls back to `DEFAULT_WIRE`.
 * A file from before the tri-state could not say "none" at all — its empty array
 * was the untouched default — so it is read as "no filter", the behaviour it
 * always had.
 */
function readEnabledModelIds(record: Record<string, unknown>): string[] | null {
  const value = record.enabledModelIds
  if (record.version === 2 || record.version === 3) {
    if (!Array.isArray(value)) return null
    return value.filter((id): id is string => typeof id === 'string')
  }
  if (!Array.isArray(value) || value.length === 0) return null
  return value.filter((id): id is string => typeof id === 'string')
}

/**
 * Model settings, bound to the DSH settings document when the harness offers one
 * and to a JSON file beside it otherwise.
 */
export class FileModelSettingsStore implements MoarkPreferenceStore {
  private cached: MoarkModelSettings | null = null
  private loadPromise: Promise<MoarkModelSettings> | null = null

  constructor(private readonly filePath = modelSettingsPath()) {}

  path(): string {
    return this.filePath
  }

  status(): MoarkModelSettings {
    return this.cached ?? {
      enabled: true,
      enabledModelIds: null,
      catalogModels: [],
      defaultReasoningEffort: null,
      defaultWire: DEFAULT_WIRE,
    }
  }

  async read(): Promise<MoarkModelSettings> {
    if (this.cached !== null) return this.cached
    if (this.loadPromise !== null) return this.loadPromise
    this.loadPromise = this.load().finally(() => {
      this.loadPromise = null
    })
    return this.loadPromise
  }

  private async load(): Promise<MoarkModelSettings> {
    try {
      const content = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(content) as unknown
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>
        const enabledModels = readEnabledModelIds(record)
        const catalogModels = Array.isArray(record.catalogModels)
          ? record.catalogModels.filter((entry): entry is MoarkCatalogModel =>
            typeof entry === 'object' && entry !== null && typeof (entry as MoarkCatalogModel).id === 'string')
          : []
        this.cached = {
          enabled: record.enabled !== false,
          enabledModelIds: enabledModels,
          catalogModels,
          defaultReasoningEffort: typeof record.defaultReasoningEffort === 'string'
            ? record.defaultReasoningEffort
            : null,
          // A stored value the current line does not recognize — a hand-edited
          // file, a surface a later release spoke and this one does not — is read
          // as the platform's primary OpenAI path rather than trusted: routing a
          // request at a surface this build cannot call would fail every turn
          // with nothing in the settings card to explain why.
          defaultWire: isMoarkWire(record.defaultWire) ? record.defaultWire : DEFAULT_WIRE,
        }
        return this.cached
      }
    } catch {
      // No settings yet: the defaults above are the honest empty state.
    }
    this.cached = {
      enabled: true,
      enabledModelIds: null,
      catalogModels: [],
      defaultReasoningEffort: null,
      defaultWire: DEFAULT_WIRE,
    }
    return this.cached
  }

  async write(settings: MoarkModelSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp.${Date.now()}`
    // The version marker is what lets a future read tell a stored "none"
    // ([]) apart from a pre-tri-state file, whose empty array meant "no filter".
    await fs.writeFile(tmp, JSON.stringify({ version: 3, ...settings }, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
    this.cached = settings
  }

  async update(patch: {
    enabled?: boolean
    enabledModelIds?: string[] | null
    defaultReasoningEffort?: string | null
    defaultWire?: MoarkWire
  }): Promise<MoarkModelSettings> {
    const current = await this.read()
    // An unrecognized surface is IGNORED rather than stored, matching how the
    // other optional fields treat a value this line cannot honour: a line left
    // pointing at a surface it cannot speak fails every request, which is worse
    // than keeping the surface that was already working. The routes reject a
    // typed-in bad value up front, so this branch only sees one from a
    // hand-edited file or a client that bypassed that check.
    const requestedWire = patch.defaultWire
    const next: MoarkModelSettings = {
      enabled: patch.enabled ?? current.enabled,
      // Null is a real value here ("no filter"), not an absent patch.
      enabledModelIds: patch.enabledModelIds !== undefined ? patch.enabledModelIds : current.enabledModelIds,
      catalogModels: current.catalogModels,
      defaultReasoningEffort: patch.defaultReasoningEffort === undefined
        ? current.defaultReasoningEffort
        : patch.defaultReasoningEffort,
      defaultWire: isMoarkWire(requestedWire) ? requestedWire : current.defaultWire,
    }
    await this.write(next)
    return next
  }

  /** Record a catalog sync without touching the user's enabled selection. */
  async storeCatalog(models: MoarkCatalogModel[]): Promise<MoarkModelSettings> {
    const current = await this.read()
    const next: MoarkModelSettings = { ...current, catalogModels: models }
    await this.write(next)
    return next
  }
}
