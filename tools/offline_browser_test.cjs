// Cold-start integration test: actual plugin worker and shipped assets; synthetic notes only.
// A fresh browser profile routes fixture requests to local files and blocks/counts all external requests.
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.LC_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const missingRuntime = process.argv.includes('--missing-runtime');
const missingModel = process.argv.includes('--missing-model');
const forceFallback = process.argv.includes('--force-fallback');
const safariBackend = process.argv.includes('--safari-backend');
const deadline = setTimeout(() => { console.error('Offline browser test timed out'); process.exit(1); }, 90000);
deadline.unref();
const prefix = '.obsidian/plugins/local-connections/';
const testOrigin = 'https://lc-offline.test';
const mime = {'.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.wasm':'application/wasm','.html':'text/html'};
(async () => {
 const browser = await chromium.launch({executablePath:process.env.LC_BROWSER_EXECUTABLE,headless:true});
 try {
 const context = await browser.newContext({serviceWorkers:'block'});
 const external = [], local = [];
 await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== testOrigin) {external.push(request.url()); await route.abort('internetdisconnected');return;}
  let relative = decodeURIComponent(url.pathname).replace(/^\//,'');
  local.push(relative);
  const headers = {'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'};
  if (!relative) {
   let html = fs.readFileSync(path.join(root,'tools/harness/index.html'),'utf8').split('<script src="main.js"></script>')[0];
   html = html.replace(/<link[^>]+>/g, '');
   html += '<script src="/'+prefix+'main.js"></script></body></html>';
   await route.fulfill({status:200,contentType:'text/html',headers,body:html});return;
  }
  if (!relative.startsWith(prefix)) {await route.fulfill({status:404,body:''});return;}
  relative = relative.slice(prefix.length);
  if ((missingRuntime && relative === 'runtime/transformers-4.2.0.js') || (missingModel && relative.startsWith('bundled-models/') && relative.endsWith('/config.json'))) { await route.fulfill({status:404,body:''}); return; }
  const filename = path.resolve(root,'local-connections',relative);
  if (!filename.startsWith(path.join(root,'local-connections')+path.sep)) throw Error('unsafe fixture path');
  try {await route.fulfill({status:200,headers,contentType:mime[path.extname(filename)]||'application/octet-stream',body:request.method()==='HEAD'?'':fs.readFileSync(filename)});}
  catch(error){await route.fulfill({status:404,headers,body:''});}
 });
 const page = await context.newPage();
 page.on('console',message => { if(message.type()==='error'||message.type()==='warning') console.log('browser:',message.text().slice(0,450)); });
 page.on('pageerror',error => console.log('pageerror:',error.message));
 await page.goto(testOrigin);
 const result = await page.evaluate(async ({prefix, gpu, forceFallback, safariBackend}) => {
  const adapter = {
   exists: async path => (await fetch('/'+path,{method:'HEAD'})).ok,
   read: async path => {const r=await fetch('/'+path);if(!r.ok)throw Error('Missing '+path);return r.text();},
   readBinary: async path => {const r=await fetch('/'+path);if(!r.ok)throw Error('Missing '+path);return r.arrayBuffer();},
   getResourcePath: path => location.origin+'/'+path
  };
  const env = {settings:{},plugin:{manifest:{dir:prefix.slice(0,-1)},app:{vault:{configDir:'.obsidian',adapter}}}};
  const model = {env,model_key:TransformersWorkerEmbeddingModelAdapter.defaults.default_model,data:{use_gpu:gpu},settings:{}};
  if (forceFallback || safariBackend) {
   const prepare = lc_prepare_transformers_worker_source;
   lc_prepare_transformers_worker_source = (...args) => {
    let source = prepare(...args);
    if (forceFallback) {
     if (!source.includes('async load_pipeline(device) {')) throw Error('Fallback test injection point missing');
     source = source.replace('async function is_webgpu_available() {', 'async function is_webgpu_available() { return true;').replace('async load_pipeline(device) {', 'async load_pipeline(device) { if (device === \'webgpu\') throw new Error(\'Injected GPU failure\');');
    }
    if (safariBackend) source = 'Object.defineProperty(navigator,"vendor",{value:"Apple Computer, Inc."}); Object.defineProperty(navigator,"userAgent",{value:"Mozilla/5.0 Version/18.0 Safari/605.1.15"});\n' + source;
    return source;
   };
  }
  const embedding = new TransformersWorkerEmbeddingModelAdapter(model);
  const started = performance.now();
  try {
   await embedding.load();
   const rows = await embedding.embed_batch([
    {embed_input:'How can I repair a flat bicycle tyre?',purpose:'query'},
    {embed_input:'Repairing a bicycle puncture requires a patch kit, tyre levers and a pump.',purpose:'document'},
    {embed_input:'The chocolate cake recipe uses flour, cocoa powder and eggs.',purpose:'document'}
   ]);
   const dot = (a,b) => a.reduce((s,v,i)=>s+v*b[i],0);
   return {model:model.model_key,backend:embedding.active_config_key,milliseconds:Math.round(performance.now()-started),dimensions:rows.map(x=>x.vec.length),finite:rows.every(x=>Array.from(x.vec).every(Number.isFinite)),norms:rows.map(x=>dot(Array.from(x.vec),x.vec)),related:dot(Array.from(rows[0].vec),rows[1].vec),unrelated:dot(Array.from(rows[0].vec),rows[2].vec)};
  } catch (error) { return {error:error.message}; } finally {embedding.unload();}
 },{prefix,gpu:process.argv.includes('--gpu') || forceFallback,forceFallback,safariBackend});
 console.log(JSON.stringify({result,externalRequests:external,localRequestCount:local.length},null,2));
 if (external.length) throw Error('Attempted external requests');
 if (missingRuntime || missingModel) {
  if (!result.error) throw Error('Missing asset did not fail locally');
  if (missingRuntime && !/runtime|module|bundled|incomplete/i.test(result.error)) throw Error('Unexpected runtime failure: '+result.error);
  if (missingModel && !/config\.json|model|bundled|incomplete/i.test(result.error)) throw Error('Unexpected model failure: '+result.error);
 } else {
  if(result.error || !result.finite || result.dimensions.some(n=>n!==384) || result.norms.some(n=>Math.abs(n-1)>0.001) || result.related<=result.unrelated) throw Error('Offline acceptance failed');
  if (forceFallback && !result.backend.startsWith('wasm_')) throw Error('CPU fallback did not run');
  if (safariBackend && !local.some(url => url.endsWith('/ort-wasm-simd-threaded.wasm'))) throw Error('Safari backend was not loaded');
 }
 }finally{await browser.close(); clearTimeout(deadline);}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
