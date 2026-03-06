import { NextRequest, NextResponse } from 'next/server'
import { runOpenClaw } from '@/lib/command'
import { requireRole } from '@/lib/auth'
import { config } from '@/lib/config'
import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import { heavyLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { validateBody, spawnAgentSchema } from '@/lib/validation'

/**
 * Spawn an agent by sending a message via `openclaw agent`.
 *
 * This creates (or resumes) an agent session on the Gateway and delivers
 * the task message.  The Gateway then runs the agent turn with the
 * configured model.
 */
async function runAgentSpawn(opts: {
  agentId: string
  task: string
  model?: string
  timeout?: number
}) {
  const args: string[] = [
    'agent',
    '--agent', opts.agentId,
    '--message', opts.task,
    '--json',
  ]
  if (opts.timeout) {
    args.push('--timeout', String(opts.timeout))
  }
  // Note: model selection is handled by the agent's configured default_model
  // in openclaw.json.  The `openclaw agent` CLI doesn't accept a --model flag
  // for overriding at spawn-time; model config lives in agent defaults.
  return runOpenClaw(args, { timeoutMs: (opts.timeout || 300) * 1000 + 5000 })
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = heavyLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const result = await validateBody(request, spawnAgentSchema)
    if ('error' in result) return result.error
    const { task, model, label, timeoutSeconds } = result.data

    const spawnId = `spawn-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

    // `label` doubles as agent id in the UI.  Map common display names
    // to their openclaw.json agent ids.
    const AGENT_ALIASES: Record<string, string> = {
      'Lumen': 'canvas-architect',
      'Metaclaw': 'main',
      'PaRDeS Dev': 'pardes-dev',
      'OpenClaw Dev': 'openclaw-dev',
      'Cognitron-AGE Dev': 'cognitron-age',
      'Cortex Dev': 'cognitron-cortex',
      'Protectron Dev': 'protectron-dev',
      'Archivist': 'graph-consultant',
    }

    const agentId = AGENT_ALIASES[label] || label.toLowerCase().replace(/\s+/g, '-')

    try {
      const { stdout, stderr } = await runAgentSpawn({
        agentId,
        task,
        model,
        timeout: timeoutSeconds,
      })

      // Try to extract session key from JSON output
      let sessionInfo: string | null = null
      try {
        const parsed = JSON.parse(stdout)
        sessionInfo = parsed.sessionKey || parsed.session_key || parsed.key || null
      } catch {
        // Try regex fallback
        const match = stdout.match(/agent:[a-z0-9_-]+:[a-z0-9_-]+/i)
        if (match) sessionInfo = match[0]
      }

      return NextResponse.json({
        success: true,
        spawnId,
        sessionInfo,
        agentId,
        task,
        model,
        label,
        timeoutSeconds,
        createdAt: Date.now(),
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      })
    } catch (execError: any) {
      logger.error({ err: execError, agentId }, 'Spawn execution error')

      return NextResponse.json({
        success: false,
        spawnId,
        error: execError.message || 'Failed to spawn agent',
        agentId,
        task,
        model,
        label,
        timeoutSeconds,
        createdAt: Date.now(),
      }, { status: 500 })
    }
  } catch (error) {
    logger.error({ err: error }, 'Spawn API error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── GET: Spawn history (read from logs) ─────────────────────────
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const { searchParams } = new URL(request.url)
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200)

    try {
      if (!config.logsDir) {
        return NextResponse.json({ history: [] })
      }

      const files = await readdir(config.logsDir)
      const logFiles = await Promise.all(
        files
          .filter((file) => file.endsWith('.log'))
          .map(async (file) => {
            const fullPath = join(config.logsDir, file)
            const stats = await stat(fullPath)
            return { file, fullPath, mtime: stats.mtime.getTime() }
          })
      )

      const recentLogs = logFiles
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 5)

      const lines: string[] = []
      for (const log of recentLogs) {
        const content = await readFile(log.fullPath, 'utf-8')
        const matched = content
          .split('\n')
          .filter((line) => line.includes('sessions_spawn') || line.includes('agent --agent'))
        lines.push(...matched)
      }

      const spawnHistory = lines
        .slice(-limit)
        .map((line, index) => {
          try {
            const timestampMatch = line.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/)
            const modelMatch = line.match(/model[:\s]+"([^"]+)"/)
            const taskMatch = line.match(/task[:\s]+"([^"]+)"/)
            return {
              id: `history-${Date.now()}-${index}`,
              timestamp: timestampMatch ? new Date(timestampMatch[1]).getTime() : Date.now(),
              model: modelMatch ? modelMatch[1] : 'unknown',
              task: taskMatch ? taskMatch[1] : 'unknown',
              status: 'completed',
              line: line.trim(),
            }
          } catch { return null }
        })
        .filter(Boolean)

      return NextResponse.json({ history: spawnHistory })
    } catch {
      return NextResponse.json({ history: [] })
    }
  } catch (error) {
    logger.error({ err: error }, 'Spawn history API error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
