import { createLineApi } from '../common/line-api.ts'
import type {
  MoarkAccountAction,
  MoarkWebStatus,
} from '../../shared/moark-contracts.ts'
import { MOARK_ROUTE_PREFIX } from '../../shared/moark-contracts.ts'

const API = createLineApi(MOARK_ROUTE_PREFIX, 'MoArk')

/**
 * The MoArk settings API, typed.
 *
 * The reader itself is the shared `createLineApi`, so a refusal here is worded
 * and unwrapped exactly as it is on every other line — including the stale-host
 * sentence, which matters because the browser half is read from disk on demand
 * while the host half only loads at startup.
 */
export class MoarkApi {
  status(): Promise<MoarkWebStatus> {
    return API.get<MoarkWebStatus>('/status')
  }

  accountAction(
    action: MoarkAccountAction,
    body: { accountId?: string; alias?: string; strategy?: string; apiKey?: string } = {},
  ): Promise<MoarkWebStatus> {
    return API.post<MoarkWebStatus>('/accounts', { action, ...body })
  }

  /** Persist the line switch and the default protocol surface. */
  updateSettings(patch: { enabled?: boolean; defaultWire?: string }): Promise<unknown> {
    return API.post<unknown>('/settings', patch)
  }

  /** Read the model list from MoArk and store it host-side. */
  refreshCatalog(): Promise<{ models: unknown[] }> {
    return API.post<{ models: unknown[] }>('/catalog/refresh')
  }

  setEnabledModels(enabledModelIds: string[] | null): Promise<{ enabledModelIds: string[] | null }> {
    return API.post<{ enabledModelIds: string[] | null }>('/models', { enabledModelIds })
  }
}
