import { NextRequest, NextResponse } from 'next/server'
import { readdir, readFile, stat, lstat, realpath } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname, join, sep } from 'path'
import { resolveWithin } from '@/lib/paths'
import { requireRole } from '@/lib/auth'
import { readLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { discoverWorkspaces, getWorkspace } from '@/lib/workspaces'

export interface DocsTreeNode {
  path: string
  name: string
  type: 'file' | 'directory'
  size?: number
  modified?: number
  children?: DocsTreeNode[]
}

// Directories to ignore in document listings
const IGNORED_DIRS = new Set([
  '.git', '.openclaw', 'node_modules', '.next', 'dist', 'build',
  'coverage', '.vscode', '.idea', '__pycache__', '.pytest_cache',
  '.turbo', '.vercel', '.netlify'
])

// File extensions to show in documents
const DOCUMENT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.yml', '.yaml', '.toml',
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go'
])

function normalizeRelativePath(value: string): string {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '')
}

function isWithinBase(base: string, candidate: string): boolean {
  if (candidate === base) return true
  return candidate.startsWith(base + sep)
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
    throw new Error('Path escapes base directory (symlink)')
  }

  try {
    const st = await lstat(fullPath)
    if (st.isSymbolicLink()) throw new Error('Symbolic links are not allowed')
    const fileReal = await realpath(fullPath)
    if (!isWithinBase(baseReal, fileReal)) {
      throw new Error('Path escapes base directory (symlink)')
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw err
  }

  return fullPath
}

/**
 * Build document tree from workspace, excluding ignored directories
 */
async function buildDocsTree(dirPath: string, relativeBase: string = ''): Promise<DocsTreeNode[]> {
  try {
    const items = await readdir(dirPath, { withFileTypes: true })
    const nodes: DocsTreeNode[] = []

    for (const item of items) {
      // Skip symlinks and ignored directories
      if (item.isSymbolicLink()) continue
      if (item.isDirectory() && IGNORED_DIRS.has(item.name)) continue
      
      const fullPath = join(dirPath, item.name)
      const relativePath = normalizeRelativePath(join(relativeBase, item.name))

      try {
        const info = await stat(fullPath)
        
        if (item.isDirectory()) {
          const children = await buildDocsTree(fullPath, relativePath)
          // Only include directory if it has visible children
          if (children.length > 0) {
            nodes.push({
              path: relativePath,
              name: item.name,
              type: 'directory',
              modified: info.mtime.getTime(),
              children,
            })
          }
        } else if (item.isFile()) {
          // Include file if it has a document extension or is in root
          const ext = item.name.slice(item.name.lastIndexOf('.')).toLowerCase()
          const isInRoot = !relativeBase.includes('/')
          
          if (DOCUMENT_EXTENSIONS.has(ext) || isInRoot) {
            nodes.push({
              path: relativePath,
              name: item.name,
              type: 'file',
              size: info.size,
              modified: info.mtime.getTime(),
            })
          }
        }
      } catch {
        // Ignore unreadable files
      }
    }

    return nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  } catch (error) {
    logger.error({ err: error, path: dirPath }, 'Error reading docs directory')
    return []
  }
}

/**
 * GET /api/docs/tree - Get document tree across all workspaces or specific workspace
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = readLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get('workspace')

    // Specific workspace requested
    if (workspaceId) {
      const workspace = getWorkspace(workspaceId)
      if (!workspace) {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
      }

      const children = await buildDocsTree(workspace.workspacePath)
      
      return NextResponse.json({
        unified: false,
        tree: [{
          path: workspace.relativePath,
          name: workspace.name,
          type: 'directory' as const,
          emoji: workspace.emoji,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          modified: Date.now(),
          children
        }],
        workspace: workspaceId
      })
    }

    // Unified view: all workspaces
    const workspaces = discoverWorkspaces()
    const unifiedTree: Array<{
      path: string
      name: string
      type: 'directory'
      emoji?: string
      workspaceId: string
      workspaceName: string
      modified: number
      children: DocsTreeNode[]
    }> = []

    for (const ws of workspaces) {
      try {
        const children = await buildDocsTree(ws.workspacePath)
        
        // Only include workspace if it has visible documents
        if (children.length === 0) continue

        unifiedTree.push({
          path: ws.relativePath,
          name: ws.name,
          type: 'directory',
          emoji: ws.emoji,
          workspaceId: ws.id,
          workspaceName: ws.name,
          modified: Date.now(),
          children
        })
      } catch (error) {
        logger.error({ err: error, workspace: ws.id }, 'Failed to read workspace docs')
      }
    }

    return NextResponse.json({
      unified: true,
      tree: unifiedTree,
      workspaceCount: unifiedTree.length
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/docs/tree error')
    return NextResponse.json({ error: 'Failed to load documents' }, { status: 500 })
  }
}
