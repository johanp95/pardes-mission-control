'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { useMissionControl } from '@/store'
import { createClientLogger } from '@/lib/client-logger'

const log = createClientLogger('MemoryBrowser')

interface Workspace {
  id: string
  name: string
  emoji?: string
  path: string
  hasMemory: boolean
}

interface MemoryFile {
  path: string
  name: string
  type: 'file' | 'directory'
  size?: number
  modified?: number
  children?: MemoryFile[]
}

interface WorkspaceWithFiles extends Workspace {
  children: MemoryFile[]
  modified: number
}

export function MemoryBrowserPanel() {
  const {
    memoryFiles,
    selectedMemoryFile,
    memoryContent,
    dashboardMode,
    setMemoryFiles,
    setSelectedMemoryFile,
    setMemoryContent
  } = useMissionControl()
  const isLocal = dashboardMode === 'local'

  const [isLoading, setIsLoading] = useState(false)
  const [workspaces, setWorkspaces] = useState<WorkspaceWithFiles[]>([])
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | 'all'>('all')
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [isSearching, setIsSearching] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editedContent, setEditedContent] = useState('')
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [activeTab, setActiveTab] = useState<'daily' | 'knowledge' | 'all'>('all')

  // Load workspaces and their files
  const loadWorkspaces = useCallback(async () => {
    setIsLoading(true)
    try {
      // Fetch unified tree (all workspaces)
      const response = await fetch('/api/memory?action=tree')
      const data = await response.json()
      
      if (data.unified && Array.isArray(data.tree)) {
        // New format: tree is array of workspaces
        setWorkspaces(data.tree)
        setMemoryFiles(data.tree) // For backward compatibility
      } else if (Array.isArray(data.tree)) {
        // Legacy format: flat file tree
        setWorkspaces([{
          id: 'legacy',
          name: 'Memory',
          path: 'memory',
          hasMemory: true,
          children: data.tree,
          modified: Date.now()
        }])
        setMemoryFiles(data.tree)
      }

      // Auto-expand all workspaces initially
      const allPaths = new Set<string>()
      data.tree?.forEach((ws: WorkspaceWithFiles) => {
        allPaths.add(ws.path)
        ws.children?.forEach((child: MemoryFile) => {
          if (child.type === 'directory') {
            allPaths.add(child.path)
          }
        })
      })
      setExpandedFolders(allPaths)
    } catch (error) {
      log.error('Failed to load workspaces:', error)
    } finally {
      setIsLoading(false)
    }
  }, [setMemoryFiles])

  useEffect(() => {
    loadWorkspaces()
  }, [loadWorkspaces])

  // Get files to display based on selected workspace
  const getDisplayFiles = (): WorkspaceWithFiles[] => {
    let filtered = workspaces

    // Filter by workspace
    if (selectedWorkspace !== 'all') {
      filtered = workspaces.filter(ws => ws.id === selectedWorkspace)
    }

    // Filter by tab (daily/knowledge)
    if (activeTab !== 'all') {
      filtered = filtered.map(ws => ({
        ...ws,
        children: ws.children?.filter(file => {
          const normalizedPath = `${file.path.replace(/\\/g, '/')}/`.toLowerCase()
          if (activeTab === 'daily') {
            return normalizedPath.includes('memory/') || normalizedPath.match(/\d{4}-\d{2}-\d{2}/)
          } else {
            return normalizedPath.includes('knowledge') || !normalizedPath.match(/\d{4}-\d{2}-\d{2}/)
          }
        }) || []
      }))
    }

    return filtered
  }

  const loadFileContent = async (filePath: string, workspaceId?: string) => {
    setIsLoading(true)
    try {
      // Include workspace if specified
      const wsParam = workspaceId ? `&workspace=${encodeURIComponent(workspaceId)}` : ''
      const response = await fetch(`/api/memory?action=content&path=${encodeURIComponent(filePath)}${wsParam}`)
      const data = await response.json()
      
      if (data.content !== undefined) {
        setSelectedMemoryFile(filePath)
        setMemoryContent(data.content)
      } else {
        alert(data.error || 'Failed to load file content')
      }
    } catch (error) {
      log.error('Failed to load file content:', error)
      alert('Network error occurred')
    } finally {
      setIsLoading(false)
    }
  }

  const searchFiles = async () => {
    if (!searchQuery.trim()) return

    setIsSearching(true)
    try {
      const response = await fetch(`/api/memory?action=search&query=${encodeURIComponent(searchQuery)}`)
      const data = await response.json()
      setSearchResults(data.results || [])
    } catch (error) {
      log.error('Search failed:', error)
      setSearchResults([])
    } finally {
      setIsSearching(false)
    }
  }

  const toggleFolder = (folderPath: string) => {
    const newExpanded = new Set(expandedFolders)
    if (newExpanded.has(folderPath)) {
      newExpanded.delete(folderPath)
    } else {
      newExpanded.add(folderPath)
    }
    setExpandedFolders(newExpanded)
  }

  const formatFileSize = (bytes?: number) => {
    if (!bytes || bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
  }

  const formatDate = (timestamp?: number) => {
    if (!timestamp) return ''
    return new Date(timestamp).toLocaleDateString()
  }

  // Enhanced editing functionality
  const startEditing = () => {
    setIsEditing(true)
    setEditedContent(memoryContent ?? '')
  }

  const cancelEditing = () => {
    setIsEditing(false)
    setEditedContent('')
  }

  const saveFile = async () => {
    if (!selectedMemoryFile) return

    setIsSaving(true)
    try {
      // Determine workspace from selected file
      const workspace = workspaces.find(ws => 
        selectedMemoryFile.startsWith(ws.path) || 
        ws.children?.some(f => f.path === selectedMemoryFile || selectedMemoryFile.startsWith(f.path))
      )

      const response = await fetch(`/api/memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'write',
          path: selectedMemoryFile,
          content: editedContent,
          workspace: workspace?.id
        }),
      })

      if (response.ok) {
        setMemoryContent(editedContent)
        setIsEditing(false)
        setEditedContent('')
      } else {
        const error = await response.json()
        alert(error.error || 'Failed to save file')
      }
    } catch (error) {
      log.error('Save failed:', error)
      alert('Network error occurred')
    } finally {
      setIsSaving(false)
    }
  }

  const renderFileTree = (files: MemoryFile[], depth = 0, workspaceId?: string) => {
    return files.map((file) => (
      <div key={file.path} style={{ marginLeft: depth * 16 }}>
        <div
          className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
            selectedMemoryFile === file.path
              ? 'bg-primary/20 text-primary'
              : 'hover:bg-secondary/50 text-foreground'
          }`}
          onClick={() => {
            if (file.type === 'directory') {
              toggleFolder(file.path)
            } else {
              loadFileContent(file.path, workspaceId)
            }
          }}
        >
          {file.type === 'directory' ? (
            <>
              <span className="text-muted-foreground">
                {expandedFolders.has(file.path) ? '📂' : '📁'}
              </span>
              <span className="font-medium">{file.name}</span>
            </>
          ) : (
            <>
              <span className="text-muted-foreground">📄</span>
              <span className="flex-1 truncate">{file.name}</span>
              {file.size && (
                <span className="text-xs text-muted-foreground">{formatFileSize(file.size)}</span>
              )}
            </>
          )}
        </div>
        {file.type === 'directory' && expandedFolders.has(file.path) && file.children && (
          <div className="mt-0.5">
            {renderFileTree(file.children, depth + 1, workspaceId)}
          </div>
        )}
      </div>
    ))
  }

  const displayWorkspaces = getDisplayFiles()

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Memory Browser</h1>
          <p className="text-sm text-muted-foreground">
            {workspaces.length} agent workspaces
          </p>
        </div>
        <div className="flex items-center gap-2">
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

          {/* Tab Filter */}
          <div className="flex bg-secondary rounded-lg p-0.5">
            <button
              onClick={() => setActiveTab('all')}
              className={`px-3 py-1 rounded-md text-sm transition-colors ${
                activeTab === 'all' ? 'bg-card shadow-sm' : 'text-muted-foreground'
              }`}
            >
              All
            </button>
            <button
              onClick={() => setActiveTab('daily')}
              className={`px-3 py-1 rounded-md text-sm transition-colors ${
                activeTab === 'daily' ? 'bg-card shadow-sm' : 'text-muted-foreground'
              }`}
            >
              Daily
            </button>
            <button
              onClick={() => setActiveTab('knowledge')}
              className={`px-3 py-1 rounded-md text-sm transition-colors ${
                activeTab === 'knowledge' ? 'bg-card shadow-sm' : 'text-muted-foreground'
              }`}
            >
              Knowledge
            </button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* File Tree Sidebar */}
        <div className="w-80 border-r border-border overflow-y-auto p-3">
          {/* Search */}
          <div className="mb-3">
            <div className="relative">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && searchFiles()}
                placeholder="Search memory files..."
                className="w-full px-3 py-2 pl-9 bg-secondary border border-border rounded-md text-sm"
              />
              <span className="absolute left-3 top-2.5 text-muted-foreground">🔍</span>
            </div>
          </div>

          {/* File Tree */}
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <div className="space-y-4">
              {displayWorkspaces.map((workspace) => (
                <div key={workspace.id} className="border border-border rounded-lg overflow-hidden">
                  {/* Workspace Header */}
                  <button
                    onClick={() => toggleFolder(workspace.path)}
                    className="w-full flex items-center gap-2 px-3 py-2 bg-secondary/50 hover:bg-secondary transition-colors"
                  >
                    <span>{expandedFolders.has(workspace.path) ? '📂' : '📁'}</span>
                    <span className="font-semibold">{workspace.emoji} {workspace.name}</span>
                    <span className="text-xs text-muted-foreground ml-auto">
                      {workspace.children?.length || 0} files
                    </span>
                  </button>
                  
                  {/* Workspace Files */}
                  {expandedFolders.has(workspace.path) && workspace.children && (
                    <div className="p-2 bg-card">
                      {renderFileTree(workspace.children, 0, workspace.id)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Content Viewer */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {selectedMemoryFile ? (
            <>
              {/* File Header */}
              <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-secondary/30">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">📄</span>
                  <span className="font-medium">{selectedMemoryFile}</span>
                </div>
                <div className="flex items-center gap-2">
                  {!isEditing ? (
                    <button
                      onClick={startEditing}
                      className="px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-sm hover:bg-primary/90 transition-colors"
                    >
                      Edit
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={cancelEditing}
                        className="px-3 py-1.5 bg-secondary text-foreground rounded-md text-sm hover:bg-secondary/80 transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={saveFile}
                        disabled={isSaving}
                        className="px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-sm hover:bg-primary/90 transition-colors disabled:opacity-50"
                      >
                        {isSaving ? 'Saving...' : 'Save'}
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* File Content */}
              <div className="flex-1 overflow-auto p-4">
                {isEditing ? (
                  <textarea
                    value={editedContent}
                    onChange={(e) => setEditedContent(e.target.value)}
                    className="w-full h-full min-h-[400px] p-4 bg-card border border-border rounded-lg font-mono text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
                    spellCheck={false}
                  />
                ) : (
                  <div className="prose prose-sm dark:prose-invert max-w-none">
                    <pre className="whitespace-pre-wrap font-mono text-sm bg-card p-4 rounded-lg border border-border">
                      {memoryContent}
                    </pre>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              <div className="text-center">
                <span className="text-4xl mb-4 block">📄</span>
                <p>Select a file to view its contents</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
