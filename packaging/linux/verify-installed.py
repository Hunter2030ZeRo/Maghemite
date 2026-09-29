"""Run inside a disposable Linux container after package installation, as root."""
import hashlib,json,os,pathlib,re,signal,subprocess,time,urllib.request
app=pathlib.Path('/usr/lib/maghemite'); assets=app/'assets'
def digest_tree():
 return {str(p.relative_to(app)):hashlib.sha256(p.read_bytes()).hexdigest() for p in app.rglob('*') if p.is_file()}
before=digest_tree()
manifest=json.loads((assets/'assets.json').read_text())
for item in manifest['files']:
 assert hashlib.sha256((assets/item['path']).read_bytes()).hexdigest()==item['hash'],item['path']
base=pathlib.Path('/tmp/maghemite-package-test');base.mkdir(exist_ok=True)
workspace=base/'QA workspace';workspace.mkdir(exist_ok=True)
(workspace/'note.md').write_text('# Installed package test\n[[Other]]\n')
(workspace/'Other.md').write_text('# Other note\n')
profile=base/'QA profile';profile.mkdir(exist_ok=True)
(profile/'keep-after-uninstall').write_text('preserve user data')
for p in [base,*base.rglob('*')]:os.chown(p,1000,1000)
env={**os.environ,'HOME':str(base),'XDG_DATA_HOME':str(base/'data'),'XDG_CACHE_HOME':str(base/'cache'),'DISPLAY':':99','GSETTINGS_BACKEND':'memory'}
def demote():
 os.setgroups([]);os.setgid(1000);os.setuid(1000)
# The runtime and both native services must load under the target distribution.
subprocess.run([str(assets/'deno'),'eval','console.log("INSTALLED_DENO_OK")'],env=env,preexec_fn=demote,check=True,timeout=15)
code='const a=Deno.args[0];for(const p of ["libmaghemite_core.so","libpty.so"]){const l=Deno.dlopen(a+"/"+p,{});l.close();}console.log("INSTALLED_FFI_OK");'
subprocess.run([str(assets/'deno'),'eval','--allow-ffi',code,str(assets)],env=env,preexec_fn=demote,check=True,timeout=15)
wasm=subprocess.run([str(assets/'maghemite-wasm-host')],input=b'',capture_output=True,env=env,preexec_fn=demote,timeout=15)
assert b'error while loading shared libraries' not in wasm.stderr
assert wasm.returncode in (0,1),wasm.stderr.decode(errors='replace')
log=base/'native.log'
xvfb=subprocess.Popen(['Xvfb',':99','-screen','0','1440x960x24','-nolisten','tcp','-ac'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(1)
try:
 with log.open('wb') as stream:
  p=subprocess.Popen(['/usr/bin/maghemite','--workspace='+str(workspace),'--data-dir='+str(profile)],cwd='/tmp',env=env,preexec_fn=demote,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
  try:
   url=None
   for _ in range(150):
    text=log.read_text(errors='replace');match=re.search(r'Maghemite: (http://127.0.0.1:\d+/)',text)
    if match:url=match[1];break
    if p.poll() is not None:raise AssertionError(text)
    time.sleep(.2)
   assert url,log.read_text(errors='replace')
   with urllib.request.urlopen(url,timeout=10) as response:
    assert response.status==200 and b'<div id="root">' in response.read()
   req=urllib.request.Request(url+'api/workbench/session',headers={'X-Maghemite-Client':'1'})
   with urllib.request.urlopen(req,timeout=10) as response:assert json.load(response)['token']
   time.sleep(3)
   assert p.poll() is None,log.read_text(errors='replace')
  finally:
   if p.poll() is None:
    os.killpg(p.pid,signal.SIGINT)
    try:p.wait(timeout=8)
    except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
 print(log.read_text(errors='replace'))
 assert 'error: Uncaught' not in log.read_text(errors='replace')
 assert not (profile/'runtime').exists(),'Installed package extracted a runtime'
 assert digest_tree()==before,'Installed resources were changed at runtime'
 print('INSTALLED_NATIVE_WINDOW_OK; NO_EXTRACTION; IMMUTABLE_RESOURCES')
finally:
 xvfb.terminate();xvfb.wait(timeout=5)
