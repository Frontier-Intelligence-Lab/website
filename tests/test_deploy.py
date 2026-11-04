"""Host-controller safety checks. No Docker, credentials or production access required."""
import importlib.util
import io
import json
import copy
from pathlib import Path
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("deploy", Path(__file__).resolve().parents[1] / "scripts/ops/deploy.py")
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)
SHA = "a" * 40


class RevisionBoundary(unittest.TestCase):
    def test_only_exact_forced_command_is_accepted(self):
        self.assertEqual(deploy.ssh_revision("deploy " + SHA), SHA)
        for command in (None, "", "deploy main", "deploy " + "A" * 40,
                        "deploy " + SHA + "; id", "deploy " + SHA + "\n",
                        "deploy  " + SHA, " deploy " + SHA,
                        "deploy " + SHA + " --config /tmp/other"):
            with self.subTest(command=command), self.assertRaises(deploy.ReleaseError):
                deploy.ssh_revision(command)

    @patch.object(deploy, "run", return_value=(SHA + "\trefs/heads/master\n").encode())
    def test_three_jobs_must_pass_even_while_overall_run_is_running(self, run):
        current = {"id": 12, "head_sha": SHA, "head_branch": "master", "event": "push", "status": "in_progress"}
        passed = [{"name": name, "status": "completed", "conclusion": "success"} for name in deploy.REQUIRED_JOBS]
        with patch.object(deploy, "github", side_effect=[{"workflow_runs": [current]}, {"jobs": passed}]):
            self.assertEqual(deploy.verify_release(SHA, "ci-deploy.yml"), 12)
        current["event"] = "workflow_dispatch"
        with patch.object(deploy, "github", side_effect=[{"workflow_runs": [current]}, {"jobs": passed}]):
            self.assertEqual(deploy.verify_release(SHA, "ci-deploy.yml"), 12)
        passed[0]["conclusion"] = "failure"
        with patch.object(deploy, "github", side_effect=[{"workflow_runs": [current]}, {"jobs": passed}]):
            with self.assertRaises(deploy.ReleaseError):
                deploy.verify_release(SHA, "ci-deploy.yml")

    def test_stale_master_and_pull_request_runs_are_refused(self):
        with patch.object(deploy, "run", return_value=("b" * 40).encode()):
            with self.assertRaises(deploy.ReleaseError):
                deploy.verify_release(SHA, "ci-deploy.yml")
        run = {"id": 12, "head_sha": SHA, "head_branch": "master", "event": "pull_request"}
        with patch.object(deploy, "run", return_value=(SHA + "\trefs/heads/master").encode()), patch.object(deploy, "github", return_value={"workflow_runs": [run]}):
            with self.assertRaises(deploy.ReleaseError):
                deploy.verify_release(SHA, "ci-deploy.yml")


