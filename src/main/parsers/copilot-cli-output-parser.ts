/**
 * Copilot CLI Output Parser
 *
 * Parses stream-json output from GitHub Copilot CLI (`copilot -p --output-format stream-json`).
 * Copilot CLI outputs JSONL with message types similar to Claude Code:
 * - system/init: Session initialization
 * - assistant: Streaming text content (partial responses)
 * - result: Final complete response
 * - Messages may include session_id, usage stats
 *
 * @see https://github.com/github/copilot-cli
 */

import type { ToolType, AgentError } from '../../shared/types';
import type { AgentOutputParser, ParsedEvent } from './agent-output-parser';
import { getErrorPatterns, matchErrorPattern } from './error-patterns';

/**
 * Raw message structure from Copilot CLI stream-json output
 */
interface CopilotStreamMessage {
	type: 'system' | 'assistant' | 'result' | 'error';
	subtype?: 'init';
	session_id?: string;
	result?: string;
	message?: {
		role?: string;
		content?: string | Array<{ type: string; text?: string }>;
	};
	text?: string;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
	total_cost_usd?: number;
	error?: string | { message?: string };
}

/**
 * Type guard to validate parsed JSON matches CopilotStreamMessage structure
 */
function isCopilotStreamMessage(data: unknown): data is CopilotStreamMessage {
	if (typeof data !== 'object' || data === null) {
		return false;
	}
	const obj = data as Record<string, unknown>;
	return (
		typeof obj.type === 'string' && ['system', 'assistant', 'result', 'error'].includes(obj.type)
	);
}

/**
 * Copilot CLI Output Parser Implementation
 *
 * Transforms Copilot CLI's stream-json format into normalized ParsedEvents.
 */
export class CopilotCliOutputParser implements AgentOutputParser {
	readonly agentId: ToolType = 'copilot-cli';

	parseJsonLine(line: string): ParsedEvent | null {
		if (!line.trim()) {
			return null;
		}

		try {
			const parsed: unknown = JSON.parse(line);
			return (
				this.parseJsonObject(parsed) ?? {
					type: 'text' as const,
					text: line,
					isPartial: true,
					raw: parsed,
				}
			);
		} catch {
			if (line.trim()) {
				return {
					type: 'text',
					text: line,
					isPartial: true,
					raw: line,
				};
			}
			return null;
		}
	}

	parseJsonObject(parsed: unknown): ParsedEvent | null {
		if (!parsed || typeof parsed !== 'object') {
			return null;
		}

		if (!isCopilotStreamMessage(parsed)) {
			return null;
		}

		const data = parsed;

		switch (data.type) {
			case 'system':
				if (data.subtype === 'init') {
					return {
						type: 'init',
						sessionId: data.session_id,
						raw: data,
					};
				}
				return {
					type: 'system',
					sessionId: data.session_id,
					raw: data,
				};

			case 'assistant': {
				const text = this.extractText(data);
				if (text) {
					return {
						type: 'text',
						text,
						isPartial: true,
						sessionId: data.session_id,
						raw: data,
					};
				}
				return null;
			}

			case 'result':
				return {
					type: 'result',
					text: data.result || this.extractText(data) || '',
					sessionId: data.session_id,
					usage: this.extractUsageFromData(data),
					raw: data,
				};

			case 'error': {
				let errorText = '';
				if (typeof data.error === 'string') {
					errorText = data.error;
				} else if (data.error?.message) {
					errorText = data.error.message;
				}
				return {
					type: 'error',
					text: errorText,
					raw: data,
				};
			}

			default:
				return null;
		}
	}

	private extractText(data: CopilotStreamMessage): string {
		if (data.text) return data.text;
		if (data.message?.content) {
			if (typeof data.message.content === 'string') {
				return data.message.content;
			}
			if (Array.isArray(data.message.content)) {
				return data.message.content
					.filter((b) => b.type === 'text' && b.text)
					.map((b) => b.text || '')
					.join('');
			}
		}
		return '';
	}

	private extractUsageFromData(data: CopilotStreamMessage): ParsedEvent['usage'] | undefined {
		const usage = data.usage;
		if (!usage) return undefined;

		return {
			inputTokens: usage.input_tokens || 0,
			outputTokens: usage.output_tokens || 0,
			cacheReadTokens: usage.cache_read_input_tokens || 0,
			cacheCreationTokens: usage.cache_creation_input_tokens || 0,
			costUsd: data.total_cost_usd,
		};
	}

	isResultMessage(event: ParsedEvent): boolean {
		if (event.type === 'result') return true;
		const raw = event.raw as CopilotStreamMessage | undefined;
		return raw?.type === 'result';
	}

	extractSessionId(event: ParsedEvent): string | null {
		if (event.sessionId) return event.sessionId;
		const raw = event.raw as CopilotStreamMessage | undefined;
		return raw?.session_id || null;
	}

	extractUsage(event: ParsedEvent): ParsedEvent['usage'] | null {
		return event.usage || null;
	}

	extractSlashCommands(_event: ParsedEvent): string[] | null {
		return null;
	}

	detectErrorFromLine(line: string): AgentError | null {
		if (!line.trim()) {
			return null;
		}

		try {
			const error = this.detectErrorFromParsed(JSON.parse(line));
			if (error) {
				error.raw = { ...(error.raw as Record<string, unknown>), errorLine: line };
			}
			return error;
		} catch {
			return null;
		}
	}

	detectErrorFromParsed(parsed: unknown): AgentError | null {
		if (!parsed || typeof parsed !== 'object') {
			return null;
		}

		const obj = parsed as CopilotStreamMessage;
		let errorText: string | null = null;

		if (obj.type === 'error') {
			if (typeof obj.error === 'string') {
				errorText = obj.error;
			} else if (obj.error?.message) {
				errorText = obj.error.message;
			}
		}

		if (!errorText) {
			return null;
		}

		const patterns = getErrorPatterns(this.agentId);
		const match = matchErrorPattern(patterns, errorText);

		if (match) {
			return {
				type: match.type,
				message: match.message,
				recoverable: match.recoverable,
				agentId: this.agentId,
				timestamp: Date.now(),
				parsedJson: parsed,
			};
		}

		return {
			type: 'unknown',
			message: errorText,
			recoverable: true,
			agentId: this.agentId,
			timestamp: Date.now(),
			parsedJson: parsed,
		};
	}

	detectErrorFromExit(exitCode: number, stderr: string, stdout: string): AgentError | null {
		if (exitCode === 0) {
			return null;
		}

		const combined = `${stderr}\n${stdout}`;
		const patterns = getErrorPatterns(this.agentId);
		const match = matchErrorPattern(patterns, combined);

		if (match) {
			return {
				type: match.type,
				message: match.message,
				recoverable: match.recoverable,
				agentId: this.agentId,
				timestamp: Date.now(),
				raw: { exitCode, stderr, stdout },
			};
		}

		const stderrPreview = stderr?.trim()
			? `: ${stderr.trim().split('\n')[0].substring(0, 200)}`
			: '';
		return {
			type: 'agent_crashed',
			message: `Copilot CLI exited with code ${exitCode}${stderrPreview}`,
			recoverable: true,
			agentId: this.agentId,
			timestamp: Date.now(),
			raw: { exitCode, stderr, stdout },
		};
	}
}
