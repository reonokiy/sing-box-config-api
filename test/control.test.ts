import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import postgres from 'postgres'
import { before, after, test } from 'node:test'
import { PostgresStore } from '../src/store.ts'
import { createApp } from '../src/app.ts'
import { defaultPolicy, requiredPorts, parsePolicy } from '../src/policy.ts'
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


test('initial protocol selection is atomic and requires only the applicable domain', async()=>{
  for(const protocol of ['anytls','tuic','hysteria2','vless']) {
    const id='only-'+protocol
    const selected={...defaultPolicy(),protocols:[protocol]}
    const domain=protocol==='vless'?{realityServerName:spec.realityServerName}:{tlsServerName:spec.tlsServerName}
    assert.equal((await call('/v1/machines/'+id,'PUT',{server:spec.server,...domain,policy:selected})).status,200)
    const detail=await store.machine(id)
    assert.equal(detail.version,1);assert.deepEqual(detail.policy.protocols,[protocol])
    const config=JSON.parse((await store.getConfig('server',id,'linux'))!.toString())
    assert.deepEqual(config.inbounds.map((i:any)=>i.type),[protocol])
    assert.equal(Boolean(config.certificate_providers),protocol!=='vless')
    const client=JSON.parse((await store.getConfig('client',id,'linux'))!.toString())
    assert.deepEqual(client.outbounds.filter((o:any)=>o.type!=='direct'&&o.type!=='selector').map((o:any)=>o.type),[protocol])
    assert.equal((await call('/v1/machines/'+id,'PUT',{...spec,policy:defaultPolicy()})).status,409)
    assert.equal((await store.machine(id)).version,1)
    assert.equal((await call('/v1/machines/'+id+'/draft','PUT',{baseVersion:1,spec:{server:spec.server,...domain},policy:selected})).status,200)
    assert.equal((await call('/v1/machines/'+id+'/draft','PUT',{baseVersion:1,spec:{server:spec.server,...domain},policy:defaultPolicy()})).status,400)
    assert.equal((await call('/v1/machines/missing-'+protocol,'PUT',{server:spec.server,policy:selected})).status,400)
  }
})


