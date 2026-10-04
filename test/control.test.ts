import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import postgres from 'postgres'
import { before, after, test } from 'node:test'
import { PostgresStore } from '../src/store.ts'
import { createApp } from '../src/app.ts'
import { defaultPolicy } from '../src/policy.ts'
let store: PostgresStore, app: ReturnType<typeof createApp>, sql: ReturnType<typeof postgres>, control: ReturnType<typeof postgres>, database: string
const spec = {server:'edge.example.com',tlsServerName:'edge.example.com',realityServerName:'www.example.org'}
before(async()=>{
  control=postgres(process.env.TEST_DATABASE_URL!)
  database='control_test_'+randomUUID().replaceAll('-','')
  await control.unsafe('CREATE DATABASE '+database)
  const url=new URL(process.env.TEST_DATABASE_URL!);url.pathname='/'+database
  sql=postgres(url.toString());store=new PostgresStore(url.toString());await store.initialize();app=createApp({store})
})
after(async()=>{await store?.close();await sql?.end();if(control){await control.unsafe('DROP DATABASE IF EXISTS '+database);await control.end()}})
async function call(path:string,method='GET',body?:unknown,token?:string){return app.request(path,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)})}
async function register(id:string){assert.equal((await call('/v1/machines/'+id,'PUT',spec)).status,200)}
async function enroll(id:string){const response=await call('/v1/machines/'+id+'/enrollment','POST',{});assert.equal(response.status,200);const {code}=await response.json() as any;const joined=await call('/v1/agent/'+id+'/enroll','POST',{code});assert.equal(joined.status,200);return {code,token:(await joined.json() as any).token}}
test('drafts do not apply until publication; versions, ports, users and paired credentials persist',async()=>{
  await register('versions');const old=await store.getConfig('server','versions','linux')
  const policy={...defaultPolicy(),protocols:['anytls','tuic'],ports:{anytls:9443,vless:8443,tuic:9443,hysteria2:8443},users:['default','alice'],logLevel:'warn'}
  assert.equal((await call('/v1/machines/versions/draft','PUT',{baseVersion:1,spec,policy})).status,200)
  assert.equal((await store.getConfig('server','versions','linux'))?.toString(),old?.toString())
  assert.equal((await call('/v1/machines/versions/publish','POST',{baseVersion:1})).status,200)
  const active=JSON.parse((await store.getConfig('server','versions','linux'))!.toString())
  assert.equal(active.inbounds.length,2);assert.equal(active.inbounds[0].listen_port,9443);assert.equal(active.inbounds[0].users.length,2)
  const client=JSON.parse((await store.getConfig('client','versions','macos','alice'))!.toString())
  assert.equal(client.outbounds.find((o:any)=>o.type==='anytls').password,active.inbounds[0].users[1].password)
  assert.equal(client.outbounds.find((o:any)=>o.type==='anytls').server_port,9443)
  assert.equal(client.outbounds.some((o:any)=>o.type==='vless'),false)
  assert.deepEqual(client.outbounds.find((o:any)=>o.tag==='AI').outbounds,['Proxy','AnyTLS','TUIC','DIRECT'])
  assert.equal((await call('/v1/config/client/versions/linux?user=alice')).status,200)
  assert.equal((await call('/v1/config/client/versions/linux?user=unknown')).status,404)
  assert.equal((await call('/v1/machines/versions/rollback','POST',{baseVersion:2,version:1})).status,200)
  assert.equal((await store.getConfig('server','versions','linux'))?.toString(),old?.toString())
  const detail=await (await call('/v1/machines/versions')).json() as any
  assert.equal(detail.version,3);assert.equal(detail.versions.length,3);assert.equal(detail.draft,null)
  assert.equal((await call('/v1/machines/versions/versions/2')).status,200)
  assert.equal(JSON.stringify(detail).includes('Password'),false)
  assert.equal((await store.desired('versions')).version,3)
  // Identical registrations preserve credentials and version.
  await register('versions');assert.equal((await store.machine('versions')).version,3)
})
test('optimistic versions prevent concurrent publishers and stale drafts overwriting changes',async()=>{
  await register('concurrent');await store.stage('concurrent',spec,defaultPolicy(),1)
  const result=await Promise.all([store.publish('concurrent',1),store.publish('concurrent',1)])
  assert.deepEqual(result.sort(),[200,409]);assert.equal(await store.stage('concurrent',spec,defaultPolicy(),1),409)
  const desired=await Promise.all(Array.from({length:12},()=>store.desired('concurrent')))
  assert.ok(desired.every(d=>d.version===2))
  await store.stage('concurrent',spec,defaultPolicy(),2)
  await store.saveMachine('concurrent',{...spec,server:'changed.example.com'})
  assert.equal(await store.publish('concurrent',3),404)
})
test('node enrollment is single-use, expires, is scoped, rotates and revokes immediately',async()=>{
  await register('node-a');await register('node-b')
  const {code,token}=await enroll('node-a')
  assert.equal((await call('/v1/agent/node-a/enroll','POST',{code})).status,401)
  assert.equal((await call('/v1/agent/node-a/config','GET',undefined,token)).status,200)
  assert.equal((await call('/v1/agent/node-b/config','GET',undefined,token)).status,401)
  assert.equal((await call('/v1/agent/node-a/config')).status,401)
  assert.equal((await call('/v1/machines','GET',undefined,token)).status,403)
  assert.equal((await call('/v1/config/server/node-b/linux','GET',undefined,token)).status,403)
  assert.equal((await call('/v1/clients/macos','PUT',{platform:'macos'},token)).status,403)
  const response=await call('/v1/agent/node-a/config','GET',undefined,token)
  assert.equal((await app.request('/v1/agent/node-a/config',{headers:{Authorization:'Bearer '+token,'If-None-Match':response.headers.get('etag')!}})).status,304)
  assert.equal((await call('/v1/agent/node-a/status','POST',{version:1,runningVersion:1,status:'applied'},token)).status,200)
  assert.equal((await call('/v1/agent/node-a/status','POST',{version:99,runningVersion:1,status:'applied'},token)).status,400)
  assert.equal((await call('/v1/agent/node-a/status','POST',{version:1,runningVersion:99,status:'applied'},token)).status,400)
  assert.equal((await call('/v1/agent/node-a/status','POST',{version:1,runningVersion:1,status:'applied',error:'untrusted raw logs'},token)).status,400)
  assert.equal((await store.machine('node-a')).reportedVersion,1)
  const rotated=await enroll('node-a')
  assert.equal((await call('/v1/agent/node-a/config','GET',undefined,token)).status,401)
  assert.equal((await call('/v1/agent/node-a/config?api_key=ignored','GET',undefined,rotated.token)).status,401)
  assert.equal((await call('/v1/machines/node-a/revoke','POST',{})).status,200)
  assert.equal((await call('/v1/agent/node-a/config','GET',undefined,rotated.token)).status,401)
  const expiry=await call('/v1/machines/node-a/enrollment','POST',{});const {code:expired}=await expiry.json() as any
  await sql`UPDATE machine_enrollments SET expires_at=now()-interval '1 second' WHERE machine_id='node-a'`
  assert.equal((await call('/v1/agent/node-a/enroll','POST',{code:expired})).status,401)
  assert.equal((await call('/v1/agent/node-a/enroll','POST',{code:'invalid'})).status,401)
  // Only hashes are persisted for node authentication.
  const hashes=await sql`SELECT agent_token_hash FROM machines WHERE id='node-a'`
  assert.equal(hashes[0].agent_token_hash,null)
  const directory=JSON.stringify(await store.listMachines());assert.equal(directory.includes(token),false)
  assert.equal(directory.includes(code),false)
})
test('validates policies, bounded JSON, CSRF and disabled node/client configurations',async()=>{
  await register('validation')
  const draft=(policy:unknown)=>call('/v1/machines/validation/draft','PUT',{baseVersion:1,spec,policy})
  for(const p of [{protocols:[]},{ports:{anytls:0}},{users:['alice']},{protocols:['anytls','vless'],ports:{anytls:443,vless:443,tuic:443,hysteria2:8443}},{unknown:true},{dns:[]},{route:{private_key:'forbidden'}}])assert.equal((await draft(p)).status,400)
  assert.equal((await app.request('/v1/machines/validation/draft',{method:'PUT',headers:{'Content-Type':'application/json'},body:'{'})).status,400)
  assert.equal((await call('/v1/machines/validation/draft','PUT',{padding:'x'.repeat(66000)})).status,413)
  assert.equal((await app.request('/v1/machines/validation/revoke',{method:'POST',headers:{Origin:'https://untrusted.example.com','Content-Type':'application/json'},body:'{}'})).status,403)
  assert.equal((await app.request('/v1/machines/validation/revoke',{method:'POST'})).status,415)
  assert.equal((await draft({...defaultPolicy(),enabled:false})).status,200)
  assert.equal(await store.publish('validation',1),200)
  const desired=await store.desired('validation');assert.equal(desired.enabled,false);assert.deepEqual(desired.config.inbounds,[])
  const client=JSON.parse((await store.getConfig('client','validation','linux'))!.toString())
  assert.deepEqual(client.outbounds.map((o:any)=>o.tag),['DIRECT','Proxy'])
  assert.equal((await call('/manage/')).status,200);assert.ok((await call('/manage/app.js')).headers.get('Content-Security-Policy'))
  assert.equal((await call('/v1/agent/bootstrap.py')).status,200)
})

test('public Compose template contains no machine configuration or credentials', async()=>{
  const response=await call('/v1/agent/not-registered/compose.yaml')
  assert.equal(response.status,200)
  assert.match(response.headers.get('Content-Type')!,/application\/yaml/)
  const yaml=await response.text()
  assert.ok(yaml.includes('MACHINE_ID: not-registered'))
  assert.ok(yaml.includes('/var/run/docker.sock:/var/run/docker.sock'))
  assert.ok(yaml.includes('io.nokiy.managed-proxy.id: not-registered'))
  assert.equal(/api_key|sba_|token|password|private_key/.test(yaml),false)
  assert.equal((await call('/v1/agent/bad_ID/compose.yaml')).status,404)
})
