"""Disposable ASGI fixture. No daily backend, credentials or disk attachments."""
import argparse
import json
import socket
import urllib.request
from urllib.parse import urlsplit
from pathlib import Path
from urllib.parse import unquote

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['*'], allow_headers=['*'])
records = {}
static_source = None


@app.post('/_test/static-source')
async def static_source_route(request: Request):
    global static_source
    origin = (await request.json())['origin']
    uri = urlsplit(origin)
    if uri.hostname != '127.0.0.1' or not uri.port or uri.port in (8765, 8780):
        return Response(status_code=403)
    static_source = origin
    return {'ready': True}


@app.get('/desktop-pet/{path:path}')
def static(path: str):
    if static_source is None:
        return Response(status_code=503)
    with urllib.request.urlopen(static_source + '/desktop-pet/' + path, timeout=5) as upstream:
        return Response(upstream.read(), headers={'Content-Type': upstream.headers.get('Content-Type', 'application/octet-stream')})


@app.get('/knowledge/file-types')
def catalog():
    return {'file_types': [{'extensions': ['.txt'], 'index_supported': True}]}


@app.post('/sessions/{session_id}/attachments')
async def upload(session_id: str, request: Request):
    raw = await request.body()
    attachment_id = 'att_' + format(len(records) + 1, '032x')
    media_type = request.headers.get('content-type', '')
    metadata = {'attachment_id': attachment_id, 'kind': 'image' if media_type.startswith('image/') else 'document',
                'filename': unquote(request.headers.get('x-filename', '')), 'media_type': media_type, 'size_bytes': len(raw)}
    records[attachment_id] = (metadata, raw)
    print(json.dumps({'test_upload': True, 'size_bytes': len(raw), 'kind': metadata['kind'], 'content_length': request.headers.get('content-length'), 'transfer_encoding': request.headers.get('transfer-encoding'), 'upgrade': request.headers.get('upgrade')}), flush=True)
    return metadata


@app.get('/sessions/{session_id}/attachments/{attachment_id}/raw')
def raw(session_id: str, attachment_id: str):
    metadata, content = records[attachment_id]
    return Response(content, media_type=metadata['media_type'])


@app.get('/sessions/{session_id}/attachments/{attachment_id}')
def metadata(session_id: str, attachment_id: str):
    return records[attachment_id][0]


@app.post('/_test/shutdown')
def shutdown():
    server.should_exit = True
    return {'stopping': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--ready-file', required=True)
    args = parser.parse_args()
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    sock.listen(2048)
    server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=sock.getsockname()[1], log_level='info'))
    Path(args.ready_file).write_text(str(sock.getsockname()[1]), encoding='utf-8')
    server.run(sockets=[sock])
