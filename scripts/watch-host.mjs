import {spawn} from 'node:child_process';
import {mkdirSync,existsSync,readFileSync,writeFileSync,appendFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=join(process.env.LOCALAPPDATA,'MarketLabHost');mkdirSync(root,{recursive:true});
const pidFile=join(root,'watch-host.pid');if(existsSync(pidFile)){try{process.kill(Number(readFileSync(pidFile)),0);process.exit(0);}catch{}}
let tunnel,proxy,stopping=false,tunnelStarted=false;
function launch(){
  if(stopping)return;
  tunnel=spawn(join(root,'cloudflared.exe'),['tunnel','--url','http://127.0.0.1:8767','--no-autoupdate'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  const log=chunk=>{appendFileSync(join(root,'watch-tunnel.log'),chunk);const url=String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);if(url)writeFileSync(join(root,'watch-url.txt'),url[0]+'/watch\n');};
  tunnel.stdout.on('data',log);tunnel.stderr.on('data',log);tunnel.on('error',()=>log('Viewer tunnel start failed\n'));tunnel.on('exit',()=>{if(!stopping)setTimeout(launch,5000);});
}
function startProxy(){
  if(stopping)return;
  proxy=spawn(process.execPath,[fileURLToPath(new URL('./watch-proxy.mjs',import.meta.url))],{windowsHide:true,stdio:['ignore','inherit','inherit','ipc']});
  proxy.on('message',m=>{if(m?.ready&&!tunnelStarted){tunnelStarted=true;launch();}});
  proxy.on('error',()=>console.error('Viewer proxy start failed'));
  proxy.on('exit',()=>{if(!stopping)setTimeout(startProxy,1500);});
}
writeFileSync(pidFile,String(process.pid));startProxy();
function stop(){if(stopping)return;stopping=true;tunnel?.kill();proxy?.kill();try{unlinkSync(pidFile);}catch{}setTimeout(()=>process.exit(),1500);}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
