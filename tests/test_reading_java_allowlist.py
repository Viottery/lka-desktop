"""Compile only the existing allowlist method, without desktop dependencies."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class ReadingJavaAllowlistTests(unittest.TestCase):
    def test_exact_reading_paths(self):
        root = Path(__file__).resolve().parents[1]
        compiler = shutil.which("javac") or os.environ.get("READING_JAVAC")
        runtime = shutil.which("java") or os.environ.get("READING_JAVA")
        if not compiler or not runtime:
            self.skipTest("Set READING_JAVAC and READING_JAVA to existing JDK executables")
        text = (root / "desktop-pet-java/src/main/java/com/agenticrag/pet/PetControlWindow.java").read_text(encoding="utf-8")
        start = text.index("    static boolean allowedMemoryRequest(")
        end = text.index("    private void handleMemoryRequest(", start)
        checks = '''
    static void check(boolean expected, String method, String path) {
        if (allowedMemoryRequest(method, path) != expected) throw new AssertionError(method + " " + path);
    }
    public static void main(String[] args) {
        String p = "/plugins/message-reading/";
        check(true,"GET",p+"messages/reading/participants?conversation_key=conv&limit=2&cursor=c");
        check(true,"GET",p+"messages/reading/participants/conv/platform%3A%E5%BC%A0%E4%B8%89");
        check(true,"GET",p+"messages/reading/participants/conv/123/sources?limit=20&cursor=c");
        check(true,"POST",p+"messages/reading/participants/conv/123/control");
        check(true,"GET",p+"messages/reading/focus/conv");
        check(true,"PUT",p+"messages/reading/focus/conv");
        check(false,"GET",p+"messages/reading/participants/conv/a%2Fb");
        check(false,"GET",p+"messages/reading/participants/conv/a%5Cb");
        check(false,"GET",p+"messages/reading/participants/conv/%252e%252e");
        check(false,"GET",p+"messages/reading/participants/conv/123?limit=2");
        check(false,"GET",p+"messages/reading/participants?since=2026");
        check(false,"PUT",p+"messages/reading/focus/conv?cursor=c");
        check(false,"POST",p+"messages/reading/participants/conv/123/sources/control");
        check(false,"DELETE",p+"messages/reading/participants/conv/123");
        check(false,"GET",p+"messages/reading/participants/conv/..");
        check(false,"POST",p+"messages/sources/source/control");

        check(true,"GET",p+"messages/conversations?limit=20&offset=0");
        check(true,"GET",p+"messages/conversations/resolve?query=Ops");
        check(true,"GET",p+"messages/conversations/conv/metadata");
        check(true,"PATCH",p+"messages/conversations/conv/metadata");
        check(true,"PUT",p+"messages/policies");
        check(true,"GET",p+"messages/conversations/conv/history?before_seq=21&limit=20");
        check(true,"GET",p+"messages/conversations/conv/coverage");
        check(true,"POST",p+"messages/conversations/conv/analyze");
        check(true,"POST",p+"messages/conversations/conv/retry");
        check(true,"GET",p+"messages/search?query=hello&sender=Alice&sender_id=u1&since=100&until=200&limit=20&offset=0");
        check(true,"GET",p+"messages/recent?conversation_key=conv&since=100&limit=20&offset=0");
        check(true,"GET",p+"messages/records/message_id/context?before=10&after=10");
        check(true,"GET",p+"messages/attachments?kind=image&query=photo&limit=20&offset=0");
        check(true,"GET",p+"messages/attachments/attachment_id");
        check(true,"GET",p+"messages/reading/dossiers?conversation_key=conv&limit=20&offset=0");
        check(true,"GET",p+"messages/reading/dossiers/conv/platform%3A%E5%BC%A0%E4%B8%89/sources?limit=20&offset=0");
        check(false,"GET",p+"messages/attachments/attachment_id/content");
        check(false,"GET",p+"messages/search?query=hi&token=secret");
        check(false,"GET",p+"messages/conversations?query=Ops");
        check(false,"GET",p+"messages/reading/overview?since=100");
        check(false,"GET",p+"messages/reading/dossiers?cursor=x");
        check(false,"GET",p+"messages/reading/dossiers/conv/a%2Fb");
        check(false,"GET",p+"messages/records/%252f");
        check(false,"PATCH",p+"messages/conversations/conv/metadata?expected_revision=1");
        check(false,"GET","/plugins/%6dessage-reading/messages/policies");
        check(false,"GET","/plugins/%71q-ui/status");
        check(false,"GET","/plugins/qq-ui%2fstatus");
        String q = "/plugins/qq-ui/";
        check(true,"GET",q+"status");
        check(true,"GET",q+"capabilities");
        check(true,"GET",q+"groups/123?account_id=456");
        check(false,"POST",q+"groups/123?account_id=456");
        check(false,"GET",q+"groups/alice?account_id=456");
        check(false,"GET",q+"groups/123?token=secret");
        check(false,"GET",q+"groups/123?account_id=456&limit=1");
        check(true,"GET",q+"messages?conversation_type=group&conversation_id=123&after=1&limit=20");
        check(true,"GET",q+"sends/send_key_123");
        check(true,"GET",q+"stickers?limit=20");
        check(true,"GET",q+"conversations/group/123");
        check(true,"PUT",q+"conversations/private/123");
        check(true,"POST",q+"messages/send");
        check(true,"POST",q+"messages/1/media/0/cache");
        check(false,"POST",q+"messages/send?token=secret");
        check(false,"GET",q+"messages?sender_id=u1");
        check(false,"GET",q+"status?limit=1");
        check(false,"GET",q+"sends/short");
        check(false,"POST",q+"messages/0/media/0/cache");
        check(false,"POST",q+"messages/1/media/-1/cache");
        check(false,"POST",q+"messages/1/media/0/content");
        check(false,"GET",q+"conversations/channel/123");
        check(false,"PUT",q+"conversations/group/alice");
        check(false,"DELETE",q+"conversations/group/123");
        check(false,"POST",q+"messages/%252f/media/0/cache");
        check(true,"GET",p+"messages/reading/topics/topic/sources?limit=20");
    }
'''
        # The Windows JDK sees this drive directory; generated fixtures are removed.
        with tempfile.TemporaryDirectory(prefix="reading-java-", dir=root / "tests") as directory:
            relative = Path(directory).relative_to(root).as_posix()
            source = Path(directory) / "ReadingAllowlistProbe.java"
            source.write_text("import java.net.URI; import java.util.List;\npublic class ReadingAllowlistProbe {\n" + text[start:end] + checks + "}\n", encoding="utf-8")
            for command in ([compiler, relative + "/ReadingAllowlistProbe.java"],
                            [runtime, "-cp", relative, "ReadingAllowlistProbe"]):
                result = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
