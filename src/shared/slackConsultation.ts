/** A separate opt-in from proactive acknowledgements: destinations live in config,
 * never in agent-authored requests. No Slack credential crosses this contract. */
export interface SlackConsultationConfig {
  enabled: boolean;
  channelId: string;
  assistantId: string;
  /** Required for a user-group mention (S…). Otherwise defaults to assistantId.
   * May be the responder's user, bot or app ID, matched exactly. */
  responderId?: string;
  timeoutSeconds: number;
  /** Some Slack workflows create a conversation on mention, greet, and only
   * then accept the question as a thread reply. Both modes are configurable. */
  conversationMode?: "question" | "mention_then_question";
  /** Case-insensitive substring required in the trusted responder's greeting. */
  greetingText?: string;
}

export type ConsultationRecipient =
  | { kind: "hive"; id: string }
  | { kind: "opencode"; id: string; directory: string };

export interface SlackConsultationRequest {
  /** Caller-generated idempotency key; reuse it after a transport failure. */
  id: string;
  question: string;
  context?: string;
  orchestrator: ConsultationRecipient;
  requester?: ConsultationRecipient;
}

export type ConsultationStatus =
  | "sending"
  | "waiting"
  | "received"
  | "timed_out"
  | "failed"
  | "delivery_unknown";

export interface SlackConsultation {
  id: string;
  question: string;
  context?: string;
  orchestrator: ConsultationRecipient;
  requester?: ConsultationRecipient;
  channel: string;
  assistantId: string;
  responderId: string;
  status: ConsultationStatus;
  createdAt: number;
  deadline: number;
  threadTs?: string;
  conversationMode?: "question" | "mention_then_question";
  greetingText?: string;
  greetingTs?: string;
  followupStatus?: "sending" | "sent" | "unknown";
  replies: { ts: string; text: string }[];
  error?: string;
  /** Delivery errors remain visible to the caller; a Slack reply is not proof
   * that OpenCode/the orchestrator received the update. */
  notifications: ConsultationNotification[];
}

export interface ConsultationNotification {
  id: string;
  recipient: ConsultationRecipient;
  text: string;
  attempts: number;
  delivered: boolean;
  error?: string;
}

export const DEFAULT_SLACK_CONSULTATION: SlackConsultationConfig = {
  enabled: false,
  channelId: "",
  assistantId: "",
  timeoutSeconds: 120,
};

export function validConsultationRecipient(
  value: unknown,
): value is ConsultationRecipient {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== "string") return false;
  if (r.kind === "hive") return /^[a-zA-Z0-9_-]{1,100}$/.test(r.id);
  return (
    r.kind === "opencode" &&
    /^ses_[a-zA-Z0-9]+$/.test(r.id) &&
    typeof r.directory === "string" &&
    (/^\//.test(r.directory) || /^[A-Za-z]:[\\/]/.test(r.directory))
  );
}

export function validateConsultationConfig(
  c: SlackConsultationConfig,
): string | undefined {
  if (!/^[CG][A-Z0-9]{2,}$/.test(c.channelId))
    return "A Slack channel ID (C… or G…) is required.";
  if (!/^[UWS][A-Z0-9]{2,}$/.test(c.assistantId))
    return "Mention ID must be a Slack user (U…/W…) or user group (S…).";
  if (c.assistantId.startsWith("S") && !c.responderId?.trim()) {
    return "An S… ID identifies a user group, not a responder. Configure the assistant’s user/bot/app ID in Responder ID.";
  }
  if (!/^[UWBA][A-Z0-9]{2,}$/.test(c.responderId?.trim() || c.assistantId))
    return "Responder ID must identify a user, bot or app (U…/W…/B…/A…).";
  if (
    !Number.isFinite(c.timeoutSeconds) ||
    c.timeoutSeconds < 15 ||
    c.timeoutSeconds > 600
  )
    return "Response timeout must be between 15 and 600 seconds.";
  if (
    c.conversationMode !== undefined &&
    !["question", "mention_then_question"].includes(c.conversationMode)
  )
    return "Unknown assistant conversation mode.";
  if (
    c.conversationMode === "mention_then_question" &&
    (!c.greetingText?.trim() || c.greetingText.length > 500)
  )
    return "Two-step conversations require a greeting phrase (1–500 characters, case-insensitive substring).";
  return undefined;
}
