import { NextRequest, NextResponse } from 'next/server'
import { readFile, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { requireRole } from '@/lib/auth'
import { readLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { getWorkspace, discoverWorkspaces } from '@/lib/workspaces'
import { resolveWithin } from '@/lib/paths'
import { realpath, lstat } from 'fs/promises'

// Allowed document extensions
const ALLOWED_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.yml', '.yaml', '.toml',
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go',
  '.css', '.scss', '.less', '.html', '.xml', '.sql'
])

function normalizeRelativePath(value: string): string {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '')
}

function isWithinBase(base: string, candidate: string): boolean {
  if (candidate === base) return true
  return candidate.startsWith(base + '/')
}

async function resolveSafePath(baseDir: string, relativePath: string): Promise<string> {
  const baseReal = await realpath(baseDir)
  const fullPath = resolveWithin(baseDir, relativePath)

  let parentReal: string
  try {
    parentReal = await realpath(dirname(fullPath))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw new Error('Parent directory not found')
    throw err
  }

  if (!isWithinBase(baseReal, parentReal)) {
    throw new Error('Path escapes base directory')
  }

  try {
    const st = await lstat(fullPath)
    if (st.isSymbolicLink()) throw new Error('Symbolic links are not allowed')
    const fileReal = await realpath(fullPath)
    if (!isWithinBase(baseReal, fileReal)) {
      throw new Error('Path escapes base directory')
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw err
  }

  return fullPath
}

function isAllowedFile(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase()
  return ALLOWED_EXTENSIONS.has(ext)
}

/**
 * GET /api/docs/content?path=...&workspace=...
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = readLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const { searchParams } = new URL(request.url)
    const filePath = searchParams.get('path')
    const workspaceId = searchParams.get('workspace')

    if (!filePath) {
      return NextResponse.json({ error: 'path is required' }, { status: 400 })
    }

    if (!isAllowedFile(filePath)) {
      return NextResponse.json({ error: 'File type not allowed' }, { status: 403 })
    }

    // Find the workspace
    let workspacePath: string | undefined
    let foundWorkspaceId: string | undefined
    let foundWorkspaceName: string | undefined

    if (workspaceId) {
      const workspace = getWorkspace(workspaceId)
      if (!workspace) {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
      }
      workspacePath = workspace.workspacePath
      foundWorkspaceId = workspace.id
      foundWorkspaceName = workspace.name
    } else {
      // Try to find file in any workspace
      const workspaces = discoverWorkspaces()
      for (const ws of workspaces) {
        try {
          const fullPath = await resolveSafePath(ws.workspacePath, filePath)
          if (existsSync(fullPath)) {
            workspacePath = ws.workspacePath
            foundWorkspaceId = ws.id
            foundWorkspaceName = ws.name
            break
          }
        } catch {
          // Try next workspace
        }
      }
    }

    if (!workspacePath) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 })
    }

    const fullPath = await resolveSafePath(workspacePath, filePath)
    
    if (!existsSync(fullPath)) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 })
    }

    const content = await readFile(fullPath, 'utf-8')
    const info = await stat(fullPath)

    return NextResponse.json({
      content,
      size: info.size,
      modified: info.mtime.getTime(),
      path: normalizeRelativePath(filePath),
      workspace: foundWorkspaceId,
      workspaceName: foundWorkspaceName
    })
  } catch (error: any) {
    logger.error({ err: error }, 'GET /api/docs/content error')
    return NextResponse.json({ error: error.message || 'Failed to read document' }, { status: 500 })
  }
}
