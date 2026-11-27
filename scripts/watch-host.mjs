import {spawn} from 'node:child_process';
import {mkdirSync,existsSync,readFileSync,writeFileSync,appendFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {createWatchGateway} from '../server/watch-gateway.mjs';
const root=join(process.env.LOCALAPPDATA,'MarketLabHost');mkdirSync(root,{recursive:true});
const pidFile=join(root,'watch-host.pid');if(existsSync(pidFile)){try{process.kill(Number(readFileSync(pidFile)),0);process.exit(0);}catch{}}
const server=createWatchGateway();let tunnel,stopping=false;
function launch(){
  if(stopping)return;
  tunnel=spawn(join(root,'cloudflared.exe'),['tunnel','--url','http://127.0.0.1:8767','--no-autoupdate'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  const log=chunk=>{appendFileSync(join(root,'watch-tunnel.log'),chunk);const url=String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);if(url)writeFileSync(join(root,'watch-url.txt'),url[0]+'/watch\n');};
  tunnel.stdout.on('data',log);tunnel.stderr.on('data',log);tunnel.on('error',()=>log('Viewer tunnel start failed\n'));tunnel.on('exit',()=>{if(!stopping)setTimeout(launch,5000);});
}
server.on('error',()=>{if(!stopping){stopping=true;tunnel?.kill();process.exitCode=1;}});
server.listen(8767,'127.0.0.1',()=>{writeFileSync(pidFile,String(process.pid));launch();});
function stop(){if(stopping)return;stopping=true;tunnel?.kill();server.close();try{unlinkSync(pidFile);}catch{}setTimeout(()=>process.exit(),1500);}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
