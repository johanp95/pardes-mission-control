import { NextRequest, NextResponse } from 'next/server'
import { readdir, readFile, stat, lstat, realpath, writeFile, mkdir, unlink } from 'fs/promises'
import { existsSync, mkdirSync } from 'fs'
import { join, dirname, sep } from 'path'
import { config } from '@/lib/config'
import { resolveWithin } from '@/lib/paths'
import { requireRole } from '@/lib/auth'
import { readLimiter, mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { discoverWorkspaces, getWorkspace } from '@/lib/workspaces'

// Legacy single-workspace support for backward compatibility
const MEMORY_PATH = config.memoryDir
const MEMORY_ALLOWED_PREFIXES = (config.memoryAllowedPrefixes || []).map((p) => p.replace(/\\/g, '/'))

// Ensure memory directory exists on startup (legacy)
if (MEMORY_PATH && !existsSync(MEMORY_PATH)) {
  try { mkdirSync(MEMORY_PATH, { recursive: true }) } catch { /* ignore */ }
}

interface MemoryFile {
  path: string
  name: string
  type: 'file' | 'directory'
  size?: number
  modified?: number
  children?: MemoryFile[]
}

function normalizeRelativePath(value: string): string {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '')
}

function isPathAllowed(relativePath: string): boolean {
  if (!MEMORY_ALLOWED_PREFIXES.length) return true
  const normalized = normalizeRelativePath(relativePath)
  return MEMORY_ALLOWED_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))
}

function isWithinBase(base: string, candidate: string): boolean {
  if (candidate === base) return true
  return candidate.startsWith(base + sep)
}

async function resolveSafeMemoryPath(baseDir: string, relativePath: string): Promise<string> {
  const baseReal = await realpath(baseDir)
  const fullPath = resolveWithin(baseDir, relativePath)

  // For non-existent targets, validate containment using the nearest existing ancestor.
  let current = dirname(fullPath)
  let parentReal = ''
  while (!parentReal) {
    try {
      parentReal = await realpath(current)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw err
      const next = dirname(current)
      if (next === current) {
        throw new Error('Parent directory not found')
      }
      current = next
    }
  }
  if (!isWithinBase(baseReal, parentReal)) {
    throw new Error('Path escapes base directory (symlink)')
  }

  // If the file exists, ensure it also resolves within base and is not a symlink.
  try {
    const st = await lstat(fullPath)
    if (st.isSymbolicLink()) {
      throw new Error('Symbolic links are not allowed')
    }
    const fileReal = await realpath(fullPath)
    if (!isWithinBase(baseReal, fileReal)) {
      throw new Error('Path escapes base directory (symlink)')
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      throw err
    }
  }

  return fullPath
}

async function buildFileTree(dirPath: string, relativePath: string = ''): Promise<MemoryFile[]> {
  try {
    const items = await readdir(dirPath, { withFileTypes: true })
    const files: MemoryFile[] = []

    for (const item of items) {
      if (item.isSymbolicLink()) {
        continue
      }
      const itemPath = join(dirPath, item.name)
      const itemRelativePath = join(relativePath, item.name)
      
      try {
        const stats = await stat(itemPath)
        
        if (item.isDirectory()) {
          const children = await buildFileTree(itemPath, itemRelativePath)
          files.push({
            path: itemRelativePath,
            name: item.name,
            type: 'directory',
            modified: stats.mtime.getTime(),
            children
          })
        } else if (item.isFile()) {
          files.push({
            path: itemRelativePath,
            name: item.name,
            type: 'file',
            size: stats.size,
            modified: stats.mtime.getTime()
          })
        }
      } catch (error) {
        logger.error({ err: error, path: itemPath }, 'Error reading file')
      }
    }

    return files.sort((a, b) => {
      // Directories first, then files, alphabetical within each type
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })
  } catch (error) {
    logger.error({ err: error, path: dirPath }, 'Error reading directory')
    return []
  }
}

