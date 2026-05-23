/**
 * Copilot CLI Session Storage Implementation
 *
 * This module implements the AgentSessionStorage interface for GitHub Copilot CLI.
 * Copilot CLI stores sessions in ~/.copilot/session-state/
 *
 * Directory structure:
 * - ~/.copilot/session-state/<session-id>/events.jsonl - Session events
 *
 * JSONL format (stream-json events):
 * - Each line is a JSON object with type, session_id, and content fields
 */

import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { logger } from '../utils/logger';
import { readDirRemote, readFileRemote, statRemote } from '../utils/remote-fs';
import { BaseSessionStorage, type SearchableMessage } from './base-session-storage';
import type {
	AgentSessionInfo,
	SessionMessagesResult,
	SessionReadOptions,
	SessionMessage,
} from '../agents';
import type { ToolType, SshRemoteConfig } from '../../shared/types';

const LOG_CONTEXT = '[CopilotCliSessionStorage]';

/**
 * Get Copilot CLI session storage base directory
 */
function getCopilotSessionsDir(): string {
	return path.join(os.homedir(), '.copilot', 'session-state');
}

/**
 * Copilot CLI Session Storage Implementation
 *
 * Provides access to Copilot CLI's local session storage at ~/.copilot/session-state/
 */
export class CopilotCliSessionStorage extends BaseSessionStorage {
	readonly agentId: ToolType = 'copilot-cli';

