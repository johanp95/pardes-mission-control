# PaRDeS Mission Control — Critical Architectural Issues

**Date:** 2026-03-05  
**Status:** BLOCKING — These must be fixed before building new features

---

## 🔴 CRITICAL ISSUE #1: Single-Workspace Architecture

### Problem
Mission Control is hardcoded to look at **ONE workspace only** (`OPENCLAW_WORKSPACE_DIR` or derived from `OPENCLAW_HOME`), but the system has **23 agent workspaces**.

### Current Behavior
```typescript
// src/lib/config.ts
const openclawWorkspaceDir = process.env.OPENCLAW_WORKSPACE_DIR || 
  (openclawStateDir ? path.join(openclawStateDir, 'workspace') : '')
```

Only reads from `/Users/Development/.openclaw/workspace` (Metaclaw's workspace).

### Actual Workspaces (23 total)
```
workspace                          # Metaclaw (main)
workspace-architecture             # Architect agent
workspace-canvas-architect         # Lumen
workspace-cognitron-age            # AGE Dev
workspace-cognitron-age-worker     # AGE Workers
workspace-cognitron-cortex         # Cortex Dev
workspace-cognitron-cortex-worker  # Cortex Workers
workspace-coherent-dev             # Coherent Dev
workspace-coherent-dev-worker      # Coherent Workers
workspace-director                 # Director agent
workspace-graph-consultant         # Archivist
workspace-implementation           # Implementor agent
workspace-metaclaw-worker          # Metaclaw Workers
workspace-openclaw-dev             # OpenClaw Dev
workspace-pardes-dev               # PaRDeS Dev (this agent)
workspace-protectron-dev           # Protectron Dev
workspace-protectron-dev-worker    # Protectron Workers
workspace-sam                      # Sam agent
workspace-strategy                 # Strategist agent
workspace-tronlabs-web             # TRON Labs Web
workspace-zeph                     # Zeph agent
```

### Impact
- **Memory browser** only shows Metaclaw's memory files
- **Agent SOUL files** only editable for one workspace
- **Graph references** don't account for multi-agent graph ownership
- **Agent context** is isolated per-workspace but UI shows unified view

### Fix Required
1. Change config to discover ALL workspace directories
2. Index workspaces by agent ID
3. Update Memory Browser to show workspace selector
4. Track which agent owns which workspace
5. Cross-workspace search capabilities

---

## 🔴 CRITICAL ISSUE #2: Hardcoded Model Catalog

### Problem
Model options in spawn panel are **hardcoded** and don't match actual available models from `openclaw.json`.

### Current Code (WRONG)
```typescript
// src/lib/models.ts — HARDCODED
export const MODEL_CATALOG: ModelConfig[] = [
  { alias: 'haiku', name: 'anthropic/claude-3-5-haiku-latest', provider: 'anthropic', ... },
  { alias: 'sonnet', name: 'anthropic/claude-sonnet-4-20250514', provider: 'anthropic', ... },
  { alias: 'opus', name: 'anthropic/claude-opus-4-5', provider: 'anthropic', ... },
  { alias: 'deepseek', name: 'ollama/deepseek-r1:14b', provider: 'ollama', ... },
  // ... only 8 models total
]
```

### Actual Models in openclaw.json
```json
{
  "moonshot/kimi-k2.5": { "alias": "Kimi", "contextWindow": 131072 },
  "moonshot/moonshot-v1-8k": { "contextWindow": 8192 },
  "moonshot/moonshot-v1-32k": { "contextWindow": 32768 },
  "moonshot/moonshot-v1-128k": { "contextWindow": 131072 }
}
```

Plus anthropic, openai-codex, and other providers configured.

### Impact
- Spawn panel shows invalid model options
- Cost calculations are wrong
- Users can't spawn with actually configured models
- Model aliases don't match openclaw.json

### Fix Required
1. Parse `openclaw.json` models section at runtime
2. Build dynamic model catalog from config
3. Cache with file watcher for hot reload
4. Remove hardcoded MODEL_CATALOG entirely

---

## 🔴 CRITICAL ISSUE #3: Pipeline Panel Not Wired

### Problem
Pipeline infrastructure exists but **not accessible in UI**.

### Evidence
- File: `src/components/panels/pipeline-tab.tsx` exists (132 lines)
- API: `/api/pipelines` exists with full CRUD
- Database: `workflow_pipelines`, `workflow_templates`, `pipeline_runs` tables exist
- **Missing:** No route in `ContentRouter`, no NavRail entry

### Current page.tsx switch statement:
```typescript
// Missing: case 'pipelines':
case 'super-admin':
  return <SuperAdminPanel />
case 'workspaces':
  return <SuperAdminPanel />
default:
  return <Dashboard />
```

### Fix Required
1. Add `'pipelines'` to NavRail in appropriate group
2. Add `case 'pipelines': return <PipelineTab />` to ContentRouter
3. Test end-to-end pipeline creation and execution

---

## 🟡 MAJOR ISSUE #4: Gateway Health Check Broken

### Problem
Gateway status always shows "unknown".

### Evidence
```bash
curl http://127.0.0.1:3000/api/gateways/health
# Returns: (empty)
```

Database shows:
```json
{"status": "unknown", "last_seen": null, "latency": null}
```

### Root Cause
`/api/gateways/health` route exists but likely:
1. Doesn't actually ping the gateway WebSocket
2. Or returns empty on error instead of status

### Fix Required
1. Implement actual health check via WebSocket ping
2. Store latency metrics
3. Update DB with actual status

---

## 🟡 MAJOR ISSUE #5: Empty Data Throughout

### Problem
Many features have schema and UI but **no actual data flow**.

| Feature | Schema | UI | Data | Status |
|---------|--------|-----|------|--------|
| Tasks | ✅ | ✅ | ❌ Empty | Never created |
| Activities | ✅ | ✅ | ❌ Empty | Never recorded |
| Tokens | ✅ | ✅ | ❌ Empty | Gateway not feeding data |
| Audit log | ✅ | ✅ | ❌ Empty | Events not logged |
| Notifications | ✅ | ✅ | ❌ Empty | Nothing generates them |

### Root Causes
1. **No task creation flow** — UI exists but no way to create tasks
2. **Gateway events not persisted** — WebSocket receives but doesn't write to DB
3. **Token usage not tracked** — Gateway reports tokens but MC doesn't capture
4. **Audit events not fired** — Actions happen without audit logging

### Fix Required
1. Add "Create Task" button to Task Board
2. Wire gateway events to DB persistence layer
3. Capture token_usage from gateway session updates
4. Add audit logging to all mutations

---

## 🟡 MAJOR ISSUE #6: Agent Sync is One-Way

### Problem
Agent sync (`/api/agents/sync`) reads from `openclaw.json` but:
1. Doesn't detect workspace changes
2. Doesn't track agent-to-workspace mapping
3. Updates are overwrite-only, no merge strategy

### Current Sync Logic
```typescript
// src/lib/agent-sync.ts
const agentsInConfig: OpenClawAgent[] = config.agents?.list || []
// Only reads from config, doesn't discover workspaces
```

### Missing
- Workspace discovery per agent
- Agent capability tracking
- Dynamic agent registration (new workspaces)

---

## 📋 COMPREHENSIVE FIX ROADMAP

### Phase 1: Foundation Fixes (Required First)
1. **✅ DONE: Multi-workspace discovery**
   - ~~Scan `.openclaw/workspace-*` directories~~
   - ~~Map agents to workspaces~~
   - ~~Update Memory Browser with workspace selector~~
   - **Status:** Complete - discovers 21 workspaces, unified tree API working

2. **✅ DONE: Dynamic model catalog**
   - ~~Parse `openclaw.json` models at startup~~
   - ~~Replace hardcoded MODEL_CATALOG~~
   - **Status:** Complete - API returns 4 moonshot models, spawn panel uses real config

3. **Fix gateway health check**
   - Implement actual WebSocket ping
   - Store latency in DB
   - Update UI with real status

### Phase 2: Data Flow Fixes
4. **Task creation workflow**
   - Add "New Task" button to Kanban
   - Wire create API to UI
   - Test full task lifecycle

5. **Gateway event persistence**
   - Write WebSocket events to activities table
   - Capture token usage
   - Generate notifications

6. **Wire Pipeline panel**
   - Add to NavRail
   - Add to ContentRouter
   - Test pipeline execution

### Phase 3: Feature Completeness
7. **GitHub sync activation**
   - Configure GITHUB_TOKEN
   - Test issue → task sync

8. **Audit logging**
   - Add audit hooks to all mutations
   - Verify audit trail population

9. **Multi-workspace memory**
   - Cross-workspace file search
   - Unified memory browser

### Phase 4: PaRDeS Extensions (Only After Above)
10. **Graph Explorer** (D3.js)
11. **Canvas Panel** (A2UI)
12. **Cognitron/Cortex integration**

---

## DECISION NEEDED

These aren't minor bugs — they're **architectural gaps**. We have two options:

**Option A: Fix First** (Recommended)
- Spend 2-3 sessions fixing foundation issues
- Then build Graph Explorer on solid ground
- Result: Robust, maintainable system

**Option B: Patch Around**
- Hardcode workspace list for now
- Add quick model override
- Build Graph Explorer immediately
- Result: Technical debt accumulates

**My recommendation:** Option A. The foundation issues will bite us repeatedly if not fixed.

---

## IMMEDIATE ACTIONS

If you want to proceed with fixes, I can:

1. **Start with multi-workspace discovery** — update config to scan all 23 workspaces
2. **Fix model catalog** — parse openclaw.json dynamically  
3. **Wire pipeline panel** — 30-minute fix

Which should I prioritize first?
