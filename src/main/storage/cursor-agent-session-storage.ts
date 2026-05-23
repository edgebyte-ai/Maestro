/**
 * Cursor Agent Session Storage Implementation
 *
 * This module implements the AgentSessionStorage interface for Cursor Agent CLI.
 * Cursor Agent's session storage location is not well-documented, so this
 * implementation provides a minimal placeholder that can be expanded when
 * the storage format is confirmed.
 *
 * Likely location: ~/.cursor/ (to be confirmed)
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

const LOG_CONTEXT = '[CursorAgentSessionStorage]';

/**
 * Get Cursor Agent session storage base directory
 * Note: This is a best-guess location; update when confirmed.
 */
function getCursorSessionsDir(): string {
	return path.join(os.homedir(), '.cursor', 'agent-sessions');
}

/**
 * Cursor Agent Session Storage Implementation
 *
 * Provides access to Cursor Agent's local session storage.
 * This is a placeholder implementation — the exact storage location
 * and format will be updated when Cursor Agent CLI documentation is available.
 */
export class CursorAgentSessionStorage extends BaseSessionStorage {
	readonly agentId: ToolType = 'cursor-agent';

	async listSessions(
		projectPath: string,
		sshConfig?: SshRemoteConfig
	): Promise<AgentSessionInfo[]> {
		if (sshConfig?.enabled) {
			return this.listSessionsRemote(projectPath, sshConfig);
		}

		const sessionsDir = getCursorSessionsDir();
		const sessions: AgentSessionInfo[] = [];

		try {
			const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
			const sessionFiles = entries.filter((e) => !e.isDirectory() && e.name.endsWith('.jsonl'));

			for (const file of sessionFiles) {
				const sessionId = file.name.replace('.jsonl', '');
				const filePath = path.join(sessionsDir, file.name);

				try {
					const stat = await fs.stat(filePath);
					const content = await fs.readFile(filePath, 'utf-8');
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
			logger.debug(`No Cursor Agent sessions directory found: ${sessionsDir}`, LOG_CONTEXT, {
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
		const remoteDir = '~/.cursor/agent-sessions';
		const dirResult = await readDirRemote(remoteDir, sshConfig);
		if (!dirResult.success || !dirResult.data) {
			return [];
		}

		const sessions: AgentSessionInfo[] = [];
		const sessionFiles = dirResult.data.filter((e) => !e.isDirectory && e.name.endsWith('.jsonl'));

		for (const file of sessionFiles) {
			const sessionId = file.name.replace('.jsonl', '');
			const filePath = `${remoteDir}/${file.name}`;

			try {
				const statResult = await statRemote(filePath, sshConfig);
				if (!statResult.success || !statResult.data) continue;

				const fileResult = await readFileRemote(filePath, sshConfig);
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
		const filePath = sshConfig?.enabled
			? `~/.cursor/agent-sessions/${sessionId}.jsonl`
			: path.join(getCursorSessionsDir(), `${sessionId}.jsonl`);

		let content: string;
		if (sshConfig?.enabled) {
			const result = await readFileRemote(filePath, sshConfig);
			if (!result.success || !result.data) {
				return { messages: [], total: 0, hasMore: false };
			}
			content = result.data;
		} else {
			try {
				content = await fs.readFile(filePath, 'utf-8');
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
		return path.join(getCursorSessionsDir(), `${sessionId}.jsonl`);
	}

	async deleteMessagePair(
		_projectPath: string,
		_sessionId: string,
		_userMessageUuid: string,
		_fallbackContent?: string,
		_sshConfig?: SshRemoteConfig
	): Promise<{ success: boolean; error?: string; linesRemoved?: number }> {
		return { success: false, error: 'Delete not supported for Cursor Agent sessions' };
	}

	protected async getSearchableMessages(
		sessionId: string,
		_projectPath: string,
		sshConfig?: SshRemoteConfig
	): Promise<SearchableMessage[]> {
		const filePath = sshConfig?.enabled
			? `~/.cursor/agent-sessions/${sessionId}.jsonl`
			: path.join(getCursorSessionsDir(), `${sessionId}.jsonl`);

		let content: string;
		if (sshConfig?.enabled) {
			const result = await readFileRemote(filePath, sshConfig);
			if (!result.success || !result.data) return [];
			content = result.data;
		} else {
			try {
				content = await fs.readFile(filePath, 'utf-8');
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
