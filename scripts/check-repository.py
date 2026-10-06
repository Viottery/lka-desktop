"""Check Git distribution content; --staged verifies the exact index snapshot.
Only paths and failure categories are printed. No private config is loaded.
"""
import argparse,ast,json,re,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def git(*args):return subprocess.check_output(['git','-C',str(ROOT),*args])
def private_path(name):
 p=Path(name)
 return (p.name.startswith('.env') and not name.endswith('.example')) or any(x in ('.venv','.runtime','node_modules','__pycache__','.gradle') for x in p.parts) or name.startswith(('data/qq/','logs/','backups/')) or name.endswith(('.db','.sqlite','.sqlite3','.log','.dpapi','-wal','-shm'))
def history_problems(pattern):
 # Deleted files still travel with their reachable commits, including binary DBs.
 objects={}
 for row in git('rev-list','--objects','HEAD').splitlines():
  oid,_,name=row.partition(b' ')
  if name:objects.setdefault(oid.decode(),name.decode(errors='replace'))
 proc=subprocess.Popen(['git','-C',str(ROOT),'cat-file','--batch'],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
 errors=[];blobs=0
 try:
  for oid,name in objects.items():
   proc.stdin.write((oid+'\n').encode());proc.stdin.flush()
   header=proc.stdout.readline().split()
   if len(header)!=3:raise RuntimeError('unexpected_git_object_header')
   data=proc.stdout.read(int(header[2]));proc.stdout.read(1)
   if header[1]!=b'blob':continue
   blobs+=1
   if private_path(name):errors.append({'file':name,'object':oid[:12],'reason':'private_file_in_history'})
   if b'\0' not in data[:8192] and pattern.search(data):errors.append({'file':name,'object':oid[:12],'reason':'credential_like_literal_in_history'})
 finally:
  proc.stdin.close();proc.stdout.close();proc.wait()
 return errors,blobs
def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--staged',action='store_true');parser.add_argument('--history',action='store_true',help='Also check all commits reachable from HEAD, including deleted private files');args=parser.parse_args()
 names=git('ls-files','-z').decode().split('\0')
 if not args.staged:names+=git('ls-files','--others','--exclude-standard','-z').decode().split('\0')
 files=sorted({n for n in names if n and (args.staged or (ROOT/n).is_file())}); errors=[];size=0
 pattern=re.compile(rb'(?<![A-Za-z0-9])(?:sk-|tvly-|ghp_|github_pat_)[A-Za-z0-9_-]{24,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')
 for name in files:
  p=Path(name)
  if private_path(name):
   errors.append({'file':name,'reason':'private_or_generated_file'});continue
  data=git('show',':'+name) if args.staged else (ROOT/name).read_bytes();size+=len(data)
  if len(data)>50*1024*1024:errors.append({'file':name,'reason':'over_50MiB'})
  if b'\0' in data[:8192]:continue
  m=pattern.search(data)
  if m:errors.append({'file':name,'line':data[:m.start()].count(b'\n')+1,'reason':'credential_like_literal'})
  if name.endswith('.py'):
   try:ast.parse(data,filename=name)
   except SyntaxError as exc:errors.append({'file':name,'line':exc.lineno,'reason':'python_syntax'})
 required=['README.MD','.env.example','.env.qq-reader.example','requirements.txt','requirements-qq-reader.txt','run-lka-native-windows.ps1','desktop-pet-java/gradle/wrapper/gradle-wrapper.jar','desktop-pet-java/gradlew.bat','app/web/pet/chat.html','app/web/pet/chat.js','app/web/pet/chat.css']
 for name in required:
  if name not in files:errors.append({'file':name,'reason':'missing_distribution_file'})
 raw=git('show',':data/pet/profiles.json') if args.staged else (ROOT/'data/pet/profiles.json').read_bytes()
 for profile in json.loads(raw):
  for k in ('skeleton_url','atlas_url','texture_url','runtime_script_url'):
   url=profile.get('spine',{}).get(k,'')
   if url.startswith('/desktop-pet/'):
    name='app/web/pet/'+url[len('/desktop-pet/'):]
    if name not in files:errors.append({'file':name,'reason':'missing_profile_resource'})
 if args.history:
  problems,blobs=history_problems(pattern);errors.extend(problems)
 print(json.dumps({'result':'FAIL' if errors else 'PASS','snapshot':'index' if args.staged else 'working_tree','files':len(files),'bytes':size,'problems':errors},ensure_ascii=False,indent=2));return int(bool(errors))
if __name__=='__main__':raise SystemExit(main())