/**
 * GET /api/memory?action=tree|content|workspaces
 * 
 * New query params:
 * - workspace={id} : Select specific workspace (default: all workspaces)
 * - action=workspaces : List available workspaces with memory access
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = readLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const { searchParams } = new URL(request.url)
    const path = searchParams.get('path')
    const action = searchParams.get('action')
    const workspaceId = searchParams.get('workspace')

    // NEW: List workspaces with memory
    if (action === 'workspaces') {
      const workspaces = discoverWorkspaces()
      const workspacesWithMemory = workspaces.map(ws => ({
        id: ws.id,
        name: ws.name,
        emoji: ws.emoji,
        path: ws.relativePath,
        hasMemory: existsSync(ws.memoryPath)
      }))
      return NextResponse.json({ workspaces: workspacesWithMemory })
    }

    // NEW: Unified tree across all workspaces (or specific workspace)
    if (action === 'tree') {
      if (workspaceId) {
        // Single workspace tree
        const workspace = getWorkspace(workspaceId)
        if (!workspace) {
          return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
        }
        
        const memoryPath = workspace.memoryPath
        if (!existsSync(memoryPath)) {
          return NextResponse.json({ tree: [], workspace: workspaceId })
        }
        
        const tree = await buildFileTree(memoryPath)
        return NextResponse.json({ 
          tree,
          workspace: workspaceId,
          workspaceName: workspace.name,
          emoji: workspace.emoji
        })
      }
      
      // Multi-workspace unified tree
      const workspaces = discoverWorkspaces()
      const unifiedTree: Array<{
        path: string
        name: string
        type: 'directory'
        workspaceId: string
        workspaceName: string
        emoji?: string
        modified: number
        children: MemoryFile[]
      }> = []
      
      for (const ws of workspaces) {
        if (!existsSync(ws.memoryPath)) continue
        
        try {
          const children = await buildFileTree(ws.memoryPath)
          const stats = await stat(ws.memoryPath)
          
          unifiedTree.push({
            path: ws.relativePath,
            name: ws.name,
            type: 'directory',
            workspaceId: ws.id,
            workspaceName: ws.name,
            emoji: ws.emoji,
            modified: stats.mtime.getTime(),
            children
          })
        } catch (error) {
          logger.error({ err: error, workspace: ws.id }, 'Failed to read workspace memory')
        }
      }
      
      return NextResponse.json({ 
        tree: unifiedTree, 
        unified: true,
        workspaceCount: unifiedTree.length
      })
    }

    // NEW: Content from specific workspace
    if (action === 'content' && path) {
      if (workspaceId) {
        // Read from specific workspace
        const workspace = getWorkspace(workspaceId)
        if (!workspace) {
          return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
        }
        
        const fullPath = await resolveSafeMemoryPath(workspace.memoryPath, path)
        
        try {
          const content = await readFile(fullPath, 'utf-8')
          const stats = await stat(fullPath)
          
          return NextResponse.json({
            content,
            size: stats.size,
            modified: stats.mtime.getTime(),
            path,
            workspace: workspaceId,
            workspaceName: workspace.name
          })
        } catch (error: any) {
          if (error.code === 'ENOENT') {
            return NextResponse.json({ error: 'File not found' }, { status: 404 })
          }
          throw error
        }
      }
      
      // Legacy: try to find file in any workspace
      // First check if path includes workspace prefix
      const workspaces = discoverWorkspaces()
      for (const ws of workspaces) {
        try {
          const fullPath = await resolveSafeMemoryPath(ws.memoryPath, path)
          if (existsSync(fullPath)) {
            const content = await readFile(fullPath, 'utf-8')
            const stats = await stat(fullPath)
            
            return NextResponse.json({
              content,
              size: stats.size,
              modified: stats.mtime.getTime(),
              path,
              workspace: ws.id,
              workspaceName: ws.name
            })
          }
        } catch {
          // Try next workspace
        }
      }
      
      // Fallback to legacy single-path
      if (!isPathAllowed(path)) {
        return NextResponse.json({ error: 'Path not allowed' }, { status: 403 })
      }
      if (!MEMORY_PATH) {
        return NextResponse.json({ error: 'Memory directory not configured' }, { status: 500 })
      }
      const fullPath = await resolveSafeMemoryPath(MEMORY_PATH, path)
      
      try {
        const content = await readFile(fullPath, 'utf-8')
        const stats = await stat(fullPath)
        
        return NextResponse.json({
          content,
          size: stats.size,
          modified: stats.mtime.getTime(),
          path
        })
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          return NextResponse.json({ error: 'File not found' }, { status: 404 })
        }
        throw error
      }
    }

    // Fallback: legacy tree for backward compatibility
    if (action === 'tree' || !action) {
      if (!MEMORY_PATH) {
        return NextResponse.json({ tree: [] })
      }
      if (MEMORY_ALLOWED_PREFIXES.length) {
        const tree: MemoryFile[] = []
        for (const prefix of MEMORY_ALLOWED_PREFIXES) {
          const folder = prefix.replace(/\/$/, '')
          const fullPath = join(MEMORY_PATH, folder)
          if (!existsSync(fullPath)) continue
          try {
            const stats = await stat(fullPath)
            if (!stats.isDirectory()) continue
            tree.push({
              path: folder,
              name: folder,
              type: 'directory',
              modified: stats.mtime.getTime(),
              children: await buildFileTree(fullPath, folder),
            })
          } catch {
            // Skip unreadable roots
          }
        }
        return NextResponse.json({ tree })
      }
      const tree = await buildFileTree(MEMORY_PATH)
      return NextResponse.json({ tree })
    }

    return NextResponse.json({ error: 'Invalid action. Use ?action=tree|content|workspaces' }, { status: 400 })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/memory error')
    return NextResponse.json({ error: 'Failed to read memory' }, { status: 500 })
  }
}

/**
 * POST /api/memory - Write file (with workspace support)
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const body = await request.json()
    const { action, path: filePath, content, workspace: workspaceId } = body

    if (!filePath) {
      return NextResponse.json({ error: 'path is required' }, { status: 400 })
    }

    // Determine target workspace
    let targetMemoryPath = MEMORY_PATH
    let targetWorkspace: { id: string; name: string } | undefined
    
    if (workspaceId) {
      const workspace = getWorkspace(workspaceId)
      if (!workspace) {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
      }
      targetMemoryPath = workspace.memoryPath
      targetWorkspace = { id: workspace.id, name: workspace.name }
    }

    if (!targetMemoryPath) {
      return NextResponse.json({ error: 'Memory directory not configured' }, { status: 500 })
    }

    if (action === 'write') {
      if (typeof content !== 'string') {
        return NextResponse.json({ error: 'content must be a string' }, { status: 400 })
      }

      const fullPath = await resolveSafeMemoryPath(targetMemoryPath, filePath)
      
      // Ensure parent directory exists
      const parentDir = dirname(fullPath)
      if (!existsSync(parentDir)) {
        await mkdir(parentDir, { recursive: true })
      }

      await writeFile(fullPath, content, 'utf-8')

      return NextResponse.json({
        success: true,
        path: filePath,
        workspace: targetWorkspace?.id,
        workspaceName: targetWorkspace?.name,
        message: 'File saved successfully'
      })
    }

    if (action === 'mkdir') {
      const fullPath = await resolveSafeMemoryPath(targetMemoryPath, filePath)
      await mkdir(fullPath, { recursive: true })

      return NextResponse.json({
        success: true,
        path: filePath,
        workspace: targetWorkspace?.id,
        message: 'Directory created successfully'
      })
    }

    if (action === 'delete') {
      const fullPath = await resolveSafeMemoryPath(targetMemoryPath, filePath)
      await unlink(fullPath)

      return NextResponse.json({
        success: true,
        path: filePath,
        workspace: targetWorkspace?.id,
        message: 'File deleted successfully'
      })
    }

    return NextResponse.json({ error: 'Invalid action. Use write|mkdir|delete' }, { status: 400 })
  } catch (error: any) {
    logger.error({ err: error }, 'POST /api/memory error')
    return NextResponse.json({ error: error.message || 'Failed to write memory' }, { status: 500 })
  }
}
