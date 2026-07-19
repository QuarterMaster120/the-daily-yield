# Local Fifth Third collector

This free collector uses the installed Microsoft Edge browser on this computer to read the public Fifth Third ZIP rate form. It uses an isolated, non-signed-in browser profile, queries only ZIPs that subscribers have selected, and never receives subscriber email addresses.

It reads `RATE_COLLECTION_READ_TOKEN` and `RATE_COLLECTION_WRITE_TOKEN` from this Windows user's environment. Those credentials are intentionally not stored in source control or in the scheduled-task arguments.

Run one manual verification after the tokens are configured:

```powershell
npm run collector:fifth-third -- --dry-run
```

Install the weekday 4:45 AM local task:

```powershell
.\collector\install-rate-collector-task.ps1
```

Use `--headed` only while diagnosing a changed public form. A failed or blocked page is logged and does not replace the last valid observation.