	async listSessions(
		projectPath: string,
		sshConfig?: SshRemoteConfig
	): Promise<AgentSessionInfo[]> {
		if (sshConfig?.enabled) {
			return this.listSessionsRemote(projectPath, sshConfig);
		}

		const sessionsDir = getCopilotSessionsDir();
		const sessions: AgentSessionInfo[] = [];

		try {
			const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
			const sessionDirs = entries.filter((e) => e.isDirectory());

			for (const dir of sessionDirs) {
				const sessionId = dir.name;
				const eventsPath = path.join(sessionsDir, sessionId, 'events.jsonl');

				try {
					const stat = await fs.stat(eventsPath);
					const content = await fs.readFile(eventsPath, 'utf-8');
					const lines = content
						.trim()
						.split('\n')
						.filter((l) => l.trim());

					let firstMessage = '';
					for (const line of lines) {
						try {
							const parsed = JSON.parse(line);
							if (parsed.type === 'assistant' || parsed.type === 'result') {
								const text = parsed.text || parsed.result || '';
								if (text.trim()) {
									firstMessage = text.slice(0, 200);
									break;
								}
							}
						} catch {
							continue;
						}
					}

					sessions.push({
						sessionId,
						projectPath,
						timestamp: stat.birthtime.toISOString(),
						modifiedAt: stat.mtime.toISOString(),
						firstMessage,
						messageCount: lines.length,
						sizeBytes: 0,
						inputTokens: 0,
						outputTokens: 0,
						cacheReadTokens: 0,
						cacheCreationTokens: 0,
						durationSeconds: 0,
					});
				} catch {
					continue;
				}
			}
		} catch (error) {
			logger.debug(`No Copilot CLI sessions directory found: ${sessionsDir}`, LOG_CONTEXT, {
				error,
			});
		}

		return sessions.sort(
			(a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime()
		);
	}

	private async listSessionsRemote(
		projectPath: string,
		sshConfig: SshRemoteConfig
	): Promise<AgentSessionInfo[]> {
		const remoteDir = '~/.copilot/session-state';
		const dirResult = await readDirRemote(remoteDir, sshConfig);
		if (!dirResult.success || !dirResult.data) {
			return [];
		}

		const sessions: AgentSessionInfo[] = [];
		const sessionDirs = dirResult.data.filter((e) => e.isDirectory);

		for (const dir of sessionDirs) {
			const sessionId = dir.name;
			const eventsPath = `${remoteDir}/${sessionId}/events.jsonl`;

			try {
				const statResult = await statRemote(eventsPath, sshConfig);
				if (!statResult.success || !statResult.data) continue;

				const fileResult = await readFileRemote(eventsPath, sshConfig);
				if (!fileResult.success || !fileResult.data) continue;

				const lines = fileResult.data
					.trim()
					.split('\n')
					.filter((l) => l.trim());

				let firstMessage = '';
				for (const line of lines) {
					try {
						const parsed = JSON.parse(line);
						if (parsed.type === 'assistant' || parsed.type === 'result') {
							const text = parsed.text || parsed.result || '';
							if (text.trim()) {
								firstMessage = text.slice(0, 200);
								break;
							}
						}
					} catch {
						continue;
					}
				}

				sessions.push({
					sessionId,
					projectPath,
					timestamp: new Date(statResult.data.mtime).toISOString(),
					modifiedAt: new Date(statResult.data.mtime).toISOString(),
					firstMessage,
					messageCount: lines.length,
					sizeBytes: 0,
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					durationSeconds: 0,
				});
			} catch {
				continue;
			}
		}

		return sessions.sort(
			(a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime()
		);
	}

	async readSessionMessages(
		_projectPath: string,
		sessionId: string,
		_options?: SessionReadOptions,
		sshConfig?: SshRemoteConfig
	): Promise<SessionMessagesResult> {
		const eventsPath = sshConfig?.enabled
			? `~/.copilot/session-state/${sessionId}/events.jsonl`
			: path.join(getCopilotSessionsDir(), sessionId, 'events.jsonl');

		let content: string;
		if (sshConfig?.enabled) {
			const result = await readFileRemote(eventsPath, sshConfig);
			if (!result.success || !result.data) {
				return { messages: [], total: 0, hasMore: false };
			}
			content = result.data;
		} else {
			try {
				content = await fs.readFile(eventsPath, 'utf-8');
			} catch {
				return { messages: [], total: 0, hasMore: false };
			}
		}

		const lines = content
			.trim()
			.split('\n')
			.filter((l) => l.trim());
		const messages: SessionMessage[] = [];

		for (const line of lines) {
			try {
				const parsed = JSON.parse(line);
				if (parsed.type === 'assistant' || parsed.type === 'result') {
					messages.push({
						type: parsed.type,
						role: 'assistant',
						content: parsed.text || parsed.result || '',
						timestamp: new Date().toISOString(),
						uuid: parsed.session_id || sessionId,
					});
				}
			} catch {
				continue;
			}
		}

		return { messages, total: messages.length, hasMore: false };
	}

	getSessionPath(
		_projectPath: string,
		sessionId: string,
		_sshConfig?: SshRemoteConfig
	): string | null {
		return path.join(getCopilotSessionsDir(), sessionId, 'events.jsonl');
	}

	async deleteMessagePair(
		_projectPath: string,
		_sessionId: string,
		_userMessageUuid: string,
		_fallbackContent?: string,
		_sshConfig?: SshRemoteConfig
	): Promise<{ success: boolean; error?: string; linesRemoved?: number }> {
		return { success: false, error: 'Delete not supported for Copilot CLI sessions' };
	}

	protected async getSearchableMessages(
		sessionId: string,
		_projectPath: string,
		sshConfig?: SshRemoteConfig
	): Promise<SearchableMessage[]> {
		const eventsPath = sshConfig?.enabled
			? `~/.copilot/session-state/${sessionId}/events.jsonl`
			: path.join(getCopilotSessionsDir(), sessionId, 'events.jsonl');

		let content: string;
		if (sshConfig?.enabled) {
			const result = await readFileRemote(eventsPath, sshConfig);
			if (!result.success || !result.data) return [];
			content = result.data;
		} else {
			try {
				content = await fs.readFile(eventsPath, 'utf-8');
			} catch {
				return [];
			}
		}

		const lines = content
			.trim()
			.split('\n')
			.filter((l) => l.trim());
		const messages: SearchableMessage[] = [];

		for (const line of lines) {
			try {
				const parsed = JSON.parse(line);
				if (parsed.type === 'assistant' || parsed.type === 'result') {
					const text = parsed.text || parsed.result || '';
					if (text.trim()) {
						messages.push({ role: 'assistant', textContent: text });
					}
				}
			} catch {
				continue;
			}
		}

		return messages;
	}
}
