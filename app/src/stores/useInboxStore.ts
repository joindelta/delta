import { create } from 'zustand';
import { prepareOutboundEmail } from '../ffi/gardensCore';

const RELAY_URL = 'https://gardens-relay.stereos.workers.dev';

export interface InboxEmail {
  messageId: string;
  from: string;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  receivedAt: number;
  isRead: boolean;
}

interface InboxState {
  emails: InboxEmail[];
  unreadCount: number;
  isLoading: boolean;
  error: string | null;
  fetchEmails(inboxTopicHex: string): Promise<void>;
  markRead(messageId: string): void;
  sendEmail(params: {
    to: string;
    subject: string;
    bodyText: string;
    bodyHtml?: string;
    replyToMessageId?: string;
  }): Promise<void>;
}

export const useInboxStore = create<InboxState>((set) => ({
  emails: [],
  unreadCount: 0,
  isLoading: false,
  error: null,

  async fetchEmails(_inboxTopicHex) {
    // EmailOps arrive via WebSocket and are ingested by ingestEmailOp.
    set({ isLoading: false });
  },

  markRead(messageId) {
    set((s) => {
      const updated = s.emails.map((e) =>
        e.messageId === messageId ? { ...e, isRead: true } : e
      );
      return { emails: updated, unreadCount: updated.filter((e) => !e.isRead).length };
    });
  },

  async sendEmail({ to, subject, bodyText, bodyHtml, replyToMessageId }) {
    const { signedPayload, signature } = await prepareOutboundEmail({
      to,
      subject,
      bodyText,
      bodyHtml,
      replyToMessageId,
    });

    const resp = await fetch(`${RELAY_URL}/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signed_payload: signedPayload, signature }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Send failed: ${resp.status} ${text}`);
    }
  },
}));

export function ingestEmailOp(rawOpJson: string): void {
  try {
    const op = JSON.parse(rawOpJson) as {
      op_type: string;
      from: string;
      subject: string;
      body_text: string;
      body_html: string | null;
      message_id: string;
      received_at: number;
    };
    if (op.op_type !== 'receive_email') return;
    const email: InboxEmail = {
      messageId: op.message_id,
      from: op.from,
      subject: op.subject,
      bodyText: op.body_text,
      bodyHtml: op.body_html,
      receivedAt: op.received_at,
      isRead: false,
    };
    useInboxStore.setState((s) => {
      if (s.emails.some((e) => e.messageId === email.messageId)) return s;
      const updated = [email, ...s.emails].sort((a, b) => b.receivedAt - a.receivedAt);
      return { emails: updated, unreadCount: updated.filter((e) => !e.isRead).length };
    });
  } catch {
    // Malformed op — ignore
  }
}
