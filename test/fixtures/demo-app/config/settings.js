export default {
  sentryDsn: process.env.SENTRY_DSN ?? '',
  smtpHost: process.env.SMTP_HOST ?? 'localhost',
  regionalApi: process.env.REGIONAL_API_URL ?? 'https://api.example.com',
};
