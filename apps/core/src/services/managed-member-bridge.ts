/** stdin avoids shell quoting for multiline knowledge and messages. */
export const managedCommandInputSource = String.raw`async function commandArguments() {
  let raw = process.argv[3];
  if (raw === '--stdin') {
    raw = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      raw += chunk.toString('utf8');
      if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error('Tool arguments are too large.');
    }
  } else if (raw?.startsWith('@')) {
    const file = raw.slice(1);
    const fileSystem = require('node:fs');
    if (fileSystem.statSync(file).size > 2 * 1024 * 1024) throw new Error('Tool arguments are too large.');
    raw = fileSystem.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  }
  return JSON.parse(raw || '{}');
}
`;

/** Standalone source: works with bundled Node and needs no npm installation in a user's project. */
export const managedMemberBridgeSource =
  String.raw`const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const connectionPath = path.join(__dirname, 'connection.json');
const connection = () => JSON.parse(fs.readFileSync(connectionPath, 'utf8'));
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
` +
  managedCommandInputSource +
  String.raw`
async function call(name, args) {
  const binding = connection();
  if (!binding.tools.some((tool) => tool.name === name)) throw new Error('Tool is not enabled for this member.');
  const response = await fetch(binding.baseUrl + '/api/mcp/call', {
    method: 'POST', signal: AbortSignal.timeout(60000),
    headers: {'content-type':'application/json', authorization:'Bearer ' + binding.token},
    body: JSON.stringify({sessionId:binding.sessionId, agentId:binding.agentId, toolName:name, arguments:args})
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || 'Collaboration service rejected the request.');
  return body;
}
if (!process.argv.includes('--mcp')) {
  commandArguments().then((args) => call(process.argv[2], args)).then((body) => {
    send(body); if (body.data?.success === false) process.exitCode = 1;
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
} else {
  const input = readline.createInterface({input:process.stdin, terminal:false});
  input.on('line', async (line) => {
    let request;
    try { request = JSON.parse(line); } catch { return send({jsonrpc:'2.0', id:null, error:{code:-32700,message:'Invalid JSON'}}); }
    if (request.id === undefined) return;
    const reply = (result) => send({jsonrpc:'2.0',id:request.id,result});
    try {
      const binding = connection();
      if (request.method === 'initialize') return reply({protocolVersion:request.params?.protocolVersion || '2024-11-05',capabilities:{tools:{},prompts:{},resources:{}},serverInfo:{name:'loopmarshal-managed-member',version:'1.0.0'}});
      if (request.method === 'ping') return reply({});
      if (request.method === 'tools/list') return reply({tools:binding.tools});
      if (request.method === 'tools/call') {
        try {
          const body = await call(request.params?.name, request.params?.arguments || {});
          return reply({content:[{type:'text',text:JSON.stringify(body.data)}],isError:body.data?.success === false});
        } catch (error) { return reply({content:[{type:'text',text:error.message}],isError:true}); }
      }
      const skill = () => fs.readFileSync(path.join(__dirname,'skills','loopmarshal-role','SKILL.md'),'utf8');
      if (request.method === 'prompts/list') return reply({prompts:[{name:'loopmarshal-role',description:'Automatically managed role and collaboration rules'}]});
      if (request.method === 'prompts/get' && request.params?.name === 'loopmarshal-role') return reply({messages:[{role:'user',content:{type:'text',text:skill()}}]});
      if (request.method === 'resources/list') return reply({resources:[{uri:'loopmarshal://member/skill',name:'Member collaboration Skill',mimeType:'text/markdown'}]});
      if (request.method === 'resources/read' && request.params?.uri === 'loopmarshal://member/skill') return reply({contents:[{uri:'loopmarshal://member/skill',mimeType:'text/markdown',text:skill()}]});
      send({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Unknown method'}});
    } catch { send({jsonrpc:'2.0',id:request.id,error:{code:-32603,message:'Managed member configuration is unavailable. Refresh it in LoopMarshal.'}}); }
  });
}
`;
