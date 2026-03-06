'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { MarkdownRenderer } from '@/components/markdown-renderer'

interface Workspace {
  id: string
  name: string
  emoji?: string
  path: string
  hasMemory: boolean
}

interface DocsTreeNode {
  path: string
  name: string
  type: 'file' | 'directory'
  size?: number
  modified?: number
  children?: DocsTreeNode[]
}

interface WorkspaceWithDocs extends Workspace {
  children: DocsTreeNode[]
  modified: number
}

interface DocsContentResponse {
  path: string
  content: string
  size: number
  modified: number
  workspace?: string
  workspaceName?: string
  error?: string
}

function collectFilePaths(nodes: DocsTreeNode[]): string[] {
  const filePaths: string[] = []
  for (const node of nodes) {
    if (node.type === 'file') {
      filePaths.push(node.path)
      continue
    }
    if (node.children && node.children.length > 0) {
      filePaths.push(...collectFilePaths(node.children))
    }
  }
  return filePaths
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString()
}

export function DocumentsPanel() {
  const [workspaces, setWorkspaces] = useState<WorkspaceWithDocs[]>([])
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | 'all'>('all')
  const [loadingTree, setLoadingTree] = useState(true)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)
  const [docContent, setDocContent] = useState<string>('')
  const [docMeta, setDocMeta] = useState<{ size: number; modified: number } | null>(null)
  const [loadingDoc, setLoadingDoc] = useState(false)
  const [docError, setDocError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())

  // Load workspaces with docs
  const loadTree = useCallback(async () => {
    setLoadingTree(true)
    setTreeError(null)
    try {
      // Use the workspace-aware memory API
      const res = await fetch('/api/memory?action=tree')
      const data = await res.json()
      
      if (!res.ok) throw new Error(data.error || 'Failed to load documents')

      if (data.unified && Array.isArray(data.tree)) {
        // New multi-workspace format
        setWorkspaces(data.tree)
        // Auto-expand all workspaces
        const allPaths = new Set<string>()
        data.tree.forEach((ws: WorkspaceWithDocs) => {
          allPaths.add(ws.path)
        })
        setExpandedDirs(allPaths)
      } else if (Array.isArray(data.tree)) {
        // Legacy format
        setWorkspaces([{
          id: 'legacy',
          name: 'Documents',
          path: 'docs',
          hasMemory: true,
          children: data.tree,
          modified: Date.now()
        }])
        setExpandedDirs(new Set(['docs']))
      }
    } catch (error) {
      setWorkspaces([])
      setTreeError((error as Error).message || 'Failed to load documents')
    } finally {
      setLoadingTree(false)
    }
  }, [])

  useEffect(() => {
    loadTree()
  }, [loadTree])

  const loadDoc = useCallback(async (path: string, workspaceId?: string) => {
    setLoadingDoc(true)
    setDocError(null)
    try {
      const wsParam = workspaceId ? `&workspace=${encodeURIComponent(workspaceId)}` : ''
      const res = await fetch(`/api/memory?action=content&path=${encodeURIComponent(path)}${wsParam}`)
      const data = (await res.json()) as DocsContentResponse
      if (!res.ok) throw new Error(data.error || 'Failed to load document')

      setDocContent(data.content)
      setDocMeta({ size: data.size, modified: data.modified })
      setSelectedPath(path)
      setSelectedWorkspaceId(workspaceId || data.workspace || null)
    } catch (error) {
      setDocError((error as Error).message || 'Failed to load document')
      setDocContent('')
      setDocMeta(null)
    } finally {
      setLoadingDoc(false)
    }
  }, [])

  const allFilePaths = useMemo(() => {
    const paths: string[] = []
    workspaces.forEach(ws => {
      paths.push(...collectFilePaths(ws.children || []))
    })
    return paths
  }, [workspaces])

  const filteredFilePaths = useMemo(() => {
    if (!searchQuery.trim()) return []
    const q = searchQuery.toLowerCase()
    return allFilePaths.filter((p) => p.toLowerCase().includes(q)).slice(0, 20)
  }, [searchQuery, allFilePaths])

  const displayedWorkspaces = useMemo(() => {
    if (selectedWorkspace === 'all') return workspaces
    return workspaces.filter(ws => ws.id === selectedWorkspace)
  }, [workspaces, selectedWorkspace])

  const toggleDir = (path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }

  const renderNode = (node: DocsTreeNode, depth = 0, workspaceId?: string): React.ReactNode => {
    const isExpanded = expandedDirs.has(node.path)
    const paddingLeft = 12 + depth * 16

    if (node.type === 'directory') {
      return (
        <div key={node.path}>
          <button
            onClick={() => toggleDir(node.path)}
            className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-secondary/60 rounded-md"
            style={{ paddingLeft }}
          >
            <span className="text-muted-foreground">{isExpanded ? '📂' : '📁'}</span>
            <span className="text-sm font-medium truncate">{node.name}</span>
          </button>
          {isExpanded && node.children && (
            <div>
              {node.children.map((child) => renderNode(child, depth + 1, workspaceId))}
            </div>
          )}
        </div>
      )
    }

    const isSelected = selectedPath === node.path
    return (
      <button
        key={node.path}
        onClick={() => loadDoc(node.path, workspaceId)}
        className={`w-full flex items-center gap-2 px-2 py-1.5 text-left rounded-md ${
          isSelected ? 'bg-primary/20 text-primary' : 'hover:bg-secondary/60'
        }`}
        style={{ paddingLeft }}
        title={`${node.path} • ${formatBytes(node.size || 0)} • ${formatTime(node.modified || 0)}`}
      >
        <span className="text-muted-foreground">📄</span>
        <span className="text-sm truncate">{node.name}</span>
        <span className="ml-auto text-xs text-muted-foreground">{formatBytes(node.size || 0)}</span>
      </button>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div>
          <h2 className="text-lg font-semibold">Documents</h2>
          <p className="text-sm text-muted-foreground">
            {workspaces.length} agent workspaces
          </p>
        </div>
        
        {/* Workspace Selector */}
        <select
          value={selectedWorkspace}
          onChange={(e) => setSelectedWorkspace(e.target.value)}
          className="px-3 py-1.5 bg-secondary border border-border rounded-md text-sm"
        >
          <option value="all">All Workspaces</option>
          {workspaces.map((ws) => (
            <option key={ws.id} value={ws.id}>
              {ws.emoji} {ws.name}
            </option>
          ))}
        </select>
      </div>

      {/* Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <div className="w-72 border-r border-border flex flex-col bg-card">
          {/* Search */}
          <div className="p-3 border-b border-border">
            <div className="relative">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search files..."
                className="w-full px-3 py-2 pl-9 bg-secondary border border-border rounded-md text-sm"
              />
              <span className="absolute left-3 top-2.5 text-muted-foreground text-sm">🔍</span>
            </div>
            
            {searchQuery && filteredFilePaths.length > 0 && (
              <div className="mt-2 max-h-48 overflow-y-auto border border-border rounded-md bg-background">
                {filteredFilePaths.map((path) => (
                  <button
                    key={path}
                    onClick={() => loadDoc(path)}
                    className="w-full px-3 py-1.5 text-left text-sm hover:bg-secondary truncate"
                  >
                    {path.split('/').pop()}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Tree */}
          <div className="flex-1 overflow-y-auto p-2">
            {loadingTree ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin mr-2" />
                Loading...
              </div>
            ) : treeError ? (
              <div className="p-4 text-sm text-red-500">{treeError}</div>
            ) : (
              <div className="space-y-2">
                {displayedWorkspaces.map((workspace) => (
                  <div key={workspace.id} className="border border-border rounded-lg overflow-hidden">
                    {/* Workspace Header */}
                    <button
                      onClick={() => toggleDir(workspace.path)}
                      className="w-full flex items-center gap-2 px-3 py-2 bg-secondary/50 hover:bg-secondary transition-colors"
                    >
                      <span>{expandedDirs.has(workspace.path) ? '📂' : '📁'}</span>
                      <span className="font-semibold text-sm">{workspace.emoji} {workspace.name}</span>
                      <span className="text-xs text-muted-foreground ml-auto">
                        {workspace.children?.length || 0}
                      </span>
                    </button>
                    
                    {/* Files */}
                    {expandedDirs.has(workspace.path) && workspace.children && (
                      <div className="p-1">
                        {workspace.children.map((child) => renderNode(child, 0, workspace.id))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Document Viewer */}
        <div className="flex-1 flex flex-col overflow-hidden bg-background">
          {selectedPath ? (
            <>
              <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-muted-foreground">📄</span>
                  <span className="font-medium truncate">{selectedPath}</span>
                  {selectedWorkspaceId && (
                    <span className="text-xs text-muted-foreground">
                      ({workspaces.find(w => w.id === selectedWorkspaceId)?.name || selectedWorkspaceId})
                    </span>
                  )}
                </div>
                {docMeta && (
                  <div className="text-xs text-muted-foreground">
                    {formatBytes(docMeta.size)} • {formatTime(docMeta.modified)}
                  </div>
                )}
              </div>
              <div className="flex-1 overflow-auto p-6">
                {loadingDoc ? (
                  <div className="flex items-center justify-center h-full text-muted-foreground">
                    <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin mr-2" />
                    Loading...
                  </div>
                ) : docError ? (
                  <div className="text-red-500">{docError}</div>
                ) : (
                  <div className="prose dark:prose-invert max-w-none">
                    <MarkdownRenderer content={docContent} />
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              <div className="text-center">
                <span className="text-4xl mb-4 block">📚</span>
                <p>Select a document to view</p>
                <p className="text-sm mt-1">
                  {workspaces.reduce((acc, ws) => acc + (ws.children?.length || 0), 0)} files across {workspaces.length} workspaces
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
