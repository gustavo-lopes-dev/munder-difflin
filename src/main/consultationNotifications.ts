import { execFile } from 'node:child_process';
import type { ConsultationRecipient } from '../shared/slackConsultation';

/** Use OpenCode's authenticated service discovery, not a guessed server URL.
 * No shell interpolation, no arbitrary executable from a Slack payload. */
export function notifyOpenCode(recipient: ConsultationRecipient, text: string, id: string): Promise<void> {
  if (recipient.kind !== 'opencode') return Promise.reject(new Error('Not an OpenCode recipient'));
  const body = JSON.stringify({ id, text, delivery: 'steer', resume: true });
  return new Promise((resolve, reject) => {
    execFile('opencode', ['api', 'post', `/api/session/${recipient.id}/prompt`, '--data', body],
      { cwd: recipient.directory, timeout: 15000, maxBuffer: 512 * 1024, windowsHide: true }, (error, stdout) => {
        if (error) { reject(new Error('OpenCode notification failed')); return; }
        try {
          const result = JSON.parse(stdout) as { data?: { id?: string }; error?: unknown };
          if (result.error || !result.data?.id) throw new Error('Not admitted');
          resolve();
        } catch { reject(new Error('OpenCode did not confirm notification admission')); }
      });
  });
}
