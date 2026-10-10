# The Daily Yield local mailer

This is the offline replacement for the Cloudflare app. It runs on this PC, keeps subscriptions in `data/the-daily-yield.sqlite`, retrieves selected bank CD rates by ZIP code, collects Treasury yields, and sends daily mail from `daily.yield@dayshatter.com` through Resend. The sender reads only `RESEND_API_KEY` from the private user-wide secrets file, falling back to the environment. It does not copy the key into this project.

## One-time migration

1. Copy `.env.example` to `.env` and provide `ADMIN_EMAIL` and temporarily `RATE_INGEST_TOKEN`.
2. Run `npm install`, then `npm run init`.
3. Ensure `RESEND_API_KEY` is present in the private user-wide secrets file. Outlook authorization is no longer required for delivery.
4. While the Cloudflare Worker is still online, run `npm run export:cloudflare` followed by `npm run migrate`.
5. Run `npm run dry-run`, then `npm run run` to send and verify the first real delivery.
6. Run `powershell -ExecutionPolicy Bypass -File scripts/install-weekday-task.ps1` to schedule the local job for 5:00 AM every day.

The scheduled task writes `logs/daily-yield.log`, wakes this PC if necessary, starts late if a scheduled run was missed, and retries failed runs up to three times. If a run still fails, it emails `ADMIN_EMAIL`.

## Subscriber changes

The migration preserves existing email addresses, ZIP codes, bank selections, and Treasury selections. To remove an address after the website is retired, run:

`node daily-yield-mailer.mjs --unsubscribe address@example.com`

Emails now contain signed HTTPS unsubscribe links and RFC 8058 one-click headers. The public endpoint is https://daily-yield-unsubscribe.startcodex.workers.dev. GET renders a confirmation page without changing subscriptions; POST immediately persists an opt-out in Cloudflare D1. Only opaque subscriber IDs and timestamps are stored remotely, not email addresses.

Before each run, the local mailer checks the public opt-out store and removes matching subscribers from SQLite. It checks again immediately before each digest send. If the status service cannot be reached or returns an invalid response, delivery stops. Public opt-outs are immediate; the local SQLite copy is removed on the next successful check. The endpoint does not resume or schedule the mailer.

Deployment: run `node deploy-unsubscribe.mjs` from this directory. Deployment reads `CLOUDFLARE_API_TOKEN` from the private secrets file. The separate signing and status keys are generated once, deployed as Worker secrets, and stored locally in Windows CurrentUser DPAPI-encrypted `data/unsubscribe-config.json`. Preserve that ignored encrypted file; rotating or losing its keys invalidates old email links. No secret values are stored in source control.

Verification: `node --test resend-mail.test.mjs unsubscribe-client.test.mjs unsubscribe-worker.test.mjs`.