class RuntimePreservation(unittest.TestCase):
    def test_newer_master_after_build_prevents_migrations(self):
        with tempfile.TemporaryDirectory() as directory:
            release = object.__new__(deploy.Release)
            release.config, release.sha = {}, SHA
            release.web = release.ingest = {}
            release.receipt, release.swaps = {}, []
            release.backup_dir = Path(directory)
            calls = []
            release.preflight = lambda: calls.append("preflight")
            release.backup = lambda: calls.append("backup")
            release.build = lambda: calls.append("build")
            release.migrate = lambda: calls.append("migrate")
            with patch.object(deploy, "already_running", return_value=False), patch.object(deploy, "verify_release", side_effect=deploy.ReleaseError("Master changed")):
                with self.assertRaises(deploy.ReleaseError):
                    release.execute()
            self.assertEqual(calls, ["preflight", "backup", "build"])
            self.assertFalse(json.loads((Path(directory) / "receipt.json").read_text())["live"])

    def test_termination_becomes_a_controlled_failure_only_once(self):
        handler = deploy.termination_handler()
        with self.assertRaises(deploy.ReleaseError):
            handler(None, None)
        handler(None, None)

    def test_interrupted_swap_restores_and_records_verified_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            release = object.__new__(deploy.Release)
            release.config = {"web_container": "web", "ingest_container": "ingest"}
            release.sha = SHA
            release.web = release.ingest = {}
            release.images = {"web": "web", "ingest": "ingest"}
            release.receipt, release.swaps = {}, []
            release.backup_dir = Path(directory)
            release.preflight = release.backup = release.build = release.migrate = lambda: None
            release.protected_snapshot = lambda: {}
            restored = []
            release.rollback = lambda: restored.append(True)
            def interrupted_swap(*args):
                release.swaps.append(("ingest", {}))
                deploy.termination_handler()(None, None)
            release.swap = interrupted_swap
            with patch.object(deploy, "already_running", return_value=False), patch.object(deploy, "verify_release", return_value=1):
                with self.assertRaises(deploy.ReleaseError):
                    release.execute()
            self.assertEqual(restored, [True])
            self.assertTrue(json.loads((Path(directory) / "receipt.json").read_text())["containers_rolled_back"])

    def test_only_image_and_revision_metadata_change(self):
        original = {
            "Config": {"Image": "old", "Env": ["SESSION_SECRET=kept", "COOKIE_SECURE=true"],
                       "Labels": {"traefik.route": "kept", deploy.REVISION_LABEL: "old"},
                       "User": "node", "Cmd": ["node", "src/server.js"], "WorkingDir": "/app",
                       "Healthcheck": {"Test": ["CMD", "node", "health.js"]}},
            "HostConfig": {"Binds": ["/private/data:/data"], "RestartPolicy": {"Name": "unless-stopped"}, "NetworkMode": "coolify"},
            "NetworkSettings": {"Networks": {"coolify": {"Aliases": ["frontier-landing"], "IPAddress": "172.18.0.3"}}},
        }
        before = json.dumps(original, sort_keys=True)
        value = deploy.runtime_payload(original, "new", SHA)
        self.assertEqual(value["Env"], original["Config"]["Env"])
        self.assertEqual(value["HostConfig"], original["HostConfig"])
        self.assertEqual(value["Healthcheck"], original["Config"]["Healthcheck"])
        self.assertEqual(value["Labels"]["traefik.route"], "kept")
        self.assertEqual(value["Labels"][deploy.REVISION_LABEL], SHA)
        self.assertEqual(value["Image"], "new")
        self.assertEqual(value["NetworkingConfig"], {"EndpointsConfig": {"coolify": {"Aliases": ["frontier-landing"]}}})
        self.assertEqual(json.dumps(original, sort_keys=True), before)

    def test_runtime_drift_is_rejected(self):
        original = {"Config": {"Image": "old", "Env": ["X=kept"], "User": "node", "Labels": {"traefik.route": "kept"}},
                    "HostConfig": {"RestartPolicy": {"Name": "unless-stopped"}},
                    "Mounts": [{"Type": "bind", "Source": "/data", "Destination": "/data", "RW": True}],
                    "NetworkSettings": {"Networks": {"coolify": {}}}}
        current = copy.deepcopy(original)
        current["Config"]["Image"] = "new"
        current["Config"]["Labels"][deploy.REVISION_LABEL] = SHA
        current["Image"] = "sha256:new"
        deploy.verify_runtime(original, current, "new", SHA, "sha256:new")
        for change in ("env", "mount", "label", "restart", "user", "image"):
            changed = copy.deepcopy(current)
            if change == "env": changed["Config"]["Env"] = ["X=changed"]
            if change == "mount": changed["Mounts"][0]["RW"] = False
            if change == "label": changed["Config"]["Labels"]["traefik.route"] = "changed"
            if change == "restart": changed["HostConfig"]["RestartPolicy"]["Name"] = "no"
            if change == "user": changed["Config"]["User"] = "root"
            if change == "image": changed["Image"] = "sha256:wrong"
            with self.subTest(change=change), self.assertRaises(deploy.ReleaseError):
                deploy.verify_runtime(original, changed, "new", SHA, "sha256:new")

    def test_partial_grants_are_not_mistaken_for_complete_access(self):
        privileges = ["SELECT", "INSERT", "UPDATE", "DELETE"]
        rows = [{"privilege": p, "ok": p == "SELECT"} for p in privileges]
        self.assertEqual(deploy.missing_privileges(rows), ["DELETE", "INSERT", "UPDATE"])
        self.assertEqual(deploy.missing_privileges([{"privilege": p, "ok": True} for p in privileges]), [])
        with self.assertRaises(deploy.ReleaseError):
            deploy.missing_privileges(rows[:1])

    def test_noop_requires_both_exact_images_and_revision_labels(self):
        web = {"Config": {"Image": "valcairn-site:" + SHA, "Labels": {deploy.REVISION_LABEL: SHA}}}
        ingest = {"Config": {"Image": "valcairn-ingest:" + SHA, "Labels": {deploy.REVISION_LABEL: SHA}}}
        self.assertTrue(deploy.already_running(web, ingest, SHA))
        ingest["Config"]["Labels"][deploy.REVISION_LABEL] = "older"
        self.assertFalse(deploy.already_running(web, ingest, SHA))

    def test_rollback_does_not_start_an_already_running_container(self):
        old = {"Id": "old", "Name": "/web", "State": {"Running": True}, "NetworkSettings": {"Networks": {"coolify": {}}}}
        class FakeDocker:
            def __init__(self): self.calls = []
            def inspect(self, *args, **kwargs): return old
            def request(self, *args): self.calls.append(args)
        release = object.__new__(deploy.Release)
        release.swaps = [("web", old)]
        release.docker = FakeDocker()
        release.config = {"web_container": "web", "ingest_container": "ingest"}
        release.health = lambda *args, **kwargs: None
        release.homepage_health = lambda: None
        release.rollback()
        self.assertEqual(release.docker.calls, [])

    def test_rollback_health_failure_is_not_success(self):
        release = object.__new__(deploy.Release)
        release.swaps = []
        release.config = {"web_container": "web", "ingest_container": "ingest"}
        release.docker = types.SimpleNamespace(inspect=lambda name: {})
        def failed(*args, **kwargs):
            raise deploy.ReleaseError("Restored health failed")
        release.health = failed
        with self.assertRaises(deploy.ReleaseError):
            release.rollback()

    def test_existing_protected_rows_cannot_change_or_disappear(self):
        before = {"reviewers": [{"id": "admin", "digest": "original"}], "versions": [{"id": "v1", "digest": "frozen"}]}
        after = copy.deepcopy(before)
        after["versions"].append({"id": "v2", "digest": "legitimate-new"})
        deploy.verify_protected_records(before, after)
        after["reviewers"][0]["digest"] = "changed"
        with self.assertRaises(deploy.ReleaseError):
            deploy.verify_protected_records(before, after)
        with self.assertRaises(deploy.ReleaseError):
            deploy.verify_protected_records(before, {"reviewers": before["reviewers"]})

    def test_migrator_cannot_target_another_database_or_role(self):
        with tempfile.NamedTemporaryFile() as ca:
            web = {"DATABASE_URL": "postgresql://app@database:5432/valcairn"}
            migrator = {"DATABASE_URL": "postgresql://migrator@database:5432/valcairn", "DATABASE_SSL": "verify-full", "NODE_EXTRA_CA_CERTS": "/run/pg-ca.crt"}
            deploy.validate_migrator(web, migrator, ca.name)
            for value in ("postgresql://migrator@database:5432/other", "postgresql://app@database:5432/valcairn", "postgresql://migrator@elsewhere:5432/valcairn"):
                with self.assertRaises(deploy.ReleaseError):
                    deploy.validate_migrator(web, {**migrator, "DATABASE_URL": value}, ca.name)

    def test_csp_cannot_move_blob_access_to_scripts(self):
        origin = "https://frontierintelligencelab.com"
        csp = "default-src 'self';script-src 'self';img-src 'self' blob: " + origin + ";media-src 'self' blob: " + origin
        deploy.verify_csp(csp, origin)
        for invalid in (csp.replace("script-src 'self'", "script-src 'self' blob:"), csp + ";style-src 'unsafe-inline'", "default-src 'self'"):
            with self.assertRaises(deploy.ReleaseError):
                deploy.verify_csp(invalid, origin)

    def test_host_failure_does_not_echo_private_stderr(self):
        result = types.SimpleNamespace(returncode=1, stdout=b"private output", stderr=b"secret value")
        with patch.object(deploy.subprocess, "run", return_value=result):
            with self.assertRaises(deploy.ReleaseError) as error:
                deploy.run(["false"])
        self.assertNotIn("private", str(error.exception))
        self.assertNotIn("secret", str(error.exception))


