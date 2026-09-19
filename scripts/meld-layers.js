// Diagnostic: list Meld Studio browser layers (loopback API, ws://127.0.0.1:13376). Optional: node meld-layers.js --fix 7799 7788
'use strict';
const args = process.argv.slice(2);
const fix = args[0] === '--fix' ? { from: args[1], to: args[2] } : null;
const ws = new WebSocket('ws://127.0.0.1:13376');
let id = 1;
const pend = new Map();
const send = m =>
  new Promise(r => {
    const i = id++;
    pend.set(i, r);
    ws.send(JSON.stringify({ ...m, id: i }));
  });
const t = setTimeout(() => {
  console.log('meld: timeout');
  process.exit(0);
}, 6000);
ws.onerror = () => {
  console.log('meld: not reachable');
  process.exit(0);
};
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m.data);
    pend.delete(m.id);
  }
};
ws.onopen = async () => {
  const objs = await send({ type: 3 });
  const meld = objs && objs.meld;
  const methods = Object.fromEntries((meld.methods || []).map(([n, i]) => [n, i]));
  const props = {};
  for (const pr of meld.properties || []) props[pr[1]] = pr[3];
  const all = (props.session && props.session.items) || {};
  for (const [lid, l] of Object.entries(all)) {
    if (l.type !== 'layer' || !/^http:\/\/(localhost|127\.0\.0\.1):\d+\/overlay/.test(l.url || '')) continue;
    console.log('layer', lid, '|', l.name, '|', l.url);
    if (fix && (l.url || '').includes('localhost:' + fix.from + '/overlay')) {
      await send({
        type: 6,
        object: 'meld',
        method: methods.setProperty,
        args: [lid, 'url', `http://localhost:${fix.to}/overlay`]
      });
      console.log('  -> rewritten to http://localhost:' + fix.to + '/overlay');
    }
  }
  clearTimeout(t);
  ws.close();
  process.exit(0);
};
