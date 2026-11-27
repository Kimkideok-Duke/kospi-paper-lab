import http from 'node:http';
// Public hostname has an exact route allowlist. Account/session cookies never reach the backend.
export function createWatchGateway({backend='http://127.0.0.1:8765',now=Date.now}={}){
  const routes=new Map([['/watch','GET'],['/watch/','GET'],['/watch/watch.js','GET'],['/watch/watch.css','GET'],['/watch/data','GET'],['/watch/join','POST']]);
  let bucket=40,last=now(),active=0;
  const server=http.createServer((req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');
    const at=now();bucket=Math.min(40,bucket+Math.max(0,at-last)*.02);last=at;
    if(bucket<1||active>=8){res.setHeader('Retry-After','5');res.writeHead(429).end('Please try again shortly.');req.resume();return;}bucket--;
    let path;try{path=new URL(req.url,'http://viewer.invalid').pathname;}catch{res.writeHead(400).end();req.resume();return;}
    if(path==='/'&&['GET','HEAD'].includes(req.method)){res.writeHead(302,{location:'/watch'}).end();return;}
    if(!routes.has(path)){res.writeHead(404).end('Not found.');req.resume();return;}
    const head=req.method==='HEAD'&&routes.get(path)==='GET';
    if(req.method!==routes.get(path)&&!head){res.writeHead(405).end('Read-only viewer.');req.resume();return;}
    const origin=req.headers.origin,expected='https://'+req.headers.host;
    if(req.method==='POST'&&(!origin||(origin!==expected&&origin!=='http://127.0.0.1:8767'))){res.writeHead(403).end('Same-origin required.');req.resume();return;}
    // No request bodies or arbitrary headers: only the anonymous viewer cookie is forwarded.
    if(Number(req.headers['content-length']??0)>0||req.headers['transfer-encoding']){res.writeHead(413).end();req.resume();return;}
    const cookie=(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>/^marketlab_viewer=[a-f0-9]{48}$/.test(x));
    const headers={'x-forwarded-proto':'https',...(cookie?{cookie}:{}),...(req.method==='POST'?{origin:backend}:{})};
    active++;let finished=false;const done=()=>{if(!finished){finished=true;active--;}};
    const upstream=http.request(backend+path,{method:head?'GET':req.method,headers},response=>{
      const safe={};for(const key of ['content-type','content-security-policy','set-cookie','retry-after'])if(response.headers[key])safe[key]=response.headers[key];
      // Only anonymous allowlisted responses can be embedded in an in-app browser.
      // Private pages never pass this gateway and retain their anti-framing policy.
      if(safe['content-security-policy'])safe['content-security-policy']=safe['content-security-policy'].replace(/(?:^|;)\s*frame-ancestors\s+[^;]+/g,'');
      res.writeHead(response.statusCode,safe);if(head){response.resume();res.end();}else response.pipe(res);
    });
    res.on('close',()=>{done();upstream.destroy();});res.on('finish',done);
    upstream.setTimeout(10000,()=>upstream.destroy());upstream.on('error',()=>{done();if(!res.headersSent)res.writeHead(503);res.end('Viewer temporarily unavailable.');});upstream.end();
  });
  server.maxConnections=64;server.maxHeadersCount=24;server.headersTimeout=5000;server.requestTimeout=10000;server.keepAliveTimeout=5000;
  return server;
}
