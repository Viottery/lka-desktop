import asyncio
import hashlib
import json
from pathlib import Path
import tempfile
import time
import threading
import unittest
from unittest.mock import patch

from app.plugins.message_media import cache_key, checked_addresses, download, extract_media, generated_path, media_type
from app.plugins.qq_reader import QQReader, QQReaderConfig, normalize_event


class MediaTests(unittest.TestCase):
    def test_pending_restart_removes_uncommitted_final(self):
        with tempfile.TemporaryDirectory() as d:
            reader,message=self.reader(d); self.allow(reader)
            reader._store(message,"",[{"ordinal":0,"kind":"image","url":"https://gchat.qpic.cn/x"}])
            path=generated_path(reader._media.directory,cache_key("qq","100","7",0)); path.write_bytes(b"orphan")
            with reader._connect_db() as c: reader._media.initialize(c)
            self.assertFalse(path.exists())

    def test_cancelled_download_stays_cancelled_across_restart(self):
        async def run(reader):
            started,release,finished=threading.Event(),threading.Event(),threading.Event()
            permission=[]
            def fake_download(*args):
                permitted=args[-1]; permission.append(permitted()); started.set()
                release.wait(2); permission.append(permitted()); finished.set()
                return {"mime_type":"image/png","size_bytes":1,"sha256":"a"*64}
            with patch("app.plugins.message_media.download",side_effect=fake_download):
                task=asyncio.create_task(reader._media.step())
                self.assertTrue(await asyncio.to_thread(started.wait,2))
                async def release_old_worker():
                    await asyncio.sleep(.05)
                    self.assertFalse(task.done())
                    reader._stop.clear()
                    release.set()
                releasing=asyncio.create_task(release_old_worker())
                task.cancel()
                with self.assertRaises(asyncio.CancelledError): await task
                await releasing
                self.assertTrue(await asyncio.to_thread(finished.wait,2))
            self.assertEqual(permission,[True,False])
            with reader._connect_db() as c: self.assertEqual(c.execute("SELECT state FROM private_media").fetchone()[0],"pending")
        with tempfile.TemporaryDirectory() as d:
            reader,message=self.reader(d); self.allow(reader)
            reader._store(message,"",[{"ordinal":0,"kind":"image","url":"https://gchat.qpic.cn/x"}]); reader._mark_synced([("qq","100","7")])
            asyncio.run(run(reader))

    def test_stream_bounds_magic_and_atomic_cache(self):
        class Response:
            status=200
            def __init__(self, body): self.body=body
            def getheader(self, name): return None
            def read(self, size): result,self.body=self.body[:size],self.body[size:]; return result
        class Connection:
            def __init__(self, body): self.response=Response(body); self._context=self
            def wrap_socket(self, sock, **kw): return sock
            def request(self,*a,**kw): pass
            def getresponse(self): return self.response
            def close(self): pass
        class Socket:
            def settimeout(self,*a): pass
            def connect(self,*a): pass
            def close(self): pass
        from urllib.parse import urlsplit
        with tempfile.TemporaryDirectory() as d:
            for body,limit,error,kind in [(b"\x89PNG\r\n\x1a\nabc",100,None,"image"),
                                          (b"\x00\x00\x00\x18ftypisom",100,None,"video"),
                                          (b"<html>bad</html>",100,"unsupported_media","image"),
                                          (b"\x89PNG\r\n\x1a\nabc",4,"too_large","image")]:
                with patch("app.plugins.message_media.checked_addresses",return_value=(urlsplit("https://gchat.qpic.cn/x"),[(2,1,6,"",("8.8.8.8",443))])),patch("app.plugins.message_media.socket.socket",return_value=Socket()),patch("app.plugins.message_media.http.client.HTTPSConnection",return_value=Connection(body)):
                    if error:
                        with self.assertRaisesRegex(ValueError,error): download("https://gchat.qpic.cn/x",d,"b"*64,limit,1,kind)
                    else:
                        metadata=download("https://gchat.qpic.cn/x",d,"a"*64,limit,1,kind)
                        self.assertEqual(metadata["mime_type"], "video/mp4" if kind == "video" else "image/png")
                        self.assertEqual(metadata["size_bytes"],len(body))
                        self.assertTrue((Path(d)/("a"*64+".bin")).exists())
                self.assertFalse((Path(d)/("b"*64+".tmp")).exists())

    def test_extract_sanitized_sticker_skip_and_limit(self):
        event = {"message": [{"type":"text","data":{"text":"hi"}}, {"type":"image","data":{"url":"https://gchat.qpic.cn/private", "file":"a.png"}}, {"type":"image","data":{"sub_type":1,"url":"https://gchat.qpic.cn/sticker"}}, {"type":"video","data":{"file":"C:\\private\\x.mp4"}}]}
        refs = extract_media(event)
        self.assertEqual([r["ordinal"] for r in refs], [1,3])
        self.assertIsNone(refs[1]["url"])
        self.assertIsNone(refs[1]["file_name"])
        self.assertEqual(len(extract_media({"message":[{"type":"image","data":{}}]*30})),20)

    def test_cq_fallback(self):
        self.assertEqual(extract_media({"message":"[CQ:image,file=a.png,url=https://gchat.qpic.cn/x?a=1&amp;b=2]"})[0]["url"], "https://gchat.qpic.cn/x?a=1&b=2")

    def test_stable_cache_key(self):
        self.assertEqual(cache_key("qq","a","m",2),hashlib.sha256(b'["qq","a","m",2]').hexdigest())
        self.assertNotEqual(cache_key("qq","a","m",2),cache_key("qq","b","m",2))

    def test_security_urls_dns_and_signatures(self):
        for url in ("http://gchat.qpic.cn/x","https://localhost/x","https://evil.example/x","https://user@gchat.qpic.cn/x","https://gchat.qpic.cn:444/x"):
            with self.assertRaises(ValueError): checked_addresses(url)
        with patch("app.plugins.message_media.socket.getaddrinfo",return_value=[(2,1,6,"",("127.0.0.1",443))]):
            with self.assertRaises(ValueError): checked_addresses("https://gchat.qpic.cn/x")
        self.assertEqual(media_type(b"\x89PNG\r\n\x1a\n"),"image/png")
        self.assertIsNone(media_type(b"<svg>"))
        self.assertIsNone(media_type(b"<html>"))

    def test_generated_path_rejects_symlink(self):
        with tempfile.TemporaryDirectory() as d:
            base=Path(d); (base/"linked").symlink_to(base,target_is_directory=True)
            with self.assertRaises(ValueError): generated_path(base/"linked","a"*64)
            with self.assertRaises(ValueError): generated_path(base,"../private")

    def reader(self, directory):
        reader=QQReader(QQReaderConfig(db_path=str(Path(directory)/"reader.db"),expected_self_id="100",sync_url="http://127.0.0.1:8765/integrations/messages/import"))
        reader._initialize_db(); reader._media.enabled=True; reader._media.directory=str(Path(directory)/"media")
        message=normalize_event({"post_type":"message","message_type":"group","self_id":"100","message_id":"7","group_id":"group","user_id":"sender","message":[{"type":"image","data":{"url":"https://gchat.qpic.cn/private"}}]})
        return reader,message

    def allow(self, reader):
        reader._replace_policies([("qq","100","group","group",1)])
        reader._replace_media_policies([("qq","100","group","group",1,1)])

    def test_off_whitelist_no_job_and_parent_ack_gate(self):
        with tempfile.TemporaryDirectory() as d:
            reader,message=self.reader(d)
            refs=[{"ordinal":0,"kind":"image","url":"https://gchat.qpic.cn/private"}]
            self.assertIsNone(reader._store(message,"",refs))
            with reader._connect_db() as c: self.assertEqual(c.execute("SELECT COUNT(*) FROM private_media").fetchone()[0],0)
            self.allow(reader); reader._store(message,"",refs)
            self.assertIsNone(reader._media.next_job())
            reader._mark_synced([("qq","100","7")])
            self.assertIsNotNone(reader._media.next_job())
            with reader._connect_db() as c:
                payload=c.execute("SELECT payload FROM message_outbox").fetchone()[0]
            self.assertNotIn("private",payload)

    def test_revocation_removes_only_generated_files(self):
        with tempfile.TemporaryDirectory() as d:
            reader,message=self.reader(d); self.allow(reader)
            reader._store(message,"",[{"ordinal":0,"kind":"image","url":None}])
            key=cache_key("qq","100","7",0)
            path=generated_path(reader._media.directory,key); path.write_bytes(b"test")
            other=Path(reader._media.directory)/"user-file"; other.write_bytes(b"keep")
            reader._replace_media_policies([]); reader._media.cleanup()
            self.assertFalse(path.exists()); self.assertTrue(other.exists())
            with reader._connect_db() as c: self.assertEqual(c.execute("SELECT COUNT(*) FROM private_media").fetchone()[0],0)

    def test_metadata_transport_retry_requires_ack(self):
        with tempfile.TemporaryDirectory() as d:
            reader,message=self.reader(d); self.allow(reader)
            reader._store(message,"",[{"ordinal":0,"kind":"image","url":None}]); reader._mark_synced([("qq","100","7")])
            calls=[]
            async def fail(payload): calls.append(payload); raise RuntimeError("offline")
            reader._post_media=fail
            with self.assertRaises(RuntimeError): asyncio.run(reader._media.step())
            with reader._connect_db() as c: self.assertEqual(c.execute("SELECT synced FROM private_media").fetchone()[0],0)
            async def ack(payload): return {"acknowledged":[{"platform":"qq","account_id":"100","message_id":"7","ordinal":0}]}
            reader._post_media=ack; asyncio.run(reader._media.step())
            with reader._connect_db() as c: self.assertEqual(c.execute("SELECT synced FROM private_media").fetchone()[0],1)
            self.assertNotIn("url",json.dumps(calls))

    def test_expiry_preserves_index_and_quota_reserves(self):
        with tempfile.TemporaryDirectory() as d:
            reader,message=self.reader(d); self.allow(reader)
            reader._store(message,"",[{"ordinal":0,"kind":"image","url":None}])
            key=cache_key("qq","100","7",0)
            generated_path(reader._media.directory,key).write_bytes(b"12345")
            metadata={"size_bytes":5,"mime_type":"image/png","sha256":"a"*64}
            with reader._connect_db() as c:
                c.execute("UPDATE private_media SET state='cached',metadata=?,expires_at=?",(json.dumps(metadata),int(time.time())-1))
            reader._media.cleanup()
            with reader._connect_db() as c:
                row=c.execute("SELECT state,metadata FROM private_media").fetchone()
                self.assertEqual(row[0],"expired"); self.assertEqual(json.loads(row[1]),metadata)
                c.execute("UPDATE private_media SET state='cached',expires_at=?",(int(time.time())+3600,))
            generated_path(reader._media.directory,key).write_bytes(b"12345")
            reader._media.quota=8; reader._media.reserve(4)
            self.assertFalse(generated_path(reader._media.directory,key).exists())

        with tempfile.TemporaryDirectory() as d:
            reader,message=self.reader(d); self.allow(reader)
            reader._store(message,"",[{"ordinal":0,"kind":"image","url":"https://gchat.qpic.cn/x"}])
            key=cache_key("qq","100","7",0)
            path=generated_path(reader._media.directory,key,".tmp"); path.write_bytes(b"interrupted")
            with reader._connect_db() as c: reader._media.initialize(c)
            self.assertFalse(path.exists())
            reader._mark_synced([("qq","100","7")]); row=reader._media.next_job()
            self.assertTrue(reader._media.permitted(row))
            reader._stop.set(); self.assertFalse(reader._media.permitted(row))

if __name__ == "__main__": unittest.main()
