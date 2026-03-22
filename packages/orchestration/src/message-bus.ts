/**
 * MessageBus — comunicação inter-agente via issues do Paperclip.
 *
 * Agentes comunicam-se postando comentários em issues. O MessageBus abstrai
 * esse mecanismo, adicionando suporte a:
 * - envio de mensagens estruturadas (JSON em bloco de código)
 * - leitura incremental de mensagens novas
 * - @-mention para acordar outro agente
 * - broadcast para todos os participantes de uma issue
 */

import type { PaperclipRawClient } from "./client.js";
import type { CommentSummary, PostMessageInput } from "./types.js";

interface RawComment {
  id: string;
  issueId: string;
  body: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdAt: string;
}

export interface StructuredMessage<T = unknown> {
  type: string;
  payload: T;
  fromAgentId?: string;
  toAgentId?: string;
}

export class MessageBus {
  constructor(private readonly client: PaperclipRawClient) {}

  /**
   * Posta um comentário de texto livre em uma issue.
   */
  async post(input: PostMessageInput): Promise<CommentSummary> {
    const raw = await this.client.post<RawComment>(
      `/api/issues/${input.issueId}/comments`,
      { body: input.body },
    );
    return normalizeComment(raw);
  }

  /**
   * Envia uma mensagem estruturada (serializada como JSON em bloco de código).
   * Útil para passar contexto tipado entre agentes dentro de uma mesma issue.
   */
  async send<T>(
    issueId: string,
    message: StructuredMessage<T>,
  ): Promise<CommentSummary> {
    const mention = message.toAgentId
      ? `<!-- to:${message.toAgentId} -->\n`
      : "";
    const body =
      mention +
      `**[orchestration:${message.type}]**\n\n` +
      "```json\n" +
      JSON.stringify(message, null, 2) +
      "\n```";

    return this.post({ issueId, body });
  }

  /**
   * Lê todos os comentários de uma issue.
   */
  async readAll(issueId: string): Promise<CommentSummary[]> {
    const raw = await this.client.get<RawComment[]>(
      `/api/issues/${issueId}/comments`,
    );
    return raw.map(normalizeComment);
  }

  /**
   * Lê apenas os comentários após um ID específico (leitura incremental).
   * Ideal para heartbeats que já conhecem o estado anterior do thread.
   */
  async readSince(
    issueId: string,
    afterCommentId: string,
  ): Promise<CommentSummary[]> {
    const qs = new URLSearchParams({
      after: afterCommentId,
      order: "asc",
    });
    const raw = await this.client.get<RawComment[]>(
      `/api/issues/${issueId}/comments?${qs}`,
    );
    return raw.map(normalizeComment);
  }

  /**
   * Lê um comentário específico pelo ID.
   */
  async readOne(issueId: string, commentId: string): Promise<CommentSummary> {
    const raw = await this.client.get<RawComment>(
      `/api/issues/${issueId}/comments/${commentId}`,
    );
    return normalizeComment(raw);
  }

  /**
   * Tenta parsear um comentário como mensagem estruturada.
   * Retorna null se o comentário não for uma mensagem de orquestração.
   */
  parseStructured<T = unknown>(
    comment: CommentSummary,
  ): StructuredMessage<T> | null {
    const match = comment.body.match(
      /```json\s*([\s\S]+?)\s*```/,
    );
    if (!match) return null;

    try {
      const parsed = JSON.parse(match[1]) as StructuredMessage<T>;
      if (typeof parsed.type !== "string" || !("payload" in parsed))
        return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Posta um comentário com @-mention para acordar um agente específico.
   * O Paperclip dispara um heartbeat para o agente mencionado.
   */
  async mention(
    issueId: string,
    agentNameKey: string,
    message: string,
  ): Promise<CommentSummary> {
    return this.post({
      issueId,
      body: `@${agentNameKey} ${message}`,
    });
  }

  /**
   * Broadcast: posta uma mensagem visível a todos os participantes da issue.
   */
  async broadcast(issueId: string, message: string): Promise<CommentSummary> {
    return this.post({ issueId, body: message });
  }
}

function normalizeComment(raw: RawComment): CommentSummary {
  return {
    id: raw.id,
    issueId: raw.issueId,
    body: raw.body,
    authorAgentId: raw.authorAgentId,
    authorUserId: raw.authorUserId,
    createdAt: raw.createdAt,
  };
}
