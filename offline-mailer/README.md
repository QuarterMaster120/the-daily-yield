# The Daily Yield local mailer

This is the offline replacement for the Cloudflare app. It runs on this PC, keeps subscriptions in `data/the-daily-yield.sqlite`, retrieves selected bank CD rates by ZIP code, collects Treasury yields, and sends daily mail from `startcodex@outlook.com` through Microsoft Graph.

## One-time migration

1. Copy `.env.example` to `.env` and provide `ADMIN_EMAIL` and temporarily `RATE_INGEST_TOKEN`.
2. Run `npm install`, then `npm run init`.
3. Run `npm run outlook:start`, complete the Microsoft sign-in as `startcodex@outlook.com`, then run `npm run outlook:complete`. The refresh token is protected by Windows and is never added to this repository.
4. While the Cloudflare Worker is still online, run `npm run export:cloudflare` followed by `npm run migrate`.
5. Run `npm run dry-run`, then `npm run run` to send and verify the first real delivery.
6. Run `powershell -ExecutionPolicy Bypass -File scripts/install-weekday-task.ps1` to schedule the local job for 5:00 AM every day.

The scheduled task writes `logs/daily-yield.log`, wakes this PC if necessary, starts late if a scheduled run was missed, and retries failed runs up to three times. If a run still fails, it emails `ADMIN_EMAIL`.

## Subscriber changes

The migration preserves existing email addresses, ZIP codes, bank selections, and Treasury selections. To remove an address after the website is retired, run:

`node daily-yield-mailer.mjs --unsubscribe address@example.com`

Email unsubscribe links use a `mailto:` request because there is intentionally no public web service in this version.
