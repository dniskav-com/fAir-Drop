const { test }=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto')
const { Writable }=require('node:stream')
const { AgentStore }=require('./agent-store')
const { readSnapshot,listen }=require('./agent-listener')
const { until,broker,rawPeer }=require('./agent-test-helpers')
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'fairdrop-listen-')),projectDir=path.join(root,'project');const owner=new AgentStore({root,projectDir}),store=owner.create({alias:'a',secret:'PRIVATE_SECRET',expires_at:Date.now()+60000});t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,projectDir,store,options:{root,projectDir,sessionId:store.meta.session_id}}}
function add(store,text){return store.put('inbox',{message_id:crypto.randomUUID(),sequence:Math.max(0,...store.inbox.map(m=>m.sequence))+1,body:{text},attachments:[],read:false,from:{alias:'remote',endpoint_id:crypto.randomUUID()},kind:'message',received_at:new Date().toISOString()})}
test('listener emits ordered metadata only, replays from cursor and leaves inbox unread',async t=>{
 const {store,options}=fixture(t);add(store,'SECRET BODY');add(store,'another');const events=[]
 const output=new Writable({write(chunk,encoding,cb){events.push(JSON.parse(chunk));cb()}})
 const controller=new AbortController(),running=listen({...options,since:1},{output,signal:controller.signal,intervalMs:20})
 await until(()=>events.some(e=>e.sequence===2));add(store,'third');await until(()=>events.some(e=>e.sequence===3))
 controller.abort();await running
 assert.deepEqual(events.filter(e=>e.type==='message').map(e=>e.sequence),[2,3])
 assert.ok(!JSON.stringify(events).includes('SECRET'));assert.ok(!JSON.stringify(events).includes('third'))
 assert.equal(store.owner.load(store.meta.session_id).inbox.filter(m=>!m.read).length,3)
 const replay=readSnapshot(options).events.filter(e=>e.sequence>2);assert.equal(replay.length,1)
})
test('listener cannot cross projects or follow symlink records; ignores incomplete temp files',t=>{
 const {store,options}=fixture(t);add(store,'one');fs.writeFileSync(path.join(store.directory,'inbox','partial.tmp'),'{')
 assert.equal(readSnapshot(options).events.length,1)
 assert.throws(()=>readSnapshot({...options,projectDir:'/another-project'}),/ENOENT/)
 const name=crypto.randomUUID()+'.json';fs.symlinkSync(path.join(store.directory,'session.json'),path.join(store.directory,'inbox',name))
 assert.throws(()=>readSnapshot(options),/Invalid local session record/)
})
test('listener emits backlog before closing, with distinct closed/expired exit codes',async t=>{
 const {store,options}=fixture(t);add(store,'one');store.saveMeta({closed:true})
 let data='';const output=new Writable({write(chunk,e,cb){data+=chunk;cb()}})
 assert.equal(await listen(options,{output}),2);assert.deepEqual(data.trim().split('\n').map(s=>JSON.parse(s).type),['message','closed'])
 store.saveMeta({expires_at:Date.now()-1});assert.equal(await listen(options,{output}),3)
})
test('Claude channel opt-in sends an arrival notice without body, secrets or implicit ack',async t=>{
 const hub=await broker(),root=fs.mkdtempSync(path.join(os.tmpdir(),'fairdrop-channel-'));let a,b
 t.after(async()=>{if(a)await a.close();if(b)await b.close();await hub.close();fs.rmSync(root,{recursive:true,force:true})})
 const env={FAIRDROP_URL:hub.url,FAIRDROP_AGENT_DIR:root,FAIRDROP_AGENT_RELAY_ONLY:'1'}
 a=await rawPeer({...env,FAIRDROP_PROJECT_DIR:path.join(root,'a')});b=await rawPeer({...env,FAIRDROP_PROJECT_DIR:path.join(root,'b'),FAIRDROP_CLAUDE_CHANNEL:'1'})
 assert.deepEqual(b.initialized.capabilities.experimental['claude/channel'],{})
 assert.equal(a.initialized.capabilities.experimental?.['claude/channel'],undefined)
 const created=await a.call('fairdrop_agent_create',{alias:'a'}),joined=await b.call('fairdrop_agent_join',{alias:'b',code:created.pairing_code})
 await until(async()=> (await a.call('fairdrop_agent_status',{session_id:created.session_id})).state==='connected')
 await a.call('fairdrop_agent_send',{session_id:created.session_id,text:'DO NOT LEAK THIS BODY'})
 await until(()=>b.notifications.some(n=>n.method==='notifications/claude/channel'))
 const notice=b.notifications.find(n=>n.method==='notifications/claude/channel')
 assert.equal(notice.params.meta.session_id,joined.session_id);assert.ok(!JSON.stringify(notice).includes('LEAK'))
 const inbox=await b.call('fairdrop_agent_inbox',{session_id:joined.session_id});assert.equal(inbox.messages[0].read,false)
})