class SourcePaths(unittest.TestCase):
    def test_child_path_cannot_escape(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(deploy.child_path(root, "release"), Path(root).resolve() / "release")
            for name in ("..", "../elsewhere", root):
                with self.assertRaises(deploy.ReleaseError):
                    deploy.child_path(root, name)

    def archive(self, path, name, kind=tarfile.REGTYPE):
        with tarfile.open(path, "w:gz") as archive:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.linkname = "/outside"
            member.size = 3 if kind == tarfile.REGTYPE else 0
            archive.addfile(member, io.BytesIO(b"abc") if member.size else None)

    def test_unsafe_archive_members_are_rejected_without_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index, (name, kind) in enumerate((("../out", tarfile.REGTYPE), ("/out", tarfile.REGTYPE),
                                                 ("repo/link", tarfile.SYMTYPE), ("repo/hard", tarfile.LNKTYPE),
                                                 ("repo/device", tarfile.CHRTYPE))):
                archive, destination = root / (str(index) + ".tgz"), root / ("out" + str(index))
                self.archive(archive, name, kind)
                with self.assertRaises(deploy.ReleaseError):
                    deploy.safe_extract(archive, destination)
                self.assertFalse(destination.exists())

    def test_regular_archive_extracts_under_one_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.archive(root / "ok.tgz", "repo/src/file.txt")
            result = deploy.safe_extract(root / "ok.tgz", root / "extracted")
            self.assertEqual((result / "src/file.txt").read_bytes(), b"abc")

    def test_manifest_only_uses_fixed_table_allowlist(self):
        sql = deploy.manifest_sql(["users", "users; DROP DATABASE valcairn"])
        self.assertIn("FROM users t", sql)
        self.assertNotIn("DROP", sql)


if __name__ == "__main__":
    unittest.main()
