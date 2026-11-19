import { loadConfig } from './src/config.js';
import { loadRepoEnv } from './src/env.js';
import { sendEmail } from './src/outbound.js';

loadRepoEnv();
const email = loadConfig(process.env).email;
const subject = `aqar-channels-live-smtp-${Date.now()}`;
const result = await sendEmail(email, {
  to: 'tenant@example.test',
  subject,
  text: 'طلبك وصل — السباك رح يوصلك بكرا الساعة 9:00 صباحاً.',
});
console.info(JSON.stringify({ smtpUrl: email.smtpUrl, from: email.from, subject, result }, null, 2));

const deadline = Date.now() + 15_000;
while (Date.now() < deadline) {
  const response = await fetch('http://127.0.0.1:8025/api/v1/messages?limit=50');
  const body = await response.json();
  const hit = (body.messages ?? []).find((message) => message.Subject === subject);
  if (hit) {
    console.info(
      JSON.stringify(
        {
          mailpit: {
            id: hit.ID,
            messageId: hit.MessageID,
            subject: hit.Subject,
            to: (hit.To ?? []).map((to) => to.Address),
            from: hit.From,
          },
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
console.error('mailpit never received the message');
process.exit(1);
