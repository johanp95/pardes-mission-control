/**
 * Multi-Workspace Discovery
 * 
 * Scans the OpenClaw state directory for all agent workspaces and maps them
 * to their respective agents from openclaw.json configuration.
 */

import fs from 'node:fs'
import path from 'node:path'
import { config } from './config'
import { logger } from './logger'

export interface WorkspaceInfo {
  id: string                    // Agent ID (e.g., 'main', 'cognitron-age')
  name: string                  // Display name from identity
  emoji?: string                // Agent emoji
  workspacePath: string         // Full path to workspace directory
  memoryPath: string            // Path to memory subdirectory
  relativePath: string          // Path relative to openclaw home (e.g., 'workspace-cognitron-age')
  isDefault: boolean            // Is this the default workspace?
}

// Cache for workspace discovery
let workspaceCache: WorkspaceInfo[] | null = null
let workspaceCacheTime = 0
const WORKSPACE_CACHE_TTL_MS = 5000 // 5 second cache

/**
 * Parse openclaw.json to get agent workspace mappings
 */
function parseOpenClawConfig(): Map<string, { workspace?: string; identity?: { name?: string; emoji?: string } }> {
  const agentMap = new Map<string, { workspace?: string; identity?: { name?: string; emoji?: string } }>()
  
  try {
    if (!fs.existsSync(config.openclawConfigPath)) {
      logger.warn('openclaw.json not found at ' + config.openclawConfigPath)
      return agentMap
    }
    
    const content = fs.readFileSync(config.openclawConfigPath, 'utf-8')
    const parsed = JSON.parse(content)
    
    // Extract default workspace settings
    const defaults = parsed.agents?.defaults || {}
    const defaultWorkspace = defaults.workspace
    
    // Map each agent to its workspace
    const agents = parsed.agents?.list || []
    for (const agent of agents) {
      if (!agent.id) continue
      
      // Resolve workspace path
      let workspacePath = agent.workspace || defaultWorkspace
      if (workspacePath && !path.isAbsolute(workspacePath)) {
        workspacePath = path.join(config.openclawStateDir, workspacePath)
      }
      
      agentMap.set(agent.id, {
        workspace: workspacePath,
        identity: agent.identity
      })
    }
    
    // Also check for agents that might only have workspace directories
    // (worker agents, dynamic agents, etc.)
    discoverUnlistedWorkspaces(agentMap)
    
  } catch (error) {
    logger.error({ err: error }, 'Failed to parse openclaw.json')
  }
  
  return agentMap
}

/**
 * Discover workspaces that exist but aren't in openclaw.json
 * (worker agents, temporary agents, etc.)
 */
function discoverUnlistedWorkspaces(
  agentMap: Map<string, { workspace?: string; identity?: { name?: string; emoji?: string } }>
) {
  try {
    const entries = fs.readdirSync(config.openclawStateDir, { withFileTypes: true })
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!entry.name.startsWith('workspace')) continue
      
      // Extract agent ID from directory name
      // workspace -> main (default)
      // workspace-cognitron-age -> cognitron-age
      let agentId = entry.name === 'workspace' ? 'main' : entry.name.replace('workspace-', '')
      
      // Skip if already mapped
      if (agentMap.has(agentId)) continue
      
      const workspacePath = path.join(config.openclawStateDir, entry.name)
      
      // Try to read identity from workspace SOUL.md or IDENTITY.md
      const identity = extractIdentityFromWorkspace(workspacePath)
      
      agentMap.set(agentId, {
        workspace: workspacePath,
        identity
      })
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to discover unlisted workspaces')
  }
}

/**
 * Try to extract agent identity from workspace files
 */
