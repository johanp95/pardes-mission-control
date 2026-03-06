import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { readLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { getModelCatalogAsync, getPrimaryModelAsync, invalidateModelCache } from '@/lib/models'

/**
 * GET /api/models - List all available models
 * 
 * Query params:
 * - refresh=true : Force cache invalidation
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = readLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const { searchParams } = new URL(request.url)
    const refresh = searchParams.get('refresh') === 'true'

    if (refresh) {
      invalidateModelCache()
    }

    const models = await getModelCatalogAsync()
    const primary = await getPrimaryModelAsync()

    return NextResponse.json({
      models,
      primary: primary?.alias || primary?.name,
      count: models.length,
      source: 'openclaw.json',
      refreshed: refresh
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/models error')
    return NextResponse.json({ error: 'Failed to load models' }, { status: 500 })
  }
}
