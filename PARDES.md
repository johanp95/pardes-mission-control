# PaRDeS Mission Control — Development Notes

## Repository
- **Local:** `/Users/Development/metahaus/pardes-mission-control`
- **Fork:** `https://github.com/johanp95/pardes-mission-control`
- **Upstream:** `https://github.com/builderz-labs/mission-control`

## Running
```bash
cd /Users/Development/metahaus/pardes-mission-control
pnpm dev        # http://127.0.0.1:3000
```

Login: johan / pardes-dev-2026

## Architecture
Mission Control is a Next.js 16 dashboard with 28+ panels. We add:

### New Panels to Build
1. **🕸️ Graph Explorer** — Cognitron-AGE multi-graph navigation
   - List all accessible graphs (metaclaw, openclaw-dev, cortex, pardes-dev)
   - Cytoscape.js visualization with DSAIE coloring
   - Node/edge inspection panel
   - Cross-graph agent tracking

2. **🎨 Canvas** — A2UI protocol for agent visual output
   - WebSocket/SSE for live canvas updates
   - Typed card rendering (dashboard, topology, code, image)
   - Agent → human visual communication

3. **📝 Code Editor** — Monaco panel (optional, may use existing file editor)
   - File editing within the dashboard
   - LSP integration via VS Code extension adapter

4. **💻 Terminal** — xterm.js panel
   - Shared shell access for agents and humans
   - Session recording and replay

5. **🌐 Browser** — Embedded testing panel
   - URL bar, navigation, DevTools toggle
   - Agent-driven navigation and screenshots

## Integration Points

### Graph Explorer Data Flow
```
Browser Panel → API Route → AGE CLI → SQLite (AGE graphs)
                    ↓
              Cytoscape.js render
```

### API Routes to Add
- `GET /api/graphs` — List accessible graphs
- `GET /api/graphs/:id/nodes` — Search nodes
- `GET /api/graphs/:id/edges` — Get edges for nodes
- `GET /api/graphs/:id/schema` — Graph schema
- `GET /api/graphs/:id/health` — Graph health metrics

### Multi-Graph Navigation
Each graph gets its own AGE CLI connection:
- `metaclaw` — Orchestrator graph
- `openclaw-dev` — OpenClaw internals (30K nodes)
- `cortex` — Pipeline orchestration
- `pardes-dev` — This project

UI shows graph selector → loads graph → renders with Cytoscape.

## First Task
Implement Graph Explorer panel with:
1. Sidebar entry in navigation
2. Panel component with Cytoscape.js
3. API routes for AGE integration
4. Multi-graph selector dropdown