test('machine-first registration enrolls without a proxy; later publication enables listeners', async()=>{
  assert.equal((await call('/v1/machines/empty-machine/register','POST',{})).status,200)
  const detail=await store.machine('empty-machine')
  assert.deepEqual(detail.requiredPorts,[]);assert.equal(detail.version,1);assert.equal(detail.spec.server,'');assert.equal(detail.policy.enabled,false);assert.deepEqual(detail.policy.protocols,[])
  const {token}=await enroll('empty-machine')
  const desired=await (await call('/v1/agent/empty-machine/config','GET',undefined,token)).json() as any
  assert.equal(desired.enabled,false);assert.deepEqual(desired.config.inbounds,[]);assert.equal(desired.config.certificate_providers,undefined)
  assert.equal((await call('/v1/agent/empty-machine/status','POST',{version:1,runningVersion:0,status:'stopped'},token)).status,200)
  assert.equal((await call('/v1/machines/empty-machine/register','POST',{})).status,409)
  assert.equal((await store.machine('empty-machine')).version,1)
  for(const body of [{policy:defaultPolicy()},{server:'bad/address'},[],null])assert.equal((await call('/v1/machines/invalid-registration/register','POST',body)).status,400)
  assert.equal((await call('/v1/machines/empty-machine/register','POST',{},token)).status,403)
  assert.equal((await app.request('/v1/machines/empty-machine/register',{method:'POST',headers:{Origin:'https://untrusted.example.com','Content-Type':'application/json'},body:'{}'})).status,403)
  const policy={...defaultPolicy(),protocols:['vless'],ports:{...defaultPolicy().ports,vless:9443}}
  assert.equal((await call('/v1/machines/empty-machine/draft','PUT',{baseVersion:1,spec:{},policy})).status,400)
  assert.equal((await call('/v1/machines/empty-machine/draft','PUT',{baseVersion:1,spec:{server:'192.0.2.1',realityServerName:'www.example.org'},policy})).status,200)
  assert.equal((await store.desired('empty-machine')).enabled,false)
  assert.equal((await call('/v1/machines/empty-machine/publish','POST',{baseVersion:1})).status,200)
  const active=await store.desired('empty-machine')
  assert.equal(active.enabled,true);assert.equal(active.config.inbounds[0].listen_port,9443)
  assert.equal((await call('/v1/machines/empty-machine/rollback','POST',{baseVersion:2,version:1})).status,200)
  assert.equal((await store.desired('empty-machine')).enabled,false)
})
test('credential rotation is user-scoped, atomic, survives rollback and preserves node and Reality identity',async()=>{
  await register('rotation')
  const policy={...defaultPolicy(),users:['default','alice','bob']}
  await store.stage('rotation',spec,policy,1);await store.publish('rotation',1)
  const {token}=await enroll('rotation')
  const config=async(user:string)=>JSON.parse((await store.getConfig('client','rotation','linux',user))!.toString())
  const beforeAlice=await config('alice'),beforeBob=await config('bob'),beforeDefault=await config('default')
  assert.equal((await call('/v1/machines/rotation/users/alice/rotate','POST',{baseVersion:2},token)).status,403)
  assert.equal((await call('/v1/machines/rotation/users/unknown/rotate','POST',{baseVersion:2})).status,404)
  assert.equal((await call('/v1/machines/rotation/users/alice/rotate','POST',{baseVersion:2,unknown:true})).status,400)
  const results=await Promise.all([call('/v1/machines/rotation/users/alice/rotate','POST',{baseVersion:2}),call('/v1/machines/rotation/users/alice/rotate','POST',{baseVersion:2})])
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409])
  const afterAlice=await config('alice')
  for(const profile of [beforeAlice,beforeBob,afterAlice])assert.ok(JSON.stringify(profile.outbounds.find((o:any)=>o.type==='vless').tls.reality)===JSON.stringify(beforeDefault.outbounds.find((o:any)=>o.type==='vless').tls.reality))
  assert.ok(JSON.stringify(beforeBob)===JSON.stringify(await config('bob')))
  assert.ok(JSON.stringify(beforeDefault)===JSON.stringify(await config('default')))
  for(const type of ['anytls','vless','tuic','hysteria2']){
    const old=beforeAlice.outbounds.find((o:any)=>o.type===type),fresh=afterAlice.outbounds.find((o:any)=>o.type===type)
    assert.ok(JSON.stringify(old)!==JSON.stringify(fresh))
    const server=JSON.parse((await store.getConfig('server','rotation','linux'))!.toString()).inbounds.find((i:any)=>i.type===type).users.find((u:any)=>u.name==='alice')
    assert.ok(server.password===fresh.password && server.uuid===fresh.uuid)
  }
  assert.equal(await store.publish('rotation',3,2),200)
  assert.ok(JSON.stringify(afterAlice)===JSON.stringify(await config('alice')))
  assert.equal((await call('/v1/machines/rotation/users/default/rotate','POST',{baseVersion:4})).status,200)
  const afterDefault=await config('default')
  assert.ok(JSON.stringify(beforeDefault.outbounds.find((o:any)=>o.type==='vless').tls)===JSON.stringify(afterDefault.outbounds.find((o:any)=>o.type==='vless').tls))
  assert.ok(JSON.stringify(beforeDefault)!==JSON.stringify(afterDefault))
  assert.ok(JSON.stringify(afterAlice)===JSON.stringify(await config('alice')))
  assert.equal((await call('/v1/agent/rotation/config','GET',undefined,token)).status,200)
  const metadata=JSON.stringify(await store.machine('rotation'))
  assert.equal(/Password|private_key|vlessUUID|realityPrivateKey/.test(metadata),false)
})
test('required ports distinguish TCP, UDP and ACME and reject enabled empty or conflicting listeners',()=>{
  assert.deepEqual(requiredPorts(parsePolicy({enabled:false,protocols:[]})),[])
  assert.deepEqual(requiredPorts(parsePolicy({protocols:['vless']})),[{transport:'TCP',port:8443}])
  assert.deepEqual(requiredPorts(parsePolicy({protocols:['anytls','tuic','hysteria2']})),[{transport:'TCP',port:80},{transport:'TCP',port:443},{transport:'UDP',port:443},{transport:'UDP',port:8443}])
  assert.throws(()=>parsePolicy({enabled:true,protocols:[]}),TypeError)
  assert.throws(()=>parsePolicy({protocols:['anytls'],ports:{...defaultPolicy().ports,anytls:80}}),TypeError)
})
