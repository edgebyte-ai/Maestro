/**
 * Cursor Agent Output Parser
 *
 * Parses stream-json output from Cursor Agent CLI (`cursor-agent --print --output-format stream-json`).
 * Cursor Agent outputs JSONL with message types:
 * - system/init: Session initialization
 * - assistant: Streaming text content (partial responses)
 * - result: Final complete response
 * - Messages may include session_id, usage stats
 */

import type { ToolType, AgentError } from '../../shared/types';
import type { AgentOutputParser, ParsedEvent } from './agent-output-parser';
import { getErrorPatterns, matchErrorPattern } from './error-patterns';

/**
 * Raw message structure from Cursor Agent stream-json output
 */
interface CursorStreamMessage {
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
	};
	error?: string | { message?: string };
}

/**
 * Type guard to validate parsed JSON matches CursorStreamMessage structure
 */
function isCursorStreamMessage(data: unknown): data is CursorStreamMessage {
	if (typeof data !== 'object' || data === null) {
		return false;
	}
	const obj = data as Record<string, unknown>;
	return (
		typeof obj.type === 'string' && ['system', 'assistant', 'result', 'error'].includes(obj.type)
	);
}

/**
 * Cursor Agent Output Parser Implementation
 *
 * Transforms Cursor Agent's stream-json format into normalized ParsedEvents.
 */
export class CursorAgentOutputParser implements AgentOutputParser {
	readonly agentId: ToolType = 'cursor-agent';

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

		if (!isCursorStreamMessage(parsed)) {
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

	private extractText(data: CursorStreamMessage): string {
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

	private extractUsageFromData(data: CursorStreamMessage): ParsedEvent['usage'] | undefined {
		const usage = data.usage;
		if (!usage) return undefined;

		return {
			inputTokens: usage.input_tokens || 0,
			outputTokens: usage.output_tokens || 0,
		};
	}

	isResultMessage(event: ParsedEvent): boolean {
		if (event.type === 'result') return true;
		const raw = event.raw as CursorStreamMessage | undefined;
		return raw?.type === 'result';
	}

	extractSessionId(event: ParsedEvent): string | null {
		if (event.sessionId) return event.sessionId;
		const raw = event.raw as CursorStreamMessage | undefined;
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

		const obj = parsed as CursorStreamMessage;
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
			message: `Cursor Agent exited with code ${exitCode}${stderrPreview}`,
			recoverable: true,
			agentId: this.agentId,
			timestamp: Date.now(),
			raw: { exitCode, stderr, stdout },
		};
	}
}
