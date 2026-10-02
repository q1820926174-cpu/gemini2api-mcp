# Credential check

The macOS LaunchAgent `com.example.gemini2api-credential-check` (template in
`launchagent/`) runs every five minutes and at login, using `run-scheduled.mjs`.
It does not invoke any language model. It runs in the logged-in user's GUI
session; checks pause while the Mac is asleep or the user is logged out. Chrome
and its WebBridge extension must be available. The runner may start the
WebBridge daemon and retry once when the daemon is unavailable and no cookie
submission was attempted.

The runner uses macOS notifications for completed updates and new failures;
unchanged failures and successful comparisons remain quiet. Status-only logs are
in `~/Library/Logs/Gemini2API/credential-check.log` (256 KiB rotation with one
retained file). `.scheduler-state.json` records the last scheduled result. No
raw subprocess errors, credential values, or API response bodies are logged.

Manual check: `npm run check`. For comparison without submission, run
`npm run check -- --read-only`. Regression checks: `npm test`.

Inspect the job with `launchctl print gui/$(id -u)/com.example.gemini2api-credential-check`.
Stop it with `launchctl bootout gui/$(id -u)/com.example.gemini2api-credential-check`;
remove its plist to also prevent startup at the next login.

The checker uses an existing WebBridge Chrome session and the installed Python
Paramiko package. Google Gemini must be signed in. It reads only the two secure
Google cookies used by gemini2api and keeps their values in memory.

All credentials come from `.env` (see `.env.example`) or the process
environment — never from logs or chat history:

- `GEMINI2API_ADMIN_KEY` — gemini2api management key
- `GEMINI2API_SSH_HOST` / `_PORT` / `_USER` — SSH endpoint for the tunnel
- `GEMINI2API_SSH_PASSWORD` **or** `GEMINI2API_SSH_KEY` — exactly one auth
  method; prefer a dedicated SSH key

Management traffic travels through a loopback-only SSH tunnel to the configured
server (`ssh_tunnel.py`). SSH host keys must already match `known_hosts` —
unknown hosts are rejected. Missing configuration or rejected credentials
stops the run. The API invocation key (`GEMINI_API_KEY`) is not needed by the
checker.

The authenticated cloud status returns hashes of both configured and persisted
credentials. The checker compares these with SHA-256 of the local JSON tuple
`[PSID, PSIDTS]`. Server-side transient Cookie rotation is excluded
deliberately: it must not trigger repeated overwrites of the same configured
browser pair.

Equal hashes mean no write. A mismatch allows one submission through the actual
Accounts / Update Cookie web form only when the account is idle. An active
generation or another refresh returns `DEFERRED_BUSY` without submitting; the
next scheduled check re-evaluates it. Activity is checked again just before
submission, and the server atomically reserves an idle account while replacing
its HTTP session. Requests arriving during replacement wait for completion.
Success requires matching configured and persisted cloud hashes, with storage in
the mounted accounts file. The checker does not call chat completions, generate
content, or use a direct API to write cookies. Credential equality does not
prove model generation works.

An OS lock prevents overlapping checks. `.credential-check-state.json` contains
only hashes, timestamps, and status. An unresolved submission blocks subsequent
writes until equality is observed or the cause is investigated and its attempt
record is explicitly cleared. Do not delete this record to blindly retry.

JSON output includes status, health HTTP status, whether a cookie submission was
attempted, and a notification flag. Unchanged failures and equal credentials are
quiet. No cookie, password, key, or upstream error body is included in output.

The server patch and regression check are kept under `service-patch/` (follows
the upstream non-commercial license — see `service-patch/LICENSE-NOTE.md`).
Deployment keeps `ACCOUNTS_FILE=/app/data/accounts.json` on the existing
persistent data mount. The idle-reservation server patch requires deployment
during an idle window; the local checker independently defers updates whenever
it observes active requests.
