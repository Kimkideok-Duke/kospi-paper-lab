import {appendFileSync,existsSync,renameSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {createWatchGateway} from '../server/watch-gateway.mjs';
const path=join(process.env.LOCALAPPDATA,'MarketLabHost','watch-access.jsonl');
const server=createWatchGateway({onResponse(event){
  if(existsSync(path)&&statSync(path).size>262144)renameSync(path,path+'.previous');
  appendFileSync(path,JSON.stringify(event)+'\n');
}});
server.on('error',()=>{console.error('Public viewer listener unavailable');process.exitCode=1;});
server.listen(8767,'127.0.0.1',()=>process.send?.({ready:true}));
const stop=()=>server.close(()=>process.exit());process.on('SIGINT',stop);process.on('SIGTERM',stop);
