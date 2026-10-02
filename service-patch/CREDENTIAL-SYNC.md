# Credential synchronization

The authenticated account status includes SHA-256 fingerprints of the configured cookie tuple and its restart storage. Temporary Google session rotations are deliberately excluded. The web cookie update persists account metadata using the existing atomic writer and reports a failure if persistence fails. Cookie inputs are masked.

The local checker reads the signed-in browser session, compares both fingerprints, and submits at most one web form update on mismatch. It never generates model responses.

Validation: run test_cookie_persistence.py in the base image with the patched modules mounted. The tests fail on the unpatched image and pass with this change. Real acceptance requires an authenticated status read, a web form update, matching persisted fingerprints, and a subsequent zero-write check.

Deployment: use the original /opt/gemini2api/docker-compose.yml together with compose.credential-sync.yml, preserving the existing data volume and API mount. Image before the patch: gemini2api:before-credential-sync-20260929. Do not use an unpinned upstream image for rollback. Keep ACCOUNTS_FILE on the mounted data directory during rollback.