function extractIdentityFromWorkspace(workspacePath: string): { name?: string; emoji?: string } | undefined {
  try {
    // Try SOUL.md first
    const soulPath = path.join(workspacePath, 'SOUL.md')
    if (fs.existsSync(soulPath)) {
      const content = fs.readFileSync(soulPath, 'utf-8')
      const lines = content.split('\n').map(l => l.trim()).filter(Boolean)
      
      let name: string | undefined
      let emoji: string | undefined
      
      for (const line of lines) {
        if (!name && line.startsWith('#')) {
          name = line.replace(/^#+\s*/, '').trim()
        }
        const emojiMatch = line.match(/^emoji\s*:\s*(.+)$/i)
        if (emojiMatch) {
          emoji = emojiMatch[1].trim()
        }
        if (name && emoji) break
      }
      
      if (name || emoji) {
        return { name, emoji }
      }
    }
    
    // Try IDENTITY.md
    const identityPath = path.join(workspacePath, 'IDENTITY.md')
    if (fs.existsSync(identityPath)) {
      const content = fs.readFileSync(identityPath, 'utf-8')
      const nameMatch = content.match(/Name[:\s]+([^\n]+)/i)
      const emojiMatch = content.match(/Emoji[:\s]+([^\n]+)/i)
      
      if (nameMatch || emojiMatch) {
        return {
          name: nameMatch?.[1].trim(),
          emoji: emojiMatch?.[1].trim()
        }
      }
    }
  } catch (error) {
    // Silent fail — identity is optional
  }
  
  return undefined
}

/**
 * Discover all workspaces and return workspace info array
 */
export function discoverWorkspaces(): WorkspaceInfo[] {
  // Check cache
  const now = Date.now()
  if (workspaceCache && (now - workspaceCacheTime) < WORKSPACE_CACHE_TTL_MS) {
    return workspaceCache
  }
  
  const agentMap = parseOpenClawConfig()
  const workspaces: WorkspaceInfo[] = []
  
  for (const [agentId, info] of agentMap.entries()) {
    if (!info.workspace) continue
    if (!fs.existsSync(info.workspace)) {
      logger.warn(`Workspace for ${agentId} not found: ${info.workspace}`)
      continue
    }
    
    const relativePath = path.relative(config.openclawStateDir, info.workspace)
    const memoryPath = path.join(info.workspace, 'memory')
    
    // Only include workspaces that have a memory directory
    // This prevents showing git files, SOUL.md, etc. as "memory"
    if (!fs.existsSync(memoryPath)) {
      logger.debug(`Skipping ${agentId}: no memory directory`)
      continue
    }
    
    workspaces.push({
      id: agentId,
      name: info.identity?.name || agentId,
      emoji: info.identity?.emoji,
      workspacePath: info.workspace,
      memoryPath: memoryPath,
      relativePath,
      isDefault: agentId === 'main' || relativePath === 'workspace'
    })
  }
  
  // Sort: default first, then alphabetically by name
  workspaces.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  
  // Update cache
  workspaceCache = workspaces
  workspaceCacheTime = now
  
  logger.info(`Discovered ${workspaces.length} workspaces`)
  return workspaces
}

/**
 * Get a specific workspace by agent ID
 */
export function getWorkspace(agentId: string): WorkspaceInfo | undefined {
  const workspaces = discoverWorkspaces()
  return workspaces.find(w => w.id === agentId)
}

/**
 * Get the default (main) workspace
 */
export function getDefaultWorkspace(): WorkspaceInfo | undefined {
  const workspaces = discoverWorkspaces()
  return workspaces.find(w => w.isDefault) || workspaces[0]
}

/**
 * Build a unified memory directory structure from all workspaces
 * Returns a virtual filesystem that merges all workspace memories
 */
export function buildUnifiedMemoryTree(): Array<{
  workspaceId: string
  workspaceName: string
  emoji?: string
  path: string
  relativePath: string
}> {
  const workspaces = discoverWorkspaces()
  const unified: Array<{
    workspaceId: string
    workspaceName: string
    emoji?: string
    path: string
    relativePath: string
  }> = []
  
  for (const ws of workspaces) {
    const memoryPath = path.join(ws.workspacePath, 'memory')
    if (!fs.existsSync(memoryPath)) continue
    
    unified.push({
      workspaceId: ws.id,
      workspaceName: ws.name,
      emoji: ws.emoji,
      path: memoryPath,
      relativePath: ws.relativePath
    })
  }
  
  return unified
}

/**
 * Invalidate workspace cache (call after agent config changes)
 */
export function invalidateWorkspaceCache() {
  workspaceCache = null
  workspaceCacheTime = 0
  logger.info('Workspace cache invalidated')
}

/**
 * Watch openclaw.json for changes and invalidate cache
 */
export function watchWorkspaceConfig() {
  if (!fs.existsSync(config.openclawConfigPath)) return
  
  fs.watchFile(config.openclawConfigPath, { interval: 5000 }, () => {
    logger.info('openclaw.json changed, invalidating workspace cache')
    invalidateWorkspaceCache()
  })
}
