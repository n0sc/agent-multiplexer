/**
 * LaunchDialog — Runtime override dialog shown when launching a workspace.
 *
 * Instead of spawning a session with fixed defaults, this dialog lets the user
 * override model, tools, skills, and permissions at launch time — all translated
 * to agent-specific CLI flags by the backend.
 *
 * Inspired by the Anthropic roadtrip planner's `agent_with_overrides` pattern:
 * one stored workspace, per-session overrides, no duplicates.
 *
 * Empty fields = use the agent's default. The dialog pre-fills common values
 * for each agent type.
 */

import { useState } from 'react'
import type { Workspace, SessionOverrides } from '../shared/protocol'

interface LaunchDialogProps {
  workspace: Workspace
  onLaunch: (overrides: SessionOverrides) => void
  onClose: () => void
}

/** Suggested models per agent type, shown as datalist options */
const MODEL_SUGGESTIONS: Record<string, string[]> = {
  claude: [
    'sonnet',
    'opus',
    'haiku',
  ],
  hermes: [
    'anthropic/claude-sonnet-4',
    'anthropic/claude-opus-4',
    'openai/gpt-4o',
    'google/gemini-2.0-flash-exp:free',
    'deepseek/deepseek-chat',
  ],
}

const PERMISSION_MODES: Record<string, { value: string; label: string }[]> = {
  claude: [
    { value: '', label: 'Default (prompt for everything)' },
    { value: 'acceptEdits', label: 'Accept edits (auto-approve file writes)' },
    { value: 'auto', label: 'Auto (auto-approve safe operations)' },
    { value: 'bypassPermissions', label: 'Bypass all (dangerous)' },
  ],
  hermes: [
    { value: '', label: 'Default (prompt for dangerous commands)' },
    { value: 'safe', label: 'Safe mode (most restricted)' },
    { value: 'yolo', label: 'YOLO (bypass all approvals)' },
  ],
  shell: [],
}

export function LaunchDialog({ workspace, onLaunch, onClose }: LaunchDialogProps) {
  const [model, setModel] = useState('')
  const [tools, setTools] = useState('')
  const [skills, setSkills] = useState('')
  const [provider, setProvider] = useState('')
  const [permissionMode, setPermissionMode] = useState('')
  const [maxTurns, setMaxTurns] = useState('')

  const agentType = workspace.agentType
  const isClaude = agentType === 'claude'
  const isHermes = agentType === 'hermes'
  const isShell = agentType === 'shell'

  const handleLaunch = () => {
    const overrides: SessionOverrides = {}

    if (model.trim()) overrides.model = model.trim()
    if (tools.trim()) overrides.tools = tools.trim()
    if (isHermes && skills.trim()) overrides.skills = skills.trim()
    if (isHermes && provider.trim()) overrides.provider = provider.trim()
    if (isHermes && maxTurns.trim()) overrides.maxTurns = parseInt(maxTurns.trim(), 10)
    if (permissionMode) overrides.permissionMode = permissionMode

    onLaunch(overrides)
    onClose()
  }

  const permissionOptions = PERMISSION_MODES[agentType] || []

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal launch-dialog" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Launch: {workspace.name}</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="launch-workspace-info">
            <span className="launch-workspace-icon">{workspace.icon || '📁'}</span>
            <span className="launch-workspace-name">{workspace.name}</span>
            <span className="launch-workspace-type">{agentType}</span>
            <span className="launch-workspace-cwd">{workspace.cwd.replace(/^\/Users\/[^/]+/, '~')}</span>
          </div>

          {isShell ? (
            <div className="launch-empty">
              No overrides available for shell sessions.
              <br />
              Click Launch to start the terminal.
            </div>
          ) : (
            <>
              {/* Model */}
              <div className="launch-field">
                <label htmlFor="override-model">Model</label>
                <input
                  id="override-model"
                  type="text"
                  list="model-suggestions"
                  value={model}
                  onChange={e => setModel(e.target.value)}
                  placeholder={isClaude ? 'sonnet, opus, haiku…' : 'anthropic/claude-sonnet-4…'}
                  className="launch-input"
                />
                <datalist id="model-suggestions">
                  {(MODEL_SUGGESTIONS[agentType] || []).map(m => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>

              {/* Tools */}
              <div className="launch-field">
                <label htmlFor="override-tools">
                  {isClaude ? 'Allowed tools' : 'Toolsets'}
                </label>
                <input
                  id="override-tools"
                  type="text"
                  value={tools}
                  onChange={e => setTools(e.target.value)}
                  placeholder={isClaude ? 'Edit,Bash,Read,Write…' : 'terminal,web,file,search…'}
                  className="launch-input"
                />
              </div>

              {/* Hermes-only fields */}
              {isHermes && (
                <>
                  <div className="launch-field">
                    <label htmlFor="override-skills">Preload skills</label>
                    <input
                      id="override-skills"
                      type="text"
                      value={skills}
                      onChange={e => setSkills(e.target.value)}
                      placeholder="github,obsidian,arxiv…"
                      className="launch-input"
                    />
                  </div>

                  <div className="launch-field">
                    <label htmlFor="override-provider">Provider</label>
                    <input
                      id="override-provider"
                      type="text"
                      value={provider}
                      onChange={e => setProvider(e.target.value)}
                      placeholder="auto, openrouter, anthropic…"
                      className="launch-input"
                    />
                  </div>

                  <div className="launch-field">
                    <label htmlFor="override-maxturns">Max turns</label>
                    <input
                      id="override-maxturns"
                      type="number"
                      value={maxTurns}
                      onChange={e => setMaxTurns(e.target.value)}
                      placeholder="90 (default)"
                      className="launch-input launch-input-narrow"
                    />
                  </div>
                </>
              )}

              {/* Permission mode */}
              {permissionOptions.length > 0 && (
                <div className="launch-field">
                  <label htmlFor="override-permission">Permission mode</label>
                  <select
                    id="override-permission"
                    value={permissionMode}
                    onChange={e => setPermissionMode(e.target.value)}
                    className="launch-select"
                  >
                    {permissionOptions.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Instructions preview (read-only, from workspace) */}
              {workspace.instructions && (
                <div className="launch-field">
                  <label>Instructions (from workspace)</label>
                  <div className="launch-instructions-preview">
                    {workspace.instructions.slice(0, 200)}
                    {workspace.instructions.length > 200 && '…'}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleLaunch}>
            🚀 Launch {workspace.name}
          </button>
        </div>
      </div>
    </div>
  )
}
