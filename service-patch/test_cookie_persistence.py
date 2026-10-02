import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.core.account_pool import Account, AccountPool, AccountStatus
from app.routers import admin
from app.config import settings


class CookiePersistenceTest(unittest.IsolatedAsyncioTestCase):
    async def test_busy_account_never_reloads_or_persists_cookies(self):
        # Given: a generation already owns a slot on this account.
        pool = AccountPool()
        client = SimpleNamespace(_heal_lock=asyncio.Lock(), is_healthy=True,
                                 reload_cookies=AsyncMock(return_value={"success": True}))
        account = Account("account-0", "synthetic-old", "synthetic-ts", client=client, active_requests=1)
        pool._accounts = [account]
        with patch.object(pool, "_save_to_file") as save:
            # When: an administrator tries to replace the session cookies.
            result = await pool.update_cookies(account, "synthetic-new", "synthetic-new-ts")
            # Then: the in-flight session remains untouched.
            self.assertFalse(result["success"])
            client.reload_cookies.assert_not_awaited()
            save.assert_not_called()
            self.assertEqual(account.status, AccountStatus.ACTIVE)

    async def test_new_requests_wait_until_cookie_update_finishes(self):
        # Given: an idle account whose synthetic reload waits at a deterministic barrier.
        pool = AccountPool()
        entered, finish, waiting = asyncio.Event(), asyncio.Event(), asyncio.Event()
        client = SimpleNamespace(_heal_lock=asyncio.Lock(), is_healthy=True)
        async def reload(**kwargs):
            client.is_healthy = False
            entered.set()
            await finish.wait()
            client.is_healthy = True
            return {"success": True}
        client.reload_cookies = reload
        account = Account("account-0", "synthetic-old", "synthetic-ts", client=client)
        pool._accounts = [account]
        original_wait = pool._cond.wait
        async def observed_wait():
            waiting.set()
            return await original_wait()
        with patch.object(pool, "_save_to_file"), patch.object(pool._cond, "wait", observed_wait):
            update = asyncio.create_task(pool.update_cookies(account, "synthetic-new", "synthetic-new-ts"))
            await entered.wait()
            request = asyncio.create_task(pool.acquire())
            try:
                # When: a request arrives while the account's session is being replaced.
                await asyncio.wait_for(waiting.wait(), 1)
                self.assertFalse(request.done())
                finish.set()
                await update
                # Then: it acquires the account only after the replacement has completed.
                self.assertIs(await asyncio.wait_for(request, 1), account)
                self.assertEqual(account.status, AccountStatus.ACTIVE)
            finally:
                finish.set()
                await update
                if not request.done(): request.cancel()
                await asyncio.gather(request, return_exceptions=True)

    async def test_web_update_persists_and_exposes_only_matching_fingerprints(self):
        # Given: a synthetic account and a successful session reload.
        pool = AccountPool()
        client = SimpleNamespace(_heal_lock=asyncio.Lock(), is_healthy=True,
                                 reload_cookies=AsyncMock(return_value={"success": True}))
        pool._accounts = [Account("account-0", "synthetic-old", "synthetic-old-ts", client=client)]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.json"
            with patch.object(settings, "accounts_file", str(path)), patch.object(admin, "account_pool", pool):
                # When: the same handler used by the web form updates credentials.
                result = await admin.update_account_cookies("account-0", admin.UpdateCookiesRequest(
                    psid="synthetic-new", psidts="synthetic-new-ts"))
                # Then: successful response means restart storage matches metadata.
                self.assertEqual(result["status"], "ok")
                self.assertTrue(path.exists(), "successful cookie updates must persist")
                stored = json.loads(path.read_text())["accounts"][0]
                self.assertEqual((stored["psid"], stored["psidts"]), ("synthetic-new", "synthetic-new-ts"))
                status = await admin.list_accounts()
                row = status["accounts"][0]
                self.assertEqual(row["cookie_fingerprint"], row["persisted_cookie_fingerprint"])
                self.assertEqual(row["cookie_storage"], "accounts_file")
                self.assertNotIn("synthetic-new-ts", json.dumps(status))
                reloaded = AccountPool()
                reloaded._load_from_file(path)
                self.assertEqual((reloaded.accounts[0].psid, reloaded.accounts[0].psidts),
                                 ("synthetic-new", "synthetic-new-ts"))
                first = row["cookie_fingerprint"]
                pool.accounts[0].psidts = "synthetic-other-ts"
                changed = (await admin.list_accounts())["accounts"][0]
                self.assertNotEqual(changed["cookie_fingerprint"], first)
                self.assertEqual(changed["persisted_cookie_fingerprint"], first)

    async def test_failed_reload_or_persistence_never_reports_success(self):
        # Given: an account whose reload or storage write fails.
        for reload_ok in (False, True):
            pool = AccountPool()
            client = SimpleNamespace(_heal_lock=asyncio.Lock(), is_healthy=True,
                                     reload_cookies=AsyncMock(return_value={"success": reload_ok}))
            account = Account("account-0", "synthetic-old", "synthetic-old-ts", client=client)
            pool._accounts = [account]
            with patch.object(admin, "account_pool", pool), patch.object(pool, "_save_to_file", side_effect=OSError) as save:
                # When: the UI submits replacement credentials.
                result = await admin.update_account_cookies("account-0", admin.UpdateCookiesRequest(
                    psid="synthetic-new", psidts="synthetic-new-ts"))
                # Then: failure preserves configured metadata and never returns success.
                self.assertEqual(result.status_code, 503)
                self.assertEqual((account.psid, account.psidts), ("synthetic-old", "synthetic-old-ts"))
                self.assertEqual(save.call_count, int(reload_ok))


if __name__ == "__main__":
    unittest.main()
