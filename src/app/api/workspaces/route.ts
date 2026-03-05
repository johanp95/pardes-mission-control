import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { discoverWorkspaces, getWorkspace, buildUnifiedMemoryTree, invalidateWorkspaceCache } from '@/lib/workspaces'
import { logger } from '@/lib/logger'

/**
 * GET /api/workspaces - List all discovered agent workspaces
 * 
 * Query params:
 * - refresh=true : Force cache invalidation and rediscovery
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const { searchParams } = new URL(request.url)
    const refresh = searchParams.get('refresh') === 'true'
    
    if (refresh) {
      invalidateWorkspaceCache()
    }
    
    const workspaces = discoverWorkspaces()
    
    // Don't expose full filesystem paths to client
    const safeWorkspaces = workspaces.map(ws => ({
      id: ws.id,
      name: ws.name,
      emoji: ws.emoji,
      relativePath: ws.relativePath,
      isDefault: ws.isDefault,
      hasMemory: true, // Simplified for now
    }))
    
    return NextResponse.json({ 
      workspaces: safeWorkspaces,
      total: safeWorkspaces.length,
      refreshed: refresh
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/workspaces error')
    return NextResponse.json({ error: 'Failed to discover workspaces' }, { status: 500 })
  }
}

/**
 * POST /api/workspaces/invalidate - Force workspace cache refresh
 * (Admin only)
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    invalidateWorkspaceCache()
    const workspaces = discoverWorkspaces()
    
    return NextResponse.json({
      success: true,
      message: 'Workspace cache invalidated',
      workspacesFound: workspaces.length
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/workspaces error')
    return NextResponse.json({ error: 'Failed to refresh workspaces' }, { status: 500 })
  }
}
